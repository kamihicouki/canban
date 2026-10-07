// Requests → headless turns. A prompt is delivered to an existing session by running
// the agent's own CLI for one turn (`codex exec resume` / `claude -p --resume`),
// with the session's own permissions and the prompt on stdin. Results are read back
// from the run log; the session itself is observed through the usual read model.
//
// Safety gates (all must pass before a turn starts): the session is not running or
// waiting and its log has been quiet for QUIET_MS; no other Canban request is active
// on it (checked under the requests lock); "send now" requires that the session has
// not changed since the user looked at it; elevated sessions need an explicit ack.
//
// Cost: an idle tick only reads the requests change counter. With work, sessions are resolved one
// by one from the listing caches (never a full board), and only their log tails are read.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { savedClaudeExecutionSession } from './claude-handoff.mjs';
import { leaderFor } from './leader.mjs';
import { executionContext } from './sqlite-client.mjs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { RequestStore, queueHeads, ACTIVE_STATES, MAX_PROMPT } from './requests.mjs';
import { permissionFor } from './permissions.mjs';
import { headlessArgs } from './agents.mjs';
import { codexRawStatus, claudeRawStatus, settle } from './status.mjs';
import { stat, readTailJsonLines } from './sources/readonly.mjs';
import { findCodexSession } from './sources/codex.mjs';
import { listClaudeSessions } from './sources/claude.mjs';
import { codexAppState, annotateCodexApp } from './sources/codex-app.mjs';
import { pool, hostsWithState } from './board.mjs';
import { perf } from './perf.mjs';
import { homeEnv, configureAccounts } from './accounts.mjs';
import { isolatedClaudeEnvironment } from './claude-auth-env.mjs';
import { promptImages, withSkills, claudeImageInput, remoteImages } from './prompt-input.mjs';

export const QUIET_MS = Number(process.env.CANBAN_DISPATCH_QUIET_MS) || 20e3;
const INSPECT_BYTES = 256 * 1024;
const RESULT_BYTES = 64 * 1024;
const REMOTE_POLL_MS = 20e3;
const START_TIMEOUT_MS = 60e3;
const PRUNE_EVERY_MS = 24 * 3600e3;
const NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// Variables of the agent that started this server; they must not leak into the turn
// (Claude Code otherwise records the turn as coming from its own host app).
const DROP_ENV = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION|CODEX_THREAD_ID|CODEX_SANDBOX.*|CODEX_MANAGED_.*)$/;
export function cleanEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!DROP_ENV.test(k)) out[k] = v;
  out.PATH = [env.PATH, ...extraPath()].filter(Boolean).join(path.delimiter);
  return out;
}

function extraPath() {
  const home = os.homedir();
  return [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.npm-global', 'bin'), path.join(home, 'bin')];
}

export function resolveBin(name) {
  const override = process.env[`CANBAN_${name.toUpperCase()}_BIN`];
  if (override) {
    try { fs.accessSync(override, fs.constants.X_OK); return override; } catch { return null; }
  }
  for (const dir of [...(process.env.PATH || '').split(path.delimiter), ...extraPath()]) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

// Tests and dry-run replace how processes are started.
let spawner = (bin, args, opts) => spawn(bin, args, opts);
export function setSpawner(fn) {
  const prev = spawner;
  spawner = fn;
  return prev;
}

// Dry run: write a successful result without starting anything.
export function dryRunSpawner(log) {
  return (bin, args, opts) => {
    log('dry-run:', bin, ...args);
    const fd = opts.stdio[1];
    const agent = path.basename(bin);
    fs.writeSync(fd, `${JSON.stringify(agent === 'claude' ? { type: 'result', is_error: false, result: '(dry-run)' } : { type: 'item.completed', item: { type: 'agent_message', text: '(dry-run)' } })}\n`);
    if (agent !== 'claude') fs.writeSync(fd, `${JSON.stringify({ type: 'turn.completed' })}\n`);
    const handlers = {};
    const child = { pid: null, stdin: { end() {} }, on: (ev, fn) => ((handlers[ev] = fn), child), unref() {} };
    setImmediate(() => handlers.exit?.(0, null));
    return child;
  };
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// ---- run logs --------------------------------------------------------------
// Codex --json: item.completed{agent_message}, turn.completed / turn.failed, error.
// Claude --output-format json: a single {type:"result", is_error, result}.
export function parseRunLog(agent, text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const objs = [];
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      if (o && typeof o === 'object') objs.push(o);
    } catch {}
  }
  if (agent === 'claude') {
    const r = objs.filter((o) => o.type === 'result').pop();
    if (!r) return { done: false, ok: false, text: '', error: lines.slice(-3).join('\n').slice(0, 500) || null };
    return { done: true, ok: !r.is_error, text: String(r.result ?? '').slice(0, 2000), error: r.is_error ? String(r.result || r.subtype || 'エラー').slice(0, 500) : null };
  }
  let msg = '';
  let error = null;
  let done = false;
  let ok = false;
  for (const o of objs) {
    if (o.type === 'item.completed' && o.item?.type === 'agent_message' && o.item.text) msg = o.item.text;
    else if (o.type === 'turn.completed') (done = true), (ok = true);
    else if (o.type === 'turn.failed') (done = true), (ok = false), (error = o.error?.message || 'ターンが失敗しました');
    else if (o.type === 'error' && o.message && !/^Reconnecting/.test(o.message)) error = o.message;
  }
  if (!done && !objs.length && lines.length) error = lines.slice(-3).join('\n').slice(0, 500);
  return { done, ok, text: msg.slice(0, 2000), error: error && String(error).slice(0, 500) };
}

function readTail(file, bytes = RESULT_BYTES) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(bytes, size));
      fs.readSync(fd, buf, 0, buf.length, size - buf.length);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

// ---- sessions (resolved one at a time) -------------------------------------
const KEY = /^(codex|claude)(?:@([^:]+))?:(.+)$/;

export async function resolveSession(store, cardId, claudeHome) {
  const m = KEY.exec(String(cardId || ''));
  if (!m) throw new Error(String(cardId).startsWith('task:') ? 'タスクカードには送れません。紐付いたセッションに送ってください' : `セッションが見つかりません: ${cardId}`);
  const [, agent, alias, nativeId] = m;
  if (!alias) {
    configureAccounts((await store.load()).settings.accounts); // sessions from the extra config folders too
    const s = agent === 'codex' ? await findCodexSession(nativeId) : (await listClaudeSessions()).sessions.find((x) => x.nativeId === nativeId);
    if (!s) throw new Error(`セッションが見つかりません: ${cardId}`);
    annotateCodexApp([s], await codexAppState());
    return { session: await savedClaudeExecutionSession(s, await store.load(), claudeHome), host: null };
  }
  const host = (await hostsWithState((await store.load()))).find((h) => h.alias === alias);
  if (!host) throw new Error('Codex に登録されていない接続です');
  if (!host.enabled) throw new Error(`${host.label} の読み取りがオフです。「マシン」でオンにしてください`);
  const s = (await pool.sessions([host])).find((x) => x.id === cardId);
  if (!s) throw new Error(`セッションが見つかりません: ${cardId}`);
  annotateCodexApp([s], await codexAppState());
  return { session: await savedClaudeExecutionSession(s, await store.load(), claudeHome), host };
}

// Tail of the session log (status + permissions) and when it was last written.
export async function inspect(session, host) {
  return perf.timed('dispatch.inspect', async () => {
    if (host) {
      const res = await pool.dispatch(host, { mode: 'inspect', path: session.sourcePath });
      return { records: res.records || [], mtimeMs: res.mtimeMs || 0 };
    }
    if (!session.sourcePath) return { records: [], mtimeMs: 0 };
    const st = await stat(session.sourcePath);
    if (!st) return { records: [], mtimeMs: 0 };
    return { records: await readTailJsonLines(session.sourcePath, INSPECT_BYTES), mtimeMs: st.mtimeMs };
  });
}

export function liveStatus(session, insp, now = Date.now()) {
  const raw = session.agent === 'codex' ? codexRawStatus(insp.records) : claudeRawStatus(insp.records, session.desktopStatus);
  return settle(raw, insp.mtimeMs, now);
}

// Checks that do not depend on timing; failures are permanent for this session.
export function staticProblem(session) {
  if (!headlessArgs(session, { sandbox: 'read-only', mode: 'default' })) return 'このエージェントには送れません';
  if (!NATIVE_ID.test(session.nativeId || '')) return 'セッション ID が不正です';
  if (session.subagent) return 'サブエージェントには送れません。親セッションに送ってください';
  if (session.archived) return 'アーカイブ済みのセッションには送れません';
  if (!session.cwd) return '作業フォルダが分からないセッションには送れません';
  if (session.host?.local !== false && !fs.existsSync(session.cwd)) return `作業フォルダがありません: ${session.cwd}`;
  return null;
}

// Checks that may pass later (a queued request waits for them).
export function timingProblem(session, insp, now = Date.now()) {
  // The Codex app has its own follow-up queue per thread; never interleave with it.
  if (session.codexFollowUps) return `Codex アプリにフォローアップが ${session.codexFollowUps} 件待機中です（アプリで送るか消してから）`;
  const st = liveStatus(session, insp, now);
  if (st === 'running') return 'セッションが実行中です';
  if (st === 'waiting') return 'セッションが入力待ちです（アプリかターミナルで答えてください）';
  if (insp.mtimeMs && now - insp.mtimeMs < QUIET_MS) return `セッションが更新された直後です（${Math.round(QUIET_MS / 1000)} 秒待ちます）`;
  return null;
}

// ---- dispatcher --------------------------------------------------------------
const dispatchers = new Map();
export function dispatcherFor(store) {
  if (!dispatchers.has(store.dir)) dispatchers.set(store.dir, new Dispatcher(store));
  return dispatchers.get(store.dir);
}

export function tickDispatch(store) {
  return dispatcherFor(store).tick();
}

export class Dispatcher {
  constructor(store) {
    this.store = store;
    this.owner = crypto.randomUUID();
    this.requests = new RequestStore(store.dir);
    this.children = new Map(); // request id -> child started by this process
    this.idleMtime = null; // requests.json mtime when last seen with nothing to do
    this.lastPoll = new Map(); // request id -> last remote poll
    this.lastPrune = 0;
    this.ticking = null;
  }

  async settings() {
    return (await this.store.load()).settings.dispatch;
  }

  // Validate and record a request; "now" starts it immediately or fails with the reason.
  async submit({ cardId, prompt, imageIds = [], skills = [], when = 'queue', origin = 'ui', expectedUpdatedAt = null, allowElevated = false, claudeHome, now = Date.now() }) {
    const cfg = (await this.settings());
    if (!cfg.enabled) throw new Error('指示の送信は設定でオフになっています');
    if (origin === 'model' && !cfg.allowModel) throw new Error('モデルからの送信は設定でオフになっています');
    const text = String(prompt ?? '').trim();
    const images = promptImages(this.store.dir, imageIds);
    if (!text && !images.length && !skills.length) throw new Error('プロンプトを入力してください');
    if (withSkills(text, skills).length > MAX_PROMPT) throw new Error(`プロンプトは ${MAX_PROMPT} 文字までです`);
    if (origin === 'model') {
      const recent = (await this.requests.list({ cardId })).filter((r) => r.origin === 'model' && now - r.createdAt < 3600e3).length;
      if (recent >= cfg.modelPerHour) throw new Error(`このセッションへのモデルからの送信は 1 時間 ${cfg.modelPerHour} 件までです`);
    }
    const { session, host } = await resolveSession(this.store, cardId, claudeHome);
    const problem = staticProblem(session);
    if (problem) throw new Error(problem);
    const insp = await inspect(session, host);
    const permission = permissionFor(session, insp.records);
    if (permission.elevated) {
      if (origin === 'model' && !cfg.allowModelElevated) throw new Error(`このセッションは制限なし（${permission.label}）で動いているため、モデルからは送れません`);
      if (origin !== 'model' && !allowElevated) throw Object.assign(new Error(`このセッションは制限なし（${permission.label}）で動いています。確認のうえ送信してください`), { code: 'elevated' });
    }
    if (when === 'now') {
      if (expectedUpdatedAt && (session.updatedAt || 0) > expectedUpdatedAt) throw Object.assign(new Error('表示したあとにセッションが更新されています。最新の内容を確認してから送ってください'), { code: 'conflict' });
      const t = timingProblem(session, insp, now);
      if (t) throw Object.assign(new Error(t), { code: 'busy' });
    }
    const req = (await this.requests.create({
      cardId,
      agent: session.agent,
      hostId: host ? host.id : 'local',
      nativeId: session.nativeId,
      claudeHome: session.executionAccount ? session.home : null,
      executionAccount: session.executionAccount || null,
      cwd: session.cwd,
      title: session.title,
      prompt: text,
      images,
      skills,
      when,
      origin,
      allowElevated: !!allowElevated || (origin === 'model' && cfg.allowModelElevated),
      expectedUpdatedAt,
    }));
    if (when === 'now') {
      const res = await this.tryStart(req, { session, host, insp, permission, force: true });
      if (!res.ok) {
        (await this.requests.transition(req.id, ['queued'], { state: 'cancelled', endedAt: Date.now(), error: res.reason }));
        throw Object.assign(new Error(res.reason), { code: 'busy' });
      }
      return res.request;
    }
    this.idleMtime = null;
    this.tick().catch(() => {}); // start right away if the session is free
    return req;
  }

  // Claim (under the lock, with concurrency limits) and start one request.
  async tryStart(req, { session, host, insp, permission, force = false }) {
    const cfg = (await this.settings());
    const hostId = host ? host.id : 'local';
    const claim = await this.requests.claim(req.id, { force, maxLocal:cfg.maxLocal,maxPerHost:cfg.maxPerHost,owner:this.owner,ownerPid:process.pid });
    if (!claim.ok) return claim;
    let preflight = true;
    try {
      const fresh = await resolveSession(this.store,req.cardId,req.claudeHome);
      if (req.executionAccount && fresh.session.executionAccount !== req.executionAccount) throw new Error('キュー追加後に Claude アカウントが変わりました。実行先を選び直してください');
      const checked = await inspect(fresh.session,fresh.host);
      const reason = !checked.mtimeMs ? 'セッションの状態を確認できません' : timingProblem(fresh.session,checked) || ((fresh.session.updatedAt || 0) !== (session.updatedAt || 0) || checked.mtimeMs !== insp.mtimeMs ? '確認中にセッションが更新されました' : null);
      if (reason) {
        await this.requests.transition(req.id,['starting'],{state:'blocked',endedAt:Date.now(),reasonCode:'session_busy',error:reason,needsUserAction:true},{owner:claim.request.ownerUuid,generation:claim.request.leaseGeneration,release:true});
        await this.requests.pause(req.cardId,reason);
        return {ok:false,reason,reasonCode:'session_busy'};
      }
      permission = permissionFor(fresh.session,checked.records);
      if (permission.elevated && !req.allowElevated) throw Object.assign(new Error('権限が変更されました。確認して再送してください'),{code:'pre_spawn'});
      preflight = false;
      const started = host ? await this.startRemote(claim.request, fresh.session, fresh.host, permission) : await this.startLocal(claim.request, fresh.session, permission);
      return { ok: true, request: started };
    } catch (e) {
      await this.finish(claim.request.id,{forceState:preflight || e.code === 'pre_spawn' ? 'blocked' : 'interrupted',error:e.message,confirmedStopped:preflight || e.code === 'pre_spawn'});
      return { ok: false, reason: e.message };
    }
  }

  async startLocal(req, session, permission) {
    const images = promptImages(this.store.dir, (req.images || []).map(i => i.id));
    const h = headlessArgs(session, permission, { images });
    const prompt = withSkills(req.prompt, req.skills);
    const input = session.agent === 'claude' && images.length ? claudeImageInput(prompt, images, this.store.dir) : prompt;
    const bin = resolveBin(h.bin);
    if (!bin) throw Object.assign(new Error(`${h.bin} が見つかりません（PATH か CANBAN_${h.bin.toUpperCase()}_BIN を確認してください）`),{code:'pre_spawn'});
    const logPath = this.requests.logPath(req.id);
    let fd, child;
    try {
      fs.mkdirSync(this.requests.runsDir, { recursive: true });
      fd = fs.openSync(logPath, 'a', 0o600);
      const env = { ...cleanEnv(), ...homeEnv(session) };
      child = spawner(bin, h.args, { cwd: session.cwd, env: session.agent === 'claude' && session.homeDir ? isolatedClaudeEnvironment(env, session.homeDir) : env, stdio: ['pipe', fd, fd], detached: true });
    } catch (error) {
      throw Object.assign(error, {code:'pre_spawn'});
    } finally {
      if (fd != null) fs.closeSync(fd);
    }
    child.on('error',(e) => executionContext.run(null, () => this.finish(req.id,{forceState:child.pid && pidAlive(child.pid) ? 'interrupted' : 'failed',error:e.message,confirmedStopped:!child.pid || !pidAlive(child.pid),owner:req.ownerUuid,generation:req.leaseGeneration})).catch(() => {}));
    child.on('exit', (code, signal) => {
      this.children.delete(req.id);
      executionContext.run(null, () => this.finish(req.id,{exitCode:code,signal,owner:req.ownerUuid,generation:req.leaseGeneration})).catch(() => {});
    });
    child.stdin.on?.('error', () => {});

    child.unref();
    if (child.pid) this.children.set(req.id, child);
    const running = await this.requests.transition(req.id,['starting'],{state:'running',pid:child.pid ?? null,logPath,permission,argv:[h.bin,...h.args]},{owner:req.ownerUuid,generation:req.leaseGeneration});
    if (!running) { try { child.kill?.('SIGTERM'); } catch {} throw new Error('送信の実行権が失われました'); }
    child.stdin.end(input);
    return running;
  }

  async startRemote(req, session, host, permission) {
    const localImages = promptImages(this.store.dir, (req.images || []).map(i => i.id));
    const images = session.agent === 'codex' ? await remoteImages(this.store.dir, localImages, host, pool) : localImages;
    const h = headlessArgs(session, permission, { images });
    const prompt = withSkills(req.prompt, req.skills);
    const input = session.agent === 'claude' && images.length ? claudeImageInput(prompt, images, this.store.dir) : prompt;
    const res = await pool.dispatch(host, { mode: 'start', id: req.id, binName: h.bin, args: h.args, cwd: session.cwd, prompt: input });
    if (!res.ok || !Number.isInteger(res.pid) || res.pid <= 0) throw new Error(res.error || '接続先の起動結果を確認できません');
    return (await this.requests.transition(req.id, ['starting'], { state: 'running', remotePid: res.pid, logPath: res.log, permission, argv:[h.bin,...h.args] },{owner:req.ownerUuid,generation:req.leaseGeneration})) || req;
  }

  // Settle a run from its log. A failed or interrupted run pauses the session's queue.
  async finish(id, { exitCode = null, signal = null, text = null, forceState = null,error = null,confirmedStopped = true,owner = null,generation = null } = {}) {
    const cur = (await this.requests.get(id));
    if (!cur || !ACTIVE_STATES.has(cur.state)) return null;
    const parsed = forceState ? { done: true, ok: false, text: '', error } : parseRunLog(cur.agent, text ?? readTail(this.requests.logPath(id)));
    let state = forceState || (parsed.done && parsed.ok ? 'succeeded' : parsed.done ? 'failed' : 'interrupted');
    if (owner && (cur.ownerUuid !== owner || cur.leaseGeneration !== generation)) return null;
    if (!forceState && state === 'failed' && (cur.stopRequested || signal === 'SIGINT' || signal === 'SIGTERM')) state = 'interrupted';
    const errMsg = state === 'succeeded' ? null : error || parsed.error || (exitCode != null ? `終了コード ${exitCode}` : '結果を確認できませんでした');
    const writerConflict = /active writer|thread.store conflict|already.*(?:running|writer)|session.*(?:in use|locked)/i.test(errMsg || '');
    if (writerConflict) state = 'blocked';
    const done = (await this.requests.transition(id, ['starting', 'running'], { state, endedAt: Date.now(), exitCode, resultText: parsed.text || null, error:errMsg,reasonCode:writerConflict ? 'external_writer' : state === 'interrupted' ? 'execution_unknown' : null,needsUserAction:state !== 'succeeded' },{owner:cur.ownerUuid,generation:cur.leaseGeneration,release:confirmedStopped}));
    if (done && state !== 'succeeded') (await this.requests.pause(done.cardId, state === 'interrupted' ? '停止しました' : `失敗しました: ${errMsg}`));
    return done;
  }

  // Stop a running request (only runs started by Canban, verified by command line).
  async stop(id) {
    const r = (await this.requests.get(id));
    if (!r || !ACTIVE_STATES.has(r.state)) throw new Error('実行中の依頼ではありません');
    (await this.requests.transition(id, null, { stopRequested: true }));
    if (r.hostId !== 'local') {
      const host = (await hostsWithState((await this.store.load()))).find((h) => h.id === r.hostId);
      if (!host) throw new Error('接続が見つかりません');
      await pool.dispatch(host, { mode: 'stop', pid: r.remotePid, needle: r.nativeId });
      return (await this.requests.get(id));
    }
    if (!r.pid) return this.finish(id, { forceState:'interrupted',error:'子プロセスを確認できません',confirmedStopped:false });
    if (!pidAlive(r.pid)) return this.finish(id, { signal: 'SIGINT' });
    const cmd = await new Promise((res) => execFile('ps', ['-o', 'command=', '-p', String(r.pid)], (e, out) => res(e ? '' : out)));
    if (!cmd.includes(r.nativeId)) throw new Error('このプロセスは Canban が起動したものではありません');
    process.kill(-r.pid, 'SIGINT');
    setTimeout(() => {
      if (pidAlive(r.pid)) try { process.kill(-r.pid, 'SIGTERM'); } catch {}
    }, 10e3).unref();
    return (await this.requests.get(id));
  }

  async resume(cardId) {
    // An explicit action can release an uncertain terminal request only after
    // verifying its recorded child has exited. Never clear a lease on timeout.
    for (const r of await this.requests.list({cardId})) {
      if (r.state !== 'interrupted' && r.state !== 'blocked') continue;
      const token = {key:'session:' + JSON.stringify([r.hostId || 'local',r.agent,r.nativeId || r.cardId]),owner:r.ownerUuid,generation:r.leaseGeneration};
      if (!await this.requests.database.call('system','lease',[token.key])) continue;
      let stopped = false;
      if (!r.hostId || r.hostId === 'local') stopped = !!r.pid && !pidAlive(r.pid);
      else if (r.remotePid) {
        const host = (await hostsWithState(await this.store.load())).find(h=>h.id===r.hostId);
        if (host) {
          try {
            const result = await pool.dispatch(host,{mode:'poll',runs:[{id:r.id,pid:r.remotePid}]});
            stopped = result.ok === true && result.runs?.[r.id]?.alive === false;
          } catch {}
        }
      }
      if (!stopped) throw Object.assign(new Error('子プロセスの終了を確認できません。実行状況を確認してから再操作してください。'),{code:'execution_unknown',needsUserAction:true});
      await this.requests.releaseStopped(r.id,token);
    }
    await this.requests.resume(cardId);
    this.idleMtime = null;
    this.tick().catch(() => {});
  }

  // Periodic step (leader) and after changes: settle finished runs, start queue heads.
  tick() {
    if (this.ticking) return this.ticking;
    this.ticking = leaderFor(this.store.dir).run(() => perf.timed('tick.dispatch', () => this.tickOnce())).finally(() => (this.ticking = null));
    return this.ticking;
  }

  async tickOnce(now = Date.now()) {
    const mtime = await this.requests.database.call('system','revision',['requests_change']);
    if (mtime === this.idleMtime && !this.children.size) return { idle: true };
    const { requests, paused } = (await this.requests.load());
    const active = requests.filter((r) => ACTIVE_STATES.has(r.state));
    const heads = queueHeads(requests).filter((r) => !paused[r.cardId] && !active.some((run) => run.cardId === r.cardId));
    if (!active.length && !heads.length) {
      this.idleMtime = mtime;
      if (now - this.lastPrune > PRUNE_EVERY_MS) {
        this.lastPrune = now;
        (await this.requests.pruneLogs(now));
      }
      return { idle: true };
    }
    await this.reconcile(active, now);
    const started = [];
    for (const head of heads) {
      try {
        const { session, host } = await resolveSession(this.store, head.cardId, head.claudeHome);
        const problem = staticProblem(session);
        if (problem) {
          (await this.requests.transition(head.id, ['queued'], { state: 'failed', endedAt: now, error: problem }));
          (await this.requests.pause(head.cardId, problem));
          continue;
        }
        const insp = await inspect(session, host);
        const permission = permissionFor(session, insp.records);
        if (permission.elevated && !head.allowElevated) {
          (await this.requests.pause(head.cardId, `セッションが制限なし（${permission.label}）になったため停止しました。確認して再開してください`));
          continue;
        }
        const wait = timingProblem(session, insp, now);
        if (wait) {
          await this.requests.transition(head.id,['queued'],{state:'blocked',endedAt:now,error:wait,reasonCode:'session_busy',needsUserAction:true});
          await this.requests.pause(head.cardId,wait);
          continue;
        }
        const res = await this.tryStart(head, { session, host, insp, permission });
        if (res.ok) started.push(head.id);
        else if (res.reasonCode !== 'capacity') { await this.requests.transition(head.id,['queued'],{state:'blocked',endedAt:now,error:res.reason,needsUserAction:true}); await this.requests.pause(head.cardId,res.reason); }
        else if (head.blockedReason !== res.reason) (await this.requests.transition(head.id, ['queued'], { blockedReason: res.reason }));
      } catch (e) {
        await this.requests.transition(head.id,['queued'],{state:'blocked',endedAt:now,error:e.message,reasonCode:'inspection_failed',needsUserAction:true});
        await this.requests.pause(head.cardId,e.message);
      }
    }
    return { idle: false, started };
  }

  // Runs whose process ended while nobody was watching (another server, a restart).
  async reconcile(active, now = Date.now()) {
    const remote = new Map();
    for (const r of active) {
      if (this.children.has(r.id)) continue; // our own child: its exit handler settles it
      if (r.state === 'starting' && now - (r.startedAt || 0) > START_TIMEOUT_MS && !r.pid && !r.remotePid) {
        await this.finish(r.id,{forceState:'interrupted',error:'開始状況を確認できません',confirmedStopped:false});
      } else if (r.hostId === 'local') {
        if (r.state === 'running' && !pidAlive(r.pid)) await this.finish(r.id, {});
      } else if (r.state === 'running' && now - (this.lastPoll.get(r.id) || 0) >= REMOTE_POLL_MS) {
        (remote.get(r.hostId) || remote.set(r.hostId, []).get(r.hostId)).push(r);
      }
    }
    if (!remote.size) return;
    const hosts = await hostsWithState((await this.store.load()));
    await Promise.all([...remote].map(async ([hostId, runs]) => {
      const host = hosts.find((h) => h.id === hostId);
      if (!host) {
        for (const r of runs) await this.finish(r.id,{forceState:'interrupted',error:'接続先が見つかりません',confirmedStopped:false});
        return;
      }
      for (const r of runs) this.lastPoll.set(r.id, now);
      try {
        const res = await pool.dispatch(host, { mode: 'poll', runs: runs.map((r) => ({ id: r.id, pid: r.remotePid })) });
        if (!res.ok) throw new Error(res.error || '接続先の実行状況を確認できません');
        for (const r of runs) {
          const st = res.runs?.[r.id];
          if (st?.alive === false && Number.isInteger(r.remotePid) && r.remotePid > 0) {
            await this.finish(r.id, { text:st.log });
            this.lastPoll.delete(r.id);
          } else if (!st || typeof st.alive !== 'boolean' || !r.remotePid) {
            await this.finish(r.id,{forceState:'interrupted',error:'接続先の実行状況を確認できません',confirmedStopped:false});
          }
        }
      } catch {} // unreachable host: try again at the next poll
    }));
  }
}

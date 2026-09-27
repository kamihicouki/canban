// Requests: permissions are inherited (never raised), prompts go through stdin to the
// agent's CLI, the safety gates hold, queues run one at a time, and idle ticks are free.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-dispatch-'));
const codexHome = path.join(root, 'codex');
const claudeHome = path.join(root, 'claude');
const dataDir = path.join(root, 'data');
const ws = path.join(root, 'ws');
const agentLog = path.join(root, 'agent.jsonl');
const HOUR = 3600e3;
const line = (o) => `${JSON.stringify(o)}\n`;

Object.assign(process.env, {
  CANBAN_CODEX_HOME: codexHome,
  CANBAN_CLAUDE_HOME: claudeHome,
  CANBAN_CLAUDE_DESKTOP_DIR: path.join(root, 'desktop'),
  CANBAN_DATA_DIR: dataDir,
  CANBAN_CODEX_BIN: path.join(here, 'fake-codex.sh'),
  CANBAN_CLAUDE_BIN: path.join(here, 'fake-claude.sh'),
  CANBAN_DISPATCH_QUIET_MS: '300',
  FAKE_AGENT_LOG: agentLog,
  // An agent that started Canban: these must not reach the turn.
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
});

const rollout = (name, records, ageMs) => {
  const p = path.join(codexHome, 'sessions', `${name}.jsonl`);
  fs.writeFileSync(p, records.map(line).join(''));
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(p, t, t);
  return p;
};
const turnContext = (sandbox_policy, approval_policy = 'on-request') => ({ type: 'turn_context', payload: { cwd: ws, sandbox_policy, approval_policy } });
const event = (type) => ({ type: 'event_msg', payload: { type } });

let M; // modules, imported after the environment is set
let store;
const now = Date.now();

before(async () => {
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(claudeHome, 'projects', '-ws'), { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  const old = HOUR;
  const paths = {
    ok: rollout('ok', [turnContext({ type: 'workspace-write', network_access: true }), event('task_started'), event('task_complete')], old),
    run: rollout('run', [turnContext({ type: 'read-only' }), event('task_started')], 2000),
    full: rollout('full', [turnContext({ type: 'danger-full-access' }, 'never'), event('task_complete')], old),
    db: rollout('db', [event('task_complete')], old),
    fresh: rollout('fresh', [turnContext({ type: 'read-only' }), event('task_complete')], 0),
  };
  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, updated_at_ms INTEGER,
    source TEXT, cwd TEXT, title TEXT, archived INTEGER, first_user_message TEXT, sandbox_policy TEXT, approval_mode TEXT);
    CREATE INDEX idx_threads_updated_at ON threads(updated_at DESC, id DESC);`);
  const ins = db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const u = Math.floor((now - old) / 1000);
  const managedWrite = JSON.stringify({ type: 'managed', file_system: { type: 'restricted', entries: [{ access: 'read' }, { access: 'write' }] }, network: 'restricted' });
  for (const [id, p] of Object.entries(paths)) ins.run(`th-${id}`, p, u, u, now - old, 'cli', ws, `task ${id}`, 0, `task ${id}`, id === 'db' ? managedWrite : '{"type":"read-only"}', 'on-request');
  ins.run('th-arch', paths.ok, u, u, now - old, 'cli', ws, 'archived', 1, 'archived', '{"type":"read-only"}', 'never');
  db.close();

  const transcript = (id, mode) => {
    const p = path.join(claudeHome, 'projects', '-ws', `${id}.jsonl`);
    fs.writeFileSync(p,
      line({ type: 'user', cwd: ws, permissionMode: mode, timestamp: new Date(now - old).toISOString(), message: { content: `claude ${id}` } }) +
      line({ type: 'assistant', timestamp: new Date(now - old + 1000).toISOString(), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } }));
    const t = (now - old) / 1000;
    fs.utimesSync(p, t, t);
  };
  transcript('cl-ok', 'acceptEdits');
  transcript('cl-bypass', 'bypassPermissions');

  M = {
    ...(await import('../server/dispatch.mjs')),
    ...(await import('../server/permissions.mjs')),
    ...(await import('../server/requests.mjs')),
    ...(await import('../server/agents.mjs')),
    store: await import('../server/store.mjs'),
    perf: (await import('../server/perf.mjs')).perf,
    codex: await import('../server/sources/codex.mjs'),
  };
  store = new M.store.Store(dataDir);
});

after(() => {
  delete process.env.CLAUDECODE;
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
  fs.rmSync(root, { recursive: true, force: true });
});

const runs = () => (fs.existsSync(agentLog) ? fs.readFileSync(agentLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}
const finished = (d, id) => waitFor(() => {
  const r = d.requests.get(id);
  return r && M.FINAL_STATES.has(r.state) ? r : null;
});
function freshDispatcher() {
  fs.rmSync(path.join(dataDir, 'requests.json'), { force: true });
  fs.rmSync(agentLog, { force: true });
  return new M.Dispatcher(store);
}

// ---- permissions -------------------------------------------------------------
test('codex permissions: turn_context first, then the DB (legacy and managed), else read-only', () => {
  const p = M.codexPermission([turnContext({ type: 'workspace-write', network_access: true })]);
  assert.deepEqual([p.sandbox, p.network, p.elevated, p.source], ['workspace-write', true, false, 'session']);
  assert.equal(M.codexPermission([turnContext({ type: 'danger-full-access' })]).elevated, true);
  assert.equal(M.codexPermission([], { sandboxPolicy: '{"type":"workspace-write"}' }).sandbox, 'workspace-write');
  const managed = (entries, type = 'restricted') => JSON.stringify({ type: 'managed', file_system: { type, entries }, network: 'restricted' });
  assert.equal(M.codexPermission([], { sandboxPolicy: managed([{ access: 'read' }]) }).sandbox, 'read-only');
  assert.equal(M.codexPermission([], { sandboxPolicy: managed([{ access: 'read' }, { access: 'write' }]) }).sandbox, 'workspace-write');
  assert.equal(M.codexPermission([], { sandboxPolicy: managed([], 'unrestricted') }).sandbox, 'danger-full-access');
  const fb = M.codexPermission([], {});
  assert.deepEqual([fb.sandbox, fb.source], ['read-only', 'fallback']);
});

test('claude permissions: the latest permissionMode, unknown -> default', () => {
  const rec = (m) => ({ type: 'user', permissionMode: m });
  assert.equal(M.claudePermission([rec('plan'), rec('acceptEdits')]).mode, 'acceptEdits');
  assert.equal(M.claudePermission([rec('bypassPermissions')]).elevated, true);
  assert.equal(M.claudePermission([rec('dontAsk')]).elevated, false);
  const fb = M.claudePermission([rec('weird')]);
  assert.deepEqual([fb.mode, fb.source], ['default', 'fallback']);
});

test('headless argv carries the inherited permissions and never the prompt', () => {
  const c = M.headlessArgs({ agent: 'codex', nativeId: 'abc' }, { sandbox: 'workspace-write', network: false });
  assert.equal(c.bin, 'codex');
  assert.deepEqual(c.args.slice(0, 2), ['exec', 'resume']);
  assert.ok(c.args.includes('sandbox_mode="workspace-write"') && c.args.includes('approval_policy="never"'));
  assert.ok(c.args.includes('sandbox_workspace_write.network_access=false'));
  assert.deepEqual(c.args.slice(-2), ['abc', '-']);
  const k = M.headlessArgs({ agent: 'claude', nativeId: 'u1' }, { mode: 'acceptEdits' });
  assert.deepEqual(k.args, ['-p', '--resume', 'u1', '--output-format', 'json', '--permission-mode', 'acceptEdits']);
});

test('run logs: codex events and claude results (is_error wins over subtype)', () => {
  const codex = [
    { type: 'error', message: 'Reconnecting... 1/5' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'hi' } },
    { type: 'turn.completed' },
  ].map(line).join('');
  assert.deepEqual(M.parseRunLog('codex', codex), { done: true, ok: true, text: 'hi', error: null });
  assert.equal(M.parseRunLog('codex', line({ type: 'turn.failed', error: { message: 'x' } })).error, 'x');
  assert.equal(M.parseRunLog('codex', '{"type":"turn.started"}\n').done, false);
  const bad = M.parseRunLog('claude', line({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate' }));
  assert.deepEqual([bad.done, bad.ok, bad.error], [true, false, 'Failed to authenticate']);
});

// ---- sending -----------------------------------------------------------------
test('send now: prompt on stdin, inherited sandbox, agent env scrubbed, result recorded', async () => {
  const d = freshDispatcher();
  const r = await d.submit({ cardId: 'codex:th-ok', prompt: 'テストを直して\n"quote" $(rm -rf /)', when: 'now' });
  assert.equal(r.state, 'running');
  const done = await finished(d, r.id);
  assert.equal(done.state, 'succeeded');
  assert.match(done.resultText, /^done: テストを直して/);
  const [run] = runs();
  assert.equal(run.prompt, 'テストを直して\n"quote" $(rm -rf /)');
  assert.ok(!run.argv.some((a) => a.includes('テスト')), 'prompt must not be in argv');
  assert.ok(run.argv.includes('sandbox_mode="workspace-write"'));
  assert.ok(run.argv.includes('sandbox_workspace_write.network_access=true'));
  assert.equal(fs.realpathSync(run.cwd), fs.realpathSync(ws));
  assert.equal(run.claudecode, null);
  assert.equal(run.entrypoint, null);
  assert.equal(done.permission.source, 'session');
});

test('gates: running, just-updated, changed-since-viewed, archived and task cards are refused', async () => {
  const d = freshDispatcher();
  await assert.rejects(d.submit({ cardId: 'codex:th-run', prompt: 'x', when: 'now' }), /実行中/);
  const fresh = path.join(codexHome, 'sessions', 'fresh.jsonl');
  fs.utimesSync(fresh, new Date(), new Date());
  await assert.rejects(d.submit({ cardId: 'codex:th-fresh', prompt: 'x', when: 'now' }), /更新された直後/);
  await assert.rejects(d.submit({ cardId: 'codex:th-ok', prompt: 'x', when: 'now', expectedUpdatedAt: now - 2 * HOUR }), (e) => e.code === 'conflict');
  await assert.rejects(d.submit({ cardId: 'codex:th-arch', prompt: 'x', when: 'now' }), /アーカイブ/);
  await assert.rejects(d.submit({ cardId: 'task:abc', prompt: 'x' }), /タスクカード/);
  await assert.rejects(d.submit({ cardId: 'codex:th-ok', prompt: '   ' }), /プロンプト/);
  assert.equal(runs().length, 0);
});

test('elevated sessions need an explicit ack from the UI and are refused for the model', async () => {
  const d = freshDispatcher();
  await assert.rejects(d.submit({ cardId: 'claude:cl-bypass', prompt: 'x', when: 'now' }), (e) => e.code === 'elevated');
  await assert.rejects(d.submit({ cardId: 'codex:th-full', prompt: 'x', when: 'now', origin: 'model' }), /モデルからは送れません/);
  const r = await d.submit({ cardId: 'claude:cl-bypass', prompt: 'go', when: 'now', allowElevated: true });
  const done = await finished(d, r.id);
  assert.equal(done.state, 'succeeded');
  assert.deepEqual(runs()[0].argv.slice(-2), ['--permission-mode', 'bypassPermissions']);
});

test('queue: one at a time per session, FIFO, waits while the session is busy', async () => {
  const d = freshDispatcher();
  process.env.FAKE_AGENT_SLEEP = '1';
  try {
    const a = await d.submit({ cardId: 'claude:cl-ok', prompt: 'first' });
    const b = await d.submit({ cardId: 'claude:cl-ok', prompt: 'second' });
    await waitFor(() => d.requests.get(a.id).state === 'running');
    await d.tick();
    assert.equal(d.requests.get(b.id).state, 'queued', 'second waits for the first');
    await finished(d, a.id);
    await waitFor(async () => (await d.tick(), d.requests.get(b.id).state !== 'queued'));
    await finished(d, b.id);
  } finally {
    delete process.env.FAKE_AGENT_SLEEP;
  }
  assert.deepEqual(runs().map((r) => r.prompt), ['first', 'second']);
  assert.deepEqual(runs()[0].argv.slice(-2), ['--permission-mode', 'acceptEdits']);
});

test('a failed run pauses the queue until resumed', async () => {
  const d = freshDispatcher();
  process.env.FAKE_AGENT_FAIL = '1';
  let a;
  try {
    a = await d.submit({ cardId: 'codex:th-db', prompt: 'will fail', when: 'now' });
    assert.equal((await finished(d, a.id)).state, 'failed');
  } finally {
    delete process.env.FAKE_AGENT_FAIL;
  }
  assert.equal(d.requests.get(a.id).error, 'fake failure');
  assert.match(d.requests.load().paused['codex:th-db'].reason, /失敗/);
  const b = await d.submit({ cardId: 'codex:th-db', prompt: 'next' });
  await d.tick();
  assert.equal(d.requests.get(b.id).state, 'queued');
  d.resume('codex:th-db');
  assert.equal((await finished(d, b.id)).state, 'succeeded');
  // DB fallback (no turn_context in the rollout): managed policy with a write entry.
  assert.ok(runs().at(-1).argv.includes('sandbox_mode="workspace-write"'));
});

test('two dispatchers on one data dir start a queued prompt exactly once', async () => {
  const d1 = freshDispatcher();
  const d2 = new M.Dispatcher(store);
  const r = d1.requests.create({ cardId: 'codex:th-ok', agent: 'codex', hostId: 'local', nativeId: 'th-ok', cwd: ws, prompt: 'once', when: 'queue', origin: 'ui' });
  await Promise.all([d1.tick(), d2.tick(), d1.tick(), d2.tick()]);
  await finished(d1, r.id);
  assert.equal(runs().length, 1);
});

test('the request lock holds across processes (no lost updates)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-lock-'));
  const script = `import { RequestStore } from ${JSON.stringify(path.join(here, '..', 'server', 'requests.mjs'))};
    const rs = new RequestStore(${JSON.stringify(dir)});
    for (let i = 0; i < 40; i++) rs.create({ cardId: 'c' + process.pid, prompt: 'p' });`;
  const runOne = () => new Promise((res, rej) => spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], { stdio: 'inherit' }).on('exit', (c) => (c ? rej(new Error(`exit ${c}`)) : res())));
  await Promise.all([runOne(), runOne(), runOne()]);
  assert.equal(new M.RequestStore(dir).load().requests.length, 120);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('stop interrupts a running turn and pauses the queue', async () => {
  const d = freshDispatcher();
  process.env.FAKE_AGENT_SLEEP = '5';
  try {
    const r = await d.submit({ cardId: 'codex:th-ok', prompt: 'long', when: 'now' });
    await new Promise((res) => setTimeout(res, 200));
    await d.stop(r.id);
    const done = await finished(d, r.id);
    assert.equal(done.state, 'interrupted');
    assert.ok(d.requests.load().paused['codex:th-ok']);
    d.requests.resume('codex:th-ok');
  } finally {
    delete process.env.FAKE_AGENT_SLEEP;
  }
});

test('runs that ended while nobody watched are settled from their log', async () => {
  const d = freshDispatcher();
  const r = d.requests.create({ cardId: 'codex:th-ok', agent: 'codex', hostId: 'local', nativeId: 'th-ok', cwd: ws, prompt: 'x', when: 'queue', origin: 'ui' });
  d.requests.transition(r.id, null, { state: 'running', pid: 999999, startedAt: Date.now() });
  fs.mkdirSync(d.requests.runsDir, { recursive: true });
  fs.writeFileSync(d.requests.logPath(r.id), line({ type: 'item.completed', item: { type: 'agent_message', text: 'finished elsewhere' } }) + line({ type: 'turn.completed' }));
  await d.tick();
  const done = d.requests.get(r.id);
  assert.deepEqual([done.state, done.resultText], ['succeeded', 'finished elsewhere']);
});

test('model requests are rate limited per session', async () => {
  const d = freshDispatcher();
  await store.updateDispatchSettings({ modelPerHour: 1 });
  try {
    const r = await d.submit({ cardId: 'codex:th-ok', prompt: 'one', origin: 'model' });
    await finished(d, r.id).catch(() => {});
    await assert.rejects(d.submit({ cardId: 'codex:th-ok', prompt: 'two', origin: 'model' }), /1 時間 1 件/);
    await store.updateDispatchSettings({ allowModel: false });
    await assert.rejects(d.submit({ cardId: 'codex:th-ok', prompt: 'three', origin: 'model' }), /オフ/);
  } finally {
    await store.updateDispatchSettings({ modelPerHour: 10, allowModel: true });
  }
});

// ---- cost ----------------------------------------------------------------------
test('an idle tick reads no sessions', async () => {
  const d = freshDispatcher();
  d.requests.create({ cardId: 'codex:th-ok', prompt: 'x', state: 'cancelled', endedAt: Date.now() });
  const before = JSON.stringify(M.perf.summary().ops);
  const count = (name) => M.perf.summary().ops[name]?.count || 0;
  const [all, insp] = [count('sessions.all'), count('dispatch.inspect')];
  for (let i = 0; i < 5; i++) assert.equal((await d.tick()).idle, true);
  assert.equal(count('sessions.all'), all);
  assert.equal(count('dispatch.inspect'), insp);
  assert.ok(before);
});

test('codex listing is incremental: unchanged DB is not queried, changes are read as a delta', async () => {
  const c = M.codex.codexListCounters;
  await M.codex.listCodexSessions();
  const base = { ...c };
  await M.codex.listCodexSessions();
  assert.equal(c.full, base.full);
  assert.equal(c.skipped, base.skipped + 1);
  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  const u = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('th-new', '', u, u, Date.now(), 'cli', ws, 'new one', 0, 'new one', '{"type":"read-only"}', 'never');
  db.prepare('UPDATE threads SET archived = 1 WHERE id = ?').run('th-db');
  db.close();
  const { sessions } = await M.codex.listCodexSessions();
  assert.equal(c.full, base.full, 'no full read');
  assert.equal(c.delta, base.delta + 1);
  assert.ok(sessions.some((s) => s.nativeId === 'th-new'));
  assert.equal(sessions.find((s) => s.nativeId === 'th-db').archived, true);
});

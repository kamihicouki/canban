// Integrated Desktop sidebar on the pure layout (docs/claude-desktop-integrated-sidebar-research.md).
// Desktop lists only claude-code-sessions/<signed-in account>/<org>. While Desktop is
// stopped, Canban copies the other accounts' session records into that folder as
// guests (same sessionId and cliSessionId, title marked "🔗 <account> · "). A turn in a
// guest appends to the same transcript in ~/.claude/projects. After the user quits
// Desktop, the guest's progress is written back to the original record and the guest
// is removed, so each account is separate again. Canban never quits Desktop itself
// (Desktop vetoes an outside quit while a session runs); it waits for the user's ⌘Q.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claudeDesktopSessionsDir, defaultClaudeHome } from './accounts.mjs';

// Values that belong to the account the session was created in.
const ACCOUNT_KEYS = ['remoteMcpServersConfig', 'enabledMcpTools', 'chromePermissionMode', 'chromeAllowedDomains', 'chromeTabGroupId', 'bridgeSessionIds', 'remoteControlAutoEligible', 'steeredByRemoteClient'];
// Unfinished work: Desktop would resume it at launch with the signed-in account's
// usage (seen in the 2026-10-14 trial). Such a session stays with its own account.
export const BUSY_KEYS = ['armedWorkAtQuit', 'pendingFirstStart', 'pendingCycle', 'interruptedByQuitAt', 'interruptedAwaitingPerson', 'lastTurnCutShort'];
const ID = /^local_[A-Za-z0-9-]{1,64}$/;
const CLI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function guestPaths({ env = process.env } = {}) {
  const sessions = claudeDesktopSessionsDir();
  const state = env.CANBAN_DESKTOP_GUESTS_DIR || path.join(os.homedir(), '.canban', 'desktop-integrated');
  return {
    sessions,
    app: path.dirname(sessions),
    projects: path.join(defaultClaudeHome(), 'projects'),
    state,
    ledger: path.join(state, 'ledger.json'),
  };
}

const exists = file => fs.lstat(file).then(() => true, () => false);
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const sha = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const writeJsonAtomic = async (file, value) => {
  const tmp = `${file}.canban-${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(tmp, file);
};
const listDirs = async dir => (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).filter(d => d.isDirectory()).map(d => d.name);
// APFS clone: no extra space until either copy changes (falls back to a copy elsewhere).
const clone = (from, to) => { try { execFileSync('/bin/cp', ['-cRp', from, to]); } catch { execFileSync('/bin/cp', ['-Rp', from, to]); } };

// Desktop's main process, from the process list (no lsof needed).
let runningCheck = () => new Promise(resolve => execFile('/bin/ps', ['-axo', 'command='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) =>
  resolve(!error && stdout.split('\n').some(line => /\/Claude\.app\/Contents\/MacOS\/Claude(\s|$)/.test(line)))));
export function setGuestRunningCheck(check) { const previous = runningCheck; runningCheck = check; return previous; }
export const desktopRunning = () => runningCheck();

export async function signedInAccount(paths = guestPaths()) {
  try {
    const id = (await readJson(path.join(paths.app, 'config.json'))).lastKnownAccountUuid;
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
  } catch { return null; }
}

// The signed-in account's org folder: the one with session records (else the only one).
async function hostFolder(paths, account) {
  const base = path.join(paths.sessions, account);
  const orgs = await listDirs(base);
  const used = [];
  for (const org of orgs) if ((await fs.readdir(path.join(base, org))).some(f => ID.test(f.replace(/\.json$/, '')) && f.endsWith('.json'))) used.push(org);
  const pick = used.length === 1 ? used[0] : !used.length && orgs.length === 1 ? orgs[0] : null;
  return pick ? path.join(base, pick) : null;
}

async function transcripts(projects) {
  const byId = new Map();
  for (const project of await listDirs(projects)) {
    for (const f of await fs.readdir(path.join(projects, project)).catch(() => [])) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -6);
      byId.set(id, byId.has(id) ? null : path.join(projects, project, f));
    }
  }
  return byId;
}

export async function readLedger(paths = guestPaths()) {
  return readJson(paths.ledger).catch(() => null);
}

// What an integrated launch would place. Read-only.
export async function planGuests({ paths = guestPaths(), labelOf = a => a.slice(0, 8) } = {}) {
  const host = await signedInAccount(paths);
  if (!host) return { ok: false, reason: 'Desktop のログインを確認できません。Desktop にログインしてから開いてください' };
  const into = await hostFolder(paths, host);
  if (!into) return { ok: false, reason: 'Desktop の会話フォルダを確認できません' };
  const byCli = await transcripts(paths.projects);
  const guests = [], skipped = [];
  for (const account of await listDirs(paths.sessions)) {
    if (account === host) continue;
    for (const org of await listDirs(path.join(paths.sessions, account))) {
      const dir = path.join(paths.sessions, account, org);
      if ((await fs.lstat(dir)).isSymbolicLink()) continue;
      for (const f of await fs.readdir(dir)) {
        const sessionId = f.replace(/\.json$/, '');
        if (!f.endsWith('.json') || !ID.test(sessionId)) continue;
        const originPath = path.join(dir, f);
        let record;
        try { record = await readJson(originPath); } catch { skipped.push({ sessionId, reason: '読めない' }); continue; }
        if (record.sessionId !== sessionId || !CLI.test(record.cliSessionId || '')) { skipped.push({ sessionId, reason: '形式が違う' }); continue; }
        if (record.isArchived) continue;
        const busy = BUSY_KEYS.filter(k => record[k] != null);
        if (busy.length) { skipped.push({ sessionId, title: record.title, account, reason: '作業途中で終了された会話', busy }); continue; }
        const transcript = byCli.get(record.cliSessionId);
        if (!transcript) { skipped.push({ sessionId, title: record.title, account, reason: transcript === null ? '会話記録が複数ある' : '会話記録がない' }); continue; }
        const guestPath = path.join(into, f);
        if (await exists(guestPath)) { skipped.push({ sessionId, title: record.title, account, reason: '同じ ID の記録が既にある' }); continue; }
        guests.push({ sessionId, cliSessionId: record.cliSessionId, title: record.title, account, org, originPath, guestPath, transcript, prefix: `🔗 ${labelOf(account)} · ` });
      }
    }
  }
  return { ok: true, host, into, guests, skipped };
}

// Places the guests. Desktop must be stopped; a previous integration must be restored.
export async function placeGuests({ paths = guestPaths(), labelOf } = {}) {
  if (await desktopRunning()) throw Object.assign(new Error('Desktop が起動しています。終了してから開いてください'), { code: 'desktop_running' });
  if (await exists(paths.ledger)) {
    const restored = await restoreGuests({ paths });
    if (await exists(paths.ledger)) throw Object.assign(new Error(`前回のゲストを片付けられません。${restored.problems.join('、')}`), { code: 'desktop_guests_left' });
  }
  const plan = await planGuests({ paths, labelOf });
  if (!plan.ok) throw Object.assign(new Error(plan.reason), { code: 'desktop_unavailable' });
  await fs.mkdir(path.join(paths.state, 'backup'), { recursive: true, mode: 0o700 });
  const ledger = { version: 1, createdAt: new Date().toISOString(), host: plan.host, into: plan.into, entries: [] };
  // The ledger is written before each guest, so a crash leaves nothing untracked.
  for (const g of plan.guests) {
    const record = await readJson(g.originPath);
    const backup = path.join(paths.state, 'backup', g.sessionId);
    await fs.rm(backup, { recursive: true, force: true });
    await fs.mkdir(backup, { recursive: true, mode: 0o700 });
    clone(g.originPath, path.join(backup, 'origin.json'));
    clone(g.transcript, path.join(backup, 'transcript.jsonl'));
    const sidecar = g.transcript.slice(0, -'.jsonl'.length);
    if (await exists(sidecar)) clone(sidecar, path.join(backup, 'transcript.d'));
    ledger.entries.push({ sessionId: g.sessionId, cliSessionId: g.cliSessionId, account: g.account, org: g.org, prefix: g.prefix,
      guestPath: g.guestPath, originPath: g.originPath, originSha: await sha(g.originPath), transcript: g.transcript, backup });
    await writeJsonAtomic(paths.ledger, ledger);
    await writeJsonAtomic(g.guestPath, { ...record, title: g.prefix + (record.title || '') });
  }
  if (!ledger.entries.length) await fs.unlink(paths.ledger).catch(() => {});
  return { ...plan, placed: ledger.entries.length };
}

// Writes each guest back to its original and removes it. Desktop must be stopped.
export async function restoreGuests({ paths = guestPaths() } = {}) {
  const ledger = await readLedger(paths);
  if (!ledger) return { restored: 0, problems: [], notes: [] };
  if (await desktopRunning()) return { restored: 0, problems: ['Desktop が起動しています'], notes: [], running: true };
  const since = Date.parse(ledger.createdAt);
  const problems = [], notes = [];
  let restored = 0;
  for (const e of ledger.entries) {
    try {
      const guest = await readJson(e.guestPath).catch(() => null);
      const originChanged = await sha(e.originPath).catch(() => null) !== e.originSha;
      if (guest && originChanged) {
        await fs.copyFile(e.guestPath, path.join(e.backup, 'guest-conflict.json'));
        notes.push(`${e.sessionId}: 統合中に原本が別に更新されたため書き戻さず、ゲストを ${e.backup} に保存しました`);
      } else if (guest) {
        const origin = await readJson(e.originPath);
        const merged = { ...guest };
        for (const k of ACCOUNT_KEYS) k in origin ? merged[k] = origin[k] : delete merged[k];
        if (typeof guest.title === 'string' && guest.title.startsWith(e.prefix)) merged.title = guest.title.slice(e.prefix.length);
        await writeJsonAtomic(e.originPath, merged);
      } else notes.push(`${e.sessionId}: ゲストは統合中に削除されました。原本は残しました`);
      // Deleting a guest can release (reap) the shared transcript: put it back.
      if (!await exists(e.transcript)) { clone(path.join(e.backup, 'transcript.jsonl'), e.transcript); notes.push(`${e.sessionId}: 消えた会話記録を退避分から戻しました`); }
      const sidecar = e.transcript.slice(0, -'.jsonl'.length);
      if (await exists(path.join(e.backup, 'transcript.d')) && !await exists(sidecar)) clone(path.join(e.backup, 'transcript.d'), sidecar);
      const marker = path.join(path.dirname(e.transcript), `${e.cliSessionId}.desktop-released.json`);
      if ((await fs.stat(marker).catch(() => null))?.mtimeMs > since) await fs.unlink(marker);
      await fs.unlink(e.guestPath).catch(() => {});
      await fs.unlink(path.join(path.dirname(e.guestPath), `deleted_${e.sessionId}`)).catch(() => {});
      if (!(guest && originChanged)) await fs.rm(e.backup, { recursive: true, force: true });
      e.done = true;
      restored++;
    } catch (error) {
      problems.push(`${e.sessionId}: ${error.message}`);
    }
  }
  const left = ledger.entries.filter(e => !e.done);
  if (left.length) await writeJsonAtomic(paths.ledger, { ...ledger, entries: left });
  else await fs.unlink(paths.ledger).catch(() => {});
  if (notes.length || problems.length) await fs.appendFile(path.join(paths.state, 'restore.log'), `${new Date().toISOString()} ${[...notes, ...problems].join('\n  ')}\n`).catch(() => {});
  return { restored, problems, notes };
}

// guestPath → origin, for the board: a guest is shown as its original session.
let indexCache = { at: -1, map: new Map() };
export function guestIndex(paths = guestPaths()) {
  let mtime;
  try { mtime = fsSync.statSync(paths.ledger).mtimeMs; } catch { return new Map(); }
  if (indexCache.at === mtime && indexCache.file === paths.ledger) return indexCache.map;
  let map = new Map();
  try {
    const ledger = JSON.parse(fsSync.readFileSync(paths.ledger, 'utf8'));
    map = new Map(ledger.entries.map(e => [e.guestPath, { account: e.account, org: e.org, host: ledger.host, prefix: e.prefix, sessionId: e.sessionId }]));
  } catch {}
  indexCache = { at: mtime, file: paths.ledger, map };
  return map;
}

// Restores after Desktop quits. Runs detached from the server so the write-back happens
// even when the board is closed. Gives up waiting for a launch after `startMs`.
export async function watchAndRestore({ paths = guestPaths(), intervalMs = 3000, startMs = 120000, maxMs = 7 * 24 * 3600 * 1000 } = {}) {
  const begin = Date.now();
  let seen = false;
  while (Date.now() - begin < maxMs) {
    if (!await exists(paths.ledger)) return { restored: 0, reason: 'no-ledger' };
    const running = await desktopRunning();
    if (running) seen = true;
    else if (seen || Date.now() - begin > startMs) {
      // Desktop writes its records on quit; let that finish.
      await new Promise(r => setTimeout(r, intervalMs));
      if (!await desktopRunning()) return restoreGuests({ paths });
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { restored: 0, reason: 'timeout' };
}

export function spawnGuestWatcher({ env = process.env } = {}) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'watch'], { detached: true, stdio: 'ignore', env });
  child.unref();
  return child.pid;
}

// Opens a session of another account in the signed-in Desktop: places every account's
// sessions as guests, then opens it (which launches Desktop). Desktop must be stopped.
export async function openIntegrated({ sessionId, labelOf, open, paths = guestPaths(), watch = spawnGuestWatcher }) {
  if (await desktopRunning()) return { ok: false, code: 'desktop_running', reason: 'Desktop を終了してから開くと、全アカウントの会話をまとめた Desktop で開けます。' };
  const plan = await planGuests({ paths, labelOf });
  if (!plan.ok) return { ok: false, code: 'desktop_unavailable', reason: plan.reason };
  if (!plan.guests.some(g => g.sessionId === sessionId)) {
    const skip = plan.skipped.find(s => s.sessionId === sessionId);
    return { ok: false, code: 'not_guest', reason: skip?.reason === '作業途中で終了された会話'
      ? 'この会話は作業の途中で終了されています。ほかのアカウントで続きが走らないよう、元のアカウント（ターミナル）で再開してください。'
      : `この会話は Desktop にまとめて表示できません（${skip?.reason || '対象外'}）。` };
  }
  const placed = await placeGuests({ paths, labelOf });
  watch();
  try { await open(); }
  catch (error) { await restoreGuests({ paths }); throw error; }
  return { ok: true, placed: placed.placed, host: placed.host };
}

// At server start: tidy guests left by a watcher that did not finish.
export async function recoverGuests({ paths = guestPaths(), watch = spawnGuestWatcher } = {}) {
  if (!await exists(paths.ledger)) return null;
  if (await desktopRunning()) { watch(); return { watching: true }; }
  return restoreGuests({ paths });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  const paths = guestPaths();
  const run = { watch: () => watchAndRestore({ paths }), restore: () => restoreGuests({ paths }), plan: () => planGuests({ paths }), status: () => readLedger(paths) }[command];
  if (!run) { console.error('使い方: watch | restore | plan | status'); process.exit(2); }
  // One watcher at a time.
  const lock = path.join(paths.state, 'watch.pid');
  if (command === 'watch') {
    await fs.mkdir(paths.state, { recursive: true, mode: 0o700 });
    const other = Number(await fs.readFile(lock, 'utf8').catch(() => 0));
    if (other && other !== process.pid) { try { process.kill(other, 0); process.exit(0); } catch {} }
    await fs.writeFile(lock, String(process.pid));
  }
  const result = await run();
  if (command === 'watch') await fs.unlink(lock).catch(() => {});
  console.log(JSON.stringify(result, null, 2));
}

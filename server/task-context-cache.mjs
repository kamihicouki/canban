// Derived board observations only. Reading this cache never lists providers,
// opens a transcript, reads credentials, starts a CLI, or writes task state.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const VERSION = 1;
const MAX_BYTES = 128 * 1024;
const MAX_SESSIONS = 50;
const MAX_AGE_MS = 5 * 60 * 1000;
const SOURCE = 'board-snapshot';
const STATUSES = new Set(['idle', 'running', 'waiting', 'completed', 'aborted']);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const linksOf = card => [...new Set((card?.links || []).filter(id => typeof id === 'string'))].sort();
const timestamp = value => {
  const result = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(result) && result >= 0 ? result : null;
};
function canonical(value, home) {
  const resolved = path.resolve(value.startsWith('~/') ? path.join(home, value.slice(2)) : value);
  try { return fs.realpathSync(resolved); } catch (error) { if (error.code === 'ENOENT') return resolved; throw error; }
}
function stamp(file) {
  try { const st = fs.statSync(file, { bigint: true }); return [fs.realpathSync(file), String(st.ino), String(st.mtimeNs), String(st.size)]; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function remoteIdentity(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 8 * 1024 * 1024) throw new Error('remote configuration is unavailable');
    const raw = JSON.parse(fs.readFileSync(fd, 'utf8'));
    const connections = raw?.['codex-managed-remote-connections'];
    return (Array.isArray(connections) ? connections : []).map(({ hostId, alias, hostname, sshPort }) => ({ hostId, alias, hostname, sshPort })).sort((a, b) => String(a.hostId).localeCompare(String(b.hostId)));
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function sourceHomeScope(homes) {
  return digest(homes.map(root => [root, canonical(root, os.homedir()), ['auth.json', '.claude.json', 'config.json'].map(name => stamp(path.join(root, name)))]));
}
export function taskContextScope(dir, state, { env = process.env, home = os.homedir() } = {}) {
  dir = canonical(dir, home);
  const account = state.settings?.accounts || {};
  const codex = canonical(env.CANBAN_CODEX_HOME || env.CODEX_HOME || path.join(home, '.codex'), home);
  const claude = canonical(env.CANBAN_CLAUDE_HOME || env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), home);
  const desktop = canonical(env.CANBAN_CLAUDE_DESKTOP_DIR || path.join(home, 'Library/Application Support/Claude/claude-code-sessions'), home);
  const homes = [...new Set([codex, claude, ...(account.codexHomes || []), ...(account.claudeHomes || []), ...(account.profiles || []).map(profile => profile.dir)].map(value => canonical(value, home)))].sort();
  // Only configuration/identity stamps: transcript and SQLite mtimes do not
  // invalidate this scope. No credential file contents are read or persisted.
  const identityFiles = homes.flatMap(root => ['auth.json', '.claude.json', 'config.json'].map(name => path.join(root, name)));
  const configuration = [path.join(home, '.ssh/config'), path.join(home, '.claude.json'), path.join(dir, 'desktop-accounts/claude/registry.json')];
  const otherRoots = Object.fromEntries(['CANBAN_ANTIGRAVITY_DIR', 'CANBAN_GEMINI_HOME', 'CANBAN_CURSOR_HOME', 'CANBAN_CURSOR_WORKSPACE_DIR', 'CANBAN_CHATGPT_DIR', 'CANBAN_GROK_HOME', 'CANBAN_DESKTOP_GUESTS_DIR'].map(key => [key, env[key] ? canonical(env[key], home) : null]));
  return digest({ roots: [codex, claude, desktop, ...homes], otherRoots,
    account: { discover: account.discover !== false, codexHomes: (account.codexHomes || []).map(value => canonical(value, home)).sort(), claudeHomes: (account.claudeHomes || []).map(value => canonical(value, home)).sort(), profiles: (account.profiles || []).map(({ id, agent, dir, key, expectedKey, pending }) => ({ id, agent, dir, key, expectedKey, pending })).sort((a, b) => String(a.id).localeCompare(String(b.id))) },
    remotes: Object.entries(state.remoteHosts || {}).sort(([a], [b]) => a.localeCompare(b)),
    remoteIdentity: remoteIdentity(path.join(codex, '.codex-global-state.json')),
    stamps: [...identityFiles, ...configuration].map(file => [file, stamp(file)]),
  });
}
function cacheDirectory(dir, create = false) {
  const root = fs.realpathSync(dir);
  let current = root;
  for (const part of ['cache', 'task-context']) {
    current = path.join(current, part);
    if (create) { try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    const st = fs.lstatSync(current);
    if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o022)) throw new Error('unsafe cache directory');
  }
  return current;
}
function readRecord(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_BYTES || (st.mode & 0o077)) throw new Error('invalid cache file');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}
function sessionSummary(id, session, observedAt) {
  const statusKnown = !!session && session.statusKnown !== false && STATUSES.has(session.status);
  const last = typeof session?.lastSaid === 'string' ? session.lastSaid : session?.lastAssistant?.text;
  const title = typeof session?.title === 'string' ? session.title : null;
  return { id, agent: typeof session?.agent === 'string' ? session.agent.slice(0, 40) : id.split(/[@:]/)[0],
    title: title?.slice(0, 300) ?? null, titleTruncated: !!(title && title.length > 300) || session?.titleTruncated === true,
    status: statusKnown ? session.status : null, statusKnown,
    lastAssistant: typeof last === 'string' && last ? { text: last.slice(0, 600), at: null, source: 'board-last-assistant-excerpt', truncated: last.length > 600 || session?.lastAssistant?.truncated === true } : null,
    updatedAt: timestamp(session?.updatedAt), source: SOURCE, observedAt,
  };
}
function writeRecord(file, record) {
  // A per-task exclusive lock fences competing processes. Contention is skipped;
  // the next normal board refresh can publish, without blocking its UI.
  const lock = `${file}.lock`, temp = `${file}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(lock, 'wx', 0o600);
    let previous = null;
    try { previous = readRecord(file); } catch (error) { if (error.code !== 'ENOENT' && fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) return false; }
    if (previous?.version === VERSION && previous.observedAt >= record.observedAt) return true;
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized) > MAX_BYTES) return false;
    fs.writeFileSync(temp, serialized, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
    return true;
  } catch { return false; }
  finally {
    try { fs.unlinkSync(temp); } catch {}
    if (fd !== undefined) { fs.closeSync(fd); try { fs.unlinkSync(lock); } catch {} }
  }
}
export function publishTaskContexts(dir, state, sessions, { now = Date.now(), scope } = {}) {
  try {
    const expectedScope = taskContextScope(dir, state);
    if (scope !== undefined && scope !== expectedScope) return false;
    const directory = cacheDirectory(dir, true), byId = new Map(sessions.map(session => [session.id, session]));
    let saved = true;
    for (const [taskId, card] of Object.entries(state.cards || {})) {
      if (card.kind !== 'task') continue;
      const links = linksOf(card);
      const selected = links.slice(0, MAX_SESSIONS);
      const sourceHomes = [...new Set(selected.flatMap(id => {
        const session = byId.get(id);
        return session?.host?.local !== false && typeof session?.homeDir === 'string' && path.isAbsolute(session.homeDir) && session.homeDir.length <= 4096 ? [session.homeDir] : [];
      }))].sort();
      const record = { version: VERSION, scope: expectedScope, links: digest(links), observedAt: now,
        sourceHomes, sourceHomeScope: sourceHomeScope(sourceHomes),
        linkedCount: links.length, missingCount: links.filter(id => !byId.has(id)).length,
        sessions: selected.map(id => sessionSummary(id, byId.get(id), now)) };
      if (!writeRecord(path.join(directory, `${digest(taskId)}.json`), record)) saved = false;
    }
    return saved;
  } catch { return false; }
}
export function readTaskContext(dir, state, taskId, { now = Date.now() } = {}) {
  const links = linksOf(state.cards?.[taskId]);
  const unavailable = reason => ({ sessions: [], coverage: { state: 'unavailable', source: SOURCE, live: false, reason, observedAt: null, ageMs: null, maxAgeMs: MAX_AGE_MS, linkedCount: links.length, returnedCount: 0, truncated: false, complete: false, missingCount: null } });
  try {
    const file = path.join(cacheDirectory(dir), `${digest(taskId)}.json`), record = readRecord(file);
    if (record?.version !== VERSION || record.scope !== taskContextScope(dir, state) || record.links !== digest(links)) return unavailable('scope-mismatch');
    if (!Array.isArray(record.sourceHomes) || record.sourceHomes.length > MAX_SESSIONS || record.sourceHomes.some(root => typeof root !== 'string' || root.length > 4096 || !path.isAbsolute(root)) || record.sourceHomeScope !== sourceHomeScope(record.sourceHomes)) return unavailable('scope-mismatch');
    const at = timestamp(record.observedAt), ageMs = at === null ? -1 : now - at;
    if (ageMs < 0 || !Array.isArray(record.sessions) || record.sessions.length > MAX_SESSIONS) return unavailable('invalid-cache');
    const expected = links.slice(0, MAX_SESSIONS);
    if (record.sessions.length !== expected.length || record.sessions.some((session, i) => session.id !== expected[i])) return unavailable('invalid-cache');
    const sessions = record.sessions.map(session => sessionSummary(session.id, session, at));
    const missingCount = Number.isInteger(record.missingCount) && record.missingCount >= 0 && record.missingCount <= links.length ? record.missingCount : null;
    return { sessions, coverage: { state: ageMs >= MAX_AGE_MS ? 'stale' : 'fresh', source: SOURCE, live: false, reason: ageMs >= MAX_AGE_MS ? 'snapshot-expired' : null,
      observedAt: at, ageMs, maxAgeMs: MAX_AGE_MS, linkedCount: links.length, returnedCount: sessions.length, truncated: links.length > sessions.length, complete: missingCount === 0 && links.length === sessions.length, missingCount } };
  } catch (error) { return unavailable(error.code === 'ENOENT' ? 'not-acquired' : 'cache-unavailable'); }
}

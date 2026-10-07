// Claude Code session reader (read-only).
// Transcripts: ~/.claude/projects/<escaped-cwd>/<sessionId>.jsonl
// Desktop app metadata: ~/Library/Application Support/Claude/claude-code-sessions/*/*/local_*.json
// Summary normalization and message extraction are shared with the remote collector.
import path from 'node:path';
import { exists, listDir, listSubdirs, readJson, readJsonLines, readTailJsonLines, stat } from './readonly.mjs';
import { projectName, clip, cleanPrompt, firstLine, LOCAL_HOST, sessionKey } from './util.mjs';
import { defaultClaudeHome, claudeDesktopSessionsDir, claudeDesktopFolders, claudeHomes, refreshAccounts, sessionAccount } from '../accounts.mjs';

export { claudeDesktopSessionsDir };
export const claudeHome = defaultClaudeHome;

// How many leading human prompts a summary keeps; the first non-empty one after
// cleanup becomes the preview. Keep in sync with collect.py.
export const SUMMARY_PROMPTS = 3;

// Parsed transcript summaries keyed by file path, invalidated by mtime + size.
const cache = new Map();

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

export function isHumanPrompt(o) {
  if (o?.type !== 'user' || o.isSidechain || o.isMeta) return false;
  const c = o.message?.content;
  if (Array.isArray(c) && c.some((x) => x?.type === 'tool_result')) return false;
  return true;
}

// Transcript summary: built by folding records one at a time (the remote collector
// produces the same shape).
export function newSummary(sessionId) {
  return {
    sessionId,
    cwd: null,
    branch: null,
    prompts: [],
    customTitle: null,
    agentName: null,
    model: null,
    createdAt: null,
    updatedAt: null,
    prUrl: null,
    turns: 0,
    tokens: 0,
    entrypoint: null, // the app that started the session (claude-desktop / cli / sdk-cli)
  };
}

export function foldSummary(s, o) {
  if (!o || typeof o !== 'object') return s;
  const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
  if (!Number.isNaN(ts)) {
    if (s.createdAt == null || ts < s.createdAt) s.createdAt = ts;
    if (s.updatedAt == null || ts > s.updatedAt) s.updatedAt = ts;
  }
  // Resume where the main conversation last worked, not its initial checkout.
  // Sidechains can run elsewhere; they must not redirect the parent session.
  if (!o.isSidechain) {
    if (typeof o.cwd === 'string' && o.cwd.trim()) s.cwd = o.cwd;
    if (typeof o.gitBranch === 'string' && o.gitBranch.trim()) s.branch = o.gitBranch;
  }
  if (!s.entrypoint && typeof o.entrypoint === 'string') s.entrypoint = o.entrypoint;
  switch (o.type) {
    case 'custom-title':
      if (o.customTitle) s.customTitle = o.customTitle;
      break;
    case 'agent-name':
      if (o.agentName) s.agentName = o.agentName;
      break;
    case 'pr-link':
      if (o.prUrl) s.prUrl = o.prUrl;
      break;
    case 'assistant': {
      if (o.message?.model) s.model = o.message.model;
      const u = o.message?.usage;
      if (u && typeof u === 'object') {
        for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) s.tokens += Number(u[k]) || 0;
      }
      break;
    }
    case 'user':
      if (isHumanPrompt(o)) {
        s.turns++;
        if (s.prompts.length < SUMMARY_PROMPTS) s.prompts.push(textOf(o.message?.content));
      }
      break;
  }
  return s;
}

async function summarizeTranscript(file) {
  const st = await stat(file);
  if (!st) return null;
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.summary;
  const s = newSummary(path.basename(file, '.jsonl'));
  for await (const o of readJsonLines(file)) foldSummary(s, o);
  s.fileMtimeMs = st.mtimeMs;
  s.fileBirthMs = st.birthtimeMs || st.mtimeMs;
  s.file = file;
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, summary: s });
  return s;
}

export function normalizeClaudeSummary(s, dm, host = LOCAL_HOST) {
  const firstPrompt = (s.prompts || []).map((p) => cleanPrompt(p)).find(Boolean) || '';
  if (!firstPrompt && !s.turns && !s.customTitle) return null;
  const title = s.customTitle || dm?.title || firstLine(firstPrompt) || '(無題)';
  const lastActivity = dm?.lastActivityAt ? Number(dm.lastActivityAt) : 0;
  const updatedAt = Math.max(s.updatedAt ?? s.fileMtimeMs ?? 0, lastActivity) || null;
  const cwd = s.cwd || dm?.cwd || null;
  const group = dm?.group;
  const groupName = typeof group === 'string' ? group.trim() : typeof group?.name === 'string' ? group.name.trim() : typeof dm?.groupName === 'string' ? dm.groupName.trim() : '';
  return {
    id: sessionKey('claude', host, s.sessionId),
    agent: 'claude',
    nativeId: s.sessionId,
    host,
    desktopSessionId: typeof dm?.sessionId === 'string' && /^local_[A-Za-z0-9-]{1,64}$/.test(dm.sessionId) ? dm.sessionId : null,
    title: clip(title, 160),
    cwd,
    project: projectName(cwd),
    claudeGroup: groupName ? { id: typeof group?.id === 'string' ? group.id : typeof dm?.groupId === 'string' ? dm.groupId : groupName, name: groupName } : null,
    branch: s.branch || null,
    model: dm?.model || s.model || null,
    createdAt: s.createdAt ?? s.fileBirthMs ?? null,
    updatedAt,
    archived: dm?.isArchived === true,
    subagent: false,
    automation: false,
    pinnedInAgent: false,
    preview: clip(firstPrompt, 280),
    sourcePath: s.file || null,
    prUrl: s.prUrl || null,
    agentName: s.agentName || null,
    tokens: s.tokens || 0,
    desktopStatus: dm?.postTurnSummary?.status_category ?? dm?.statusCategory ?? null,
    // Claude desktop metadata is often not on disk: archived / title / status from it are then unknown.
    desktopKnown: !!dm,
    desktopTitle: dm?.title ?? null,
    entrypoint: s.entrypoint || null,
    rawStatus: s.rawStatus ?? null,
    statusMtimeMs: s.statusMtimeMs ?? null,
    // Claude desktop keeps each account's sessions apart (claude-code-sessions/<account>/<org>/).
    desktopAccount: dm?._account ?? null,
    desktopReach: dm?._reach?.length > 1 ? dm._reach : undefined,
  };
}

// Desktop app metadata keyed by CLI session id, from every desktop profile (see
// accounts.mjs). _account: the account folder it really lives in; _reach: the accounts
// that see it (a folder linked into several accounts). A session kept by two profiles
// separately takes the copy with the latest activity.
const metaCache = new Map(); // file -> { mtimeMs, size, j }
async function readMeta(file) {
  const st = await stat(file);
  if (!st) return null;
  const hit = metaCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.j;
  try {
    const j = await readJson(file);
    metaCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, j });
    return j;
  } catch {
    return hit?.j ?? null;
  }
}

async function desktopFolders(dir) {
  if (dir === claudeDesktopSessionsDir()) return claudeDesktopFolders();
  const out = [];
  for (const a of await listSubdirs(dir)) for (const b of await listSubdirs(path.join(dir, a))) out.push({ dir: path.join(dir, a, b), owner: a, org: b, reach: new Set([a]) });
  return out;
}

async function loadDesktopMeta(dir = claudeDesktopSessionsDir()) {
  const meta = new Map();
  for (const folder of await desktopFolders(dir)) {
    for (const f of await listDir(folder.dir)) {
      if (!f.isFile() || !/^local_.*\.json$/.test(f.name)) continue;
      const j = await readMeta(path.join(folder.dir, f.name));
      if (!j?.cliSessionId) continue;
      const prev = meta.get(j.cliSessionId);
      const reach = [...new Set([...(prev?._reach || []), ...folder.reach])];
      if (prev && Number(prev.lastActivityAt || 0) >= Number(j.lastActivityAt || 0)) {
        prev._reach = reach;
        continue;
      }
      meta.set(j.cliSessionId, { ...j, _account: folder.owner, _org: folder.org, _reach: reach });
    }
  }
  return meta;
}

// Every Claude home (the default one and other CLAUDE_CONFIG_DIR folders, see
// accounts.mjs). A transcript found in two homes is listed once (the newest copy).
export async function listClaudeSessions({ home = null, desktopDir = claudeDesktopSessionsDir() } = {}) {
  try {
    await refreshAccounts();
    const homes = home ? [{ id: 'default', dir: home, default: true }] : await claudeHomes();
    const desktop = await loadDesktopMeta(desktopDir);
    const byId = new Map();
    for (const h of homes) {
      const projectsDir = path.join(h.dir, 'projects');
      if (!exists(projectsDir)) continue;
      for (const p of await listDir(projectsDir)) {
        if (!p.isDirectory()) continue;
        for (const f of await listDir(path.join(projectsDir, p.name))) {
          if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
          const s = await summarizeTranscript(path.join(projectsDir, p.name, f.name));
          const session = s && normalizeClaudeSummary(s, desktop.get(s.sessionId));
          if (!session) continue;
          if (!h.default) Object.assign(session, { home: h.id, homeDir: h.dir });
          const prev = byId.get(session.id);
          if (!prev || (session.updatedAt || 0) > (prev.updatedAt || 0)) byId.set(session.id, session);
        }
      }
    }
    const sessions = [...byId.values()];
    for (const s of sessions) s.account = sessionAccount(s);
    return { sessions, error: null };
  } catch (err) {
    return { sessions: [], error: `Claude セッション読み取り失敗: ${err.message}` };
  }
}

export function claudeMessagesFromRecords(records, limit = 12) {
  const msgs = [];
  for (const o of records) {
    if (!o || o.isSidechain) continue;
    if (isHumanPrompt(o)) {
      const text = cleanPrompt(textOf(o.message?.content));
      if (text) msgs.push({ role: 'user', text: clip(text, 1200), at: o.timestamp });
    } else if (o.type === 'assistant') {
      const text = textOf(o.message?.content).trim();
      if (text) msgs.push({ role: 'assistant', text: clip(text, 1200), at: o.timestamp });
    }
  }
  return msgs.slice(-limit);
}

export async function claudeSessionMessages(file, limit = 12) {
  if (!file || !exists(file)) return [];
  return claudeMessagesFromRecords(await readTailJsonLines(file, 768 * 1024), limit);
}

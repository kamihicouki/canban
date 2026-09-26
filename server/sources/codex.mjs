// Codex session reader (read-only).
// Primary source: ~/.codex/state_<n>.sqlite `threads` table.
// Detail source: the thread's rollout JSONL file.
// Row normalization and message extraction are shared with the remote collector.
import path from 'node:path';
import os from 'node:os';
import { exists, listDir, queryReadOnly, readTailJsonLines } from './readonly.mjs';
import { projectName, clip, cleanPrompt, firstLine, LOCAL_HOST, sessionKey } from './util.mjs';

export function codexHome() {
  return process.env.CANBAN_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

// Columns read from `threads`; missing ones are skipped so older/newer schemas keep working.
// Keep in sync with CODEX_COLUMNS in server/remote/collect.py.
export const CODEX_COLUMNS = [
  'id', 'rollout_path', 'created_at', 'updated_at', 'created_at_ms', 'updated_at_ms', 'source', 'thread_source',
  'cwd', 'title', 'name', 'archived', 'git_branch', 'model', 'first_user_message', 'preview', 'agent_role',
  'agent_nickname', 'is_pinned', 'git_origin_url',
];

// Pick the highest-numbered state_<n>.sqlite so a schema bump keeps working.
export async function findStateDb(home = codexHome()) {
  const entries = await listDir(home);
  let best = null;
  for (const e of entries) {
    const m = /^state_(\d+)\.sqlite$/.exec(e.name);
    if (m && e.isFile() && (!best || Number(m[1]) > best.n)) best = { n: Number(m[1]), file: path.join(home, e.name) };
  }
  return best?.file ?? null;
}

const SUBAGENT_THREAD_SOURCES = new Set(['subagent', 'guardian_review']);

function isSubagent(row) {
  if (row.agent_role) return true;
  if (row.thread_source && SUBAGENT_THREAD_SOURCES.has(row.thread_source)) return true;
  return typeof row.source === 'string' && row.source.startsWith('{') && row.source.includes('subagent');
}

export function normalizeCodexRow(r, host = LOCAL_HOST) {
  const createdAt = r.created_at_ms ?? (r.created_at != null ? r.created_at * 1000 : null);
  const updatedAt = r.updated_at_ms ?? (r.updated_at != null ? r.updated_at * 1000 : createdAt);
  const firstPrompt = cleanPrompt(r.first_user_message || '');
  const title = (r.name && r.name.trim()) || firstLine(cleanPrompt(r.title)) || firstLine(firstPrompt) || '(無題)';
  return {
    id: sessionKey('codex', host, r.id),
    agent: 'codex',
    nativeId: r.id,
    host,
    title: clip(title, 160),
    cwd: r.cwd || null,
    project: projectName(r.cwd),
    branch: r.git_branch || null,
    gitOriginUrl: r.git_origin_url || null,
    model: r.model || null,
    createdAt,
    updatedAt,
    archived: !!r.archived,
    subagent: isSubagent(r),
    automation: r.thread_source === 'automation',
    pinnedInAgent: !!r.is_pinned,
    preview: clip(firstPrompt || r.preview || '', 280),
    sourcePath: r.rollout_path || null,
    rawStatus: r.rawStatus ?? null,
    statusMtimeMs: r.statusMtimeMs ?? null,
  };
}

export async function listCodexSessions({ home = codexHome() } = {}) {
  const dbPath = await findStateDb(home);
  if (!dbPath || !exists(dbPath)) return { sessions: [], error: null };
  try {
    const { rows, edges } = queryReadOnly(dbPath, (db) => {
      const cols = new Set(db.prepare('PRAGMA table_info(threads)').all().map((c) => c.name));
      const want = CODEX_COLUMNS.filter((c) => cols.has(c));
      const hasEdges = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_spawn_edges'").get();
      return {
        rows: db.prepare(`SELECT ${want.join(', ')} FROM threads`).all(),
        edges: hasEdges ? db.prepare('SELECT parent_thread_id AS parent, child_thread_id AS child FROM thread_spawn_edges').all() : [],
      };
    });
    const sessions = rows.map((r) => normalizeCodexRow(r));
    attachSpawnEdges(sessions, edges);
    return { sessions, error: null };
  } catch (err) {
    return { sessions: [], error: `Codex DB 読み取り失敗: ${err.message}` };
  }
}

// Link sub-agent threads to their parent (same host): parent.children / child.parentId.
export function attachSpawnEdges(sessions, edges, host = LOCAL_HOST) {
  if (!edges?.length) return;
  const byNative = new Map(sessions.filter((s) => s.agent === 'codex').map((s) => [s.nativeId, s]));
  for (const { parent, child } of edges) {
    const p = byNative.get(parent);
    const c = byNative.get(child);
    if (!p || !c) continue;
    (p.children ||= []).push(sessionKey('codex', host, child));
    c.parentId = sessionKey('codex', host, parent);
  }
}

function itemText(item) {
  return (item.content || [])
    .map((c) => c.text || '')
    .filter(Boolean)
    .join('\n');
}

// Recent user / final agent messages from rollout records.
export function codexMessagesFromRecords(records, limit = 12) {
  const msgs = [];
  for (const o of records) {
    const p = o?.payload;
    if (o?.type !== 'event_msg' || p?.type !== 'item_completed' || !p.item) continue;
    const it = p.item;
    if (it.type === 'UserMessage') {
      const text = cleanPrompt(itemText(it));
      if (text) msgs.push({ role: 'user', text: clip(text, 1200), at: o.timestamp });
    } else if (it.type === 'AgentMessage' && it.phase !== 'commentary') {
      const text = itemText(it).trim();
      if (text) msgs.push({ role: 'assistant', text: clip(text, 1200), at: o.timestamp });
    }
  }
  return msgs.slice(-limit);
}

export async function codexSessionMessages(rolloutPath, limit = 12) {
  if (!rolloutPath || !exists(rolloutPath)) return [];
  return codexMessagesFromRecords(await readTailJsonLines(rolloutPath, 768 * 1024), limit);
}

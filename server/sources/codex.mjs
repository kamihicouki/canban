// Codex session reader (read-only).
// Primary source: ~/.codex/state_<n>.sqlite `threads` table.
// Detail source: the thread's rollout JSONL file.
// Row normalization and message extraction are shared with the remote collector.
import path from 'node:path';
import { exists, listDir, queryReadOnly, readJsonLines, readTailJsonLines, rolloutFile, stat } from './readonly.mjs';
import { projectName, clip, cleanPrompt, firstLine, LOCAL_HOST, sessionKey } from './util.mjs';
import { defaultCodexHome, codexHomes, refreshAccounts, sessionAccount } from '../accounts.mjs';
import { resolveCreatedChatParents, attachCreatedChatEdges } from './codex-created-chats.mjs';

export const codexHome = defaultCodexHome;

// Columns read from `threads`; missing ones are skipped so older/newer schemas keep working.
// Keep in sync with CODEX_COLUMNS in server/remote/collect.py.
export const CODEX_COLUMNS = [
  'id', 'rollout_path', 'created_at', 'updated_at', 'created_at_ms', 'updated_at_ms', 'source', 'thread_source',
  'cwd', 'title', 'name', 'archived', 'git_branch', 'model', 'first_user_message', 'preview', 'agent_role',
  'agent_nickname', 'is_pinned', 'git_origin_url', 'tokens_used', 'sandbox_policy', 'approval_mode', 'thread_section_id',
  'creator_account_id', 'attached_thread_parent_id',
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
    sideChatParentId: r.attached_thread_parent_id || undefined,
    agent: 'codex',
    nativeId: r.id,
    host,
    title: clip(title, 160),
    cwd: r.cwd || null,
    project: projectName(r.cwd),
    branch: r.git_branch || null,
    gitOriginUrl: r.git_origin_url || null,
    tokens: Number(r.tokens_used) || 0,
    // Codex sidebar section (remote rows carry the name; local ones get it from the section map)
    codexSection: r.thread_section_id ? { id: r.thread_section_id, name: r.section_name || null } : null,
    sandboxPolicy: r.sandbox_policy || null,
    approvalMode: r.approval_mode || null,
    model: r.model || null,
    createdAt,
    updatedAt,
    archived: !!r.archived,
    subagent: isSubagent(r),
    automation: r.thread_source === 'automation',
    threadSource: r.thread_source || null,
    pinnedInAgent: !!r.is_pinned,
    preview: clip(firstPrompt || r.preview || '', 280),
    sourcePath: r.rollout_path || null,
    rawStatus: r.rawStatus ?? null,
    statusMtimeMs: r.statusMtimeMs ?? null,
    creatorAccount: r.creator_account_id || null,
  };
}

// Listing is incremental: reading every row costs seconds on a large history (and
// blocks the event loop), so rows are cached per DB and refreshed by `updated_at`
// (indexed). Nothing is queried while the DB and its WAL are unchanged; a full
// read happens on first use, when rows disappear, and every FULL_REFRESH_MS.
const FULL_REFRESH_MS = 30 * 60e3;
const listCache = new Map(); // dbPath -> { sig, maxU, rows: Map(id -> session), edges, fullAt }
export const codexListCounters = { full: 0, delta: 0, skipped: 0 };

async function dbSignature(dbPath) {
  const parts = await Promise.all([dbPath, `${dbPath}-wal`].map(async (p) => {
    const st = await stat(p);
    return st ? `${st.mtimeMs}:${st.size}` : '-';
  }));
  return parts.join('|');
}

async function cachedThreads(home, now) {
  const dbPath = await findStateDb(home);
  if (!dbPath || !exists(dbPath)) return null;
  const sig = await dbSignature(dbPath);
  let c = listCache.get(dbPath);
  if (c && c.sig === sig && now - c.fullAt < FULL_REFRESH_MS) codexListCounters.skipped++;
  else {
    listCache.delete(dbPath);
    c = readThreads(dbPath, c, sig, now);
  }
  listCache.set(dbPath, c);
  return c;
}

// Every Codex home (the default one and other CODEX_HOME folders, see accounts.mjs).
async function homesFor(home) {
  return home ? [{ id: 'default', dir: home, default: true }] : codexHomes();
}

function sessionOf(c, h, x) {
  const s = { ...x, codexSection: c.sections.get(x.nativeId) || null };
  if (!h.default) Object.assign(s, { home: h.id, homeDir: h.dir });
  s.account = sessionAccount(s);
  return s;
}

export async function listCodexSessions({ home = null, now = Date.now() } = {}) {
  try {
    await refreshAccounts();
    const byId = new Map();
    const attachedIds = new Set();
    const groups = [];
    for (const h of await homesFor(home)) {
      const c = await cachedThreads(h.dir, now);
      if (!c) continue;
      const mine = [];
      for (const x of c.rows.values()) {
        if (x.sideChatParentId) attachedIds.add(x.id);
        const previous = byId.get(x.id);
        // An attachment edge is authoritative even if an older copy of the
        // same row was seen first in another local home.
        if (previous && (!x.sideChatParentId || previous.sideChatParentId)) continue;
        const s = sessionOf(c, h, x);
        byId.set(s.id, s);
        mine.push(s);
      }
      groups.push({ h, c, mine });
    }
    const sessions = attachCodexSideChats([...byId.values()]);
    for (const { h, c, mine } of groups) {
      const roots = mine.filter(s => byId.get(s.id) === s && !s.sideChatParentId);
      attachSpawnEdges(roots, c.edges);
      const createdParents = await resolveCreatedChatParents(h.dir, roots);
      attachCreatedChatEdges(roots, createdParents);
    }
    return { sessions, attachedIds, error: null };
  } catch (err) {
    return { sessions: [], error: `Codex DB 読み取り失敗: ${err.message}` };
  }
}

// One thread from the same cache, without copying the whole listing (dispatch ticks).
export async function findCodexSession(nativeId, { home = null, now = Date.now() } = {}) {
  await refreshAccounts();
  let selected = null;
  const attachments = new Map();
  for (const h of await homesFor(home)) {
    const c = await cachedThreads(h.dir, now);
    if (!c) continue;
    const x = c.rows.get(nativeId);
    if (x?.sideChatParentId) return null;
    if (x && !selected) selected = { c, h, x };
    for (const row of c.attachments) {
      if (!attachments.has(row.nativeId)) attachments.set(row.nativeId, row);
    }
  }
  if (!selected) return null;
  const { c, h, x } = selected;
  const s = sessionOf(c, h, x);
  const sideChats = [...attachments.values()].filter(row => row.sideChatParentId === nativeId).map(sideChatView);
  if (sideChats.length) s.sideChats = sortSideChats(sideChats);
  const visible = id => c.rows.has(id) && !attachments.has(id);
  s.subagent = s.subagent || c.edges.some((e) => e.child === nativeId);
  const children = c.edges.filter(e => e.parent === nativeId && visible(e.child)).map(e => sessionKey('codex', LOCAL_HOST, e.child));
  if (children.length) s.children = children;
  const parent = c.edges.find(e => e.child === nativeId && visible(e.parent));
  if (parent) s.parentId = sessionKey('codex', LOCAL_HOST, parent.parent);
  const createdCandidates = [...c.rows.values()].filter(r => !attachments.has(r.nativeId) && !r.subagent && r.threadSource === 'agent_created_thread');
  if (createdCandidates.length) {
    const createdParents = await resolveCreatedChatParents(h.dir, createdCandidates);
    const createdParent = createdParents.get(nativeId);
    if (createdParent && createdParent !== nativeId && !attachments.has(createdParent)) s.createdParentId = sessionKey('codex', LOCAL_HOST, createdParent);
    const createdChildren = [];
    for (const [cid, pid] of createdParents) {
      if (pid === nativeId && cid !== nativeId && visible(cid)) createdChildren.push(sessionKey('codex', LOCAL_HOST, cid));
    }
    if (createdChildren.length) s.createdChildren = createdChildren;
  }
  return s;
}

function readThreads(dbPath, prev, sig, now) {
  return queryReadOnly(dbPath, (db) => {
    const cols = new Set(db.prepare('PRAGMA table_info(threads)').all().map((c) => c.name));
    const want = CODEX_COLUMNS.filter((c) => cols.has(c));
    const hasEdges = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_spawn_edges'").get();
    const edges = hasEdges ? db.prepare('SELECT parent_thread_id AS parent, child_thread_id AS child FROM thread_spawn_edges').all() : [];
    const attachmentLinks = new Map(cols.has('attached_thread_parent_id')
      ? db.prepare('SELECT id, attached_thread_parent_id AS parent FROM threads WHERE attached_thread_parent_id IS NOT NULL').all().map(r => [r.id, r.parent])
      : []);
    const finish = (rows, fullAt) => {
      const attachments = [];
      for (const [id, row] of rows) {
        const parent = attachmentLinks.get(id) || undefined;
        const current = row.sideChatParentId === parent ? row : { ...row, sideChatParentId: parent };
        if (current !== row) rows.set(id, current);
        if (parent) attachments.push(current);
      }
      return { sig, maxU, rows, edges, sections, fullAt, attachments };
    };
    const maxU = db.prepare('SELECT max(updated_at) AS u FROM threads').get()?.u ?? 0;
    // Section membership is re-read on every change (moving a thread between sections
    // does not necessarily bump updated_at); a partial covering index makes it ~1 ms.
    const sections = new Map();
    if (cols.has('thread_section_id') && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_sections'").get()) {
      const names = new Map(db.prepare('SELECT id, name FROM thread_sections').all().map((r) => [r.id, r.name]));
      for (const r of db.prepare('SELECT id, thread_section_id AS sid FROM threads WHERE thread_section_id IS NOT NULL').all()) {
        if (names.has(r.sid)) sections.set(r.id, { id: r.sid, name: names.get(r.sid) });
      }
    }
    const incremental = prev && now - prev.fullAt < FULL_REFRESH_MS && cols.has('updated_at');
    if (incremental) {
      const rows = new Map(prev.rows);
      for (const r of db.prepare(`SELECT ${want.join(', ')} FROM threads WHERE updated_at >= ?`).all(prev.maxU - 1)) rows.set(r.id, normalizeCodexRow(r));
      // Archiving does not necessarily bump updated_at: refresh the flag from its index.
      if (cols.has('archived')) {
        const archived = new Set(db.prepare('SELECT id FROM threads WHERE archived = 1').all().map((r) => r.id));
        for (const [id, s] of rows) if (s.archived !== archived.has(id)) rows.set(id, { ...s, archived: archived.has(id) });
      }
      const count = db.prepare('SELECT count(*) AS n FROM threads').get().n;
      if (rows.size === count) {
        codexListCounters.delta++;
        return finish(rows, prev.fullAt);
      }
    }
    codexListCounters.full++;
    const rows = new Map(db.prepare(`SELECT ${want.join(', ')} FROM threads`).all().map((r) => [r.id, normalizeCodexRow(r)]));
    return finish(rows, now);
  });
}

function sideChatView({ id, nativeId, title, updatedAt, sourcePath }) {
  return { id, nativeId, title, updatedAt, sourcePath };
}

function sortSideChats(chats) {
  return chats.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

// Use Codex's attachment link, separately from spawn and delegation edges.
export function attachCodexSideChats(sessions) {
  const roots = sessions.filter(s => !s.sideChatParentId);
  const parents = new Map(roots.filter(s => s.agent === 'codex').map(s => [s.nativeId, s]));
  for (const s of sessions) {
    const parent = parents.get(s.sideChatParentId);
    if (parent) (parent.sideChats ||= []).push(sideChatView(s));
  }
  for (const parent of parents.values()) if (parent.sideChats) sortSideChats(parent.sideChats);
  return roots;
}

const SIDE_BOUNDARY = 'Side conversation boundary.\n\nEverything before this boundary is inherited history from the parent thread.';
const SIDE_MESSAGE_LIMIT = 40;
const SIDE_TEXT_LIMIT = 8000;
const SIDE_CONTEXT_BLOCK = /^\s*<(environment_context|realtime_delegation|heartbeat)(?:\s[^>]*)?>[\s\S]*<\/\1>\s*$/;

export async function readCodexSideChat(sideChat) {
  const file = rolloutFile(sideChat.sourcePath);
  if (!file || !exists(file)) throw new Error('サイド会話のログが見つかりません');
  let attached = false;
  let boundary = false;
  let truncated = false;
  const messages = [];
  for await (const record of readJsonLines(file)) {
    const p = record?.payload;
    if (record?.type === 'session_meta') {
      attached = p?.id === sideChat.nativeId && p?.attached_thread === true;
      if (!attached) break;
    }
    if (!attached || record?.type !== 'response_item' || p?.type !== 'message') continue;
    if (p.role !== 'user' && (p.role !== 'assistant' || (p.phase != null && !['final', 'final_answer'].includes(p.phase)))) continue;
    const content = p.role === 'user' ? 'input_text' : 'output_text';
    const blocks = (Array.isArray(p.content) ? p.content : [])
      .filter(item => item?.type === content && typeof item.text === 'string')
      .map(item => item.text);
    if (p.role === 'user' && blocks.some(text => text.startsWith(SIDE_BOUNDARY))) {
      boundary = true;
      truncated = false;
      messages.length = 0;
      continue;
    }
    const text = blocks.filter(block => !SIDE_CONTEXT_BLOCK.test(block)).join('\n');
    if (!boundary || !text.trim()) continue;
    const chars = text.length > SIDE_TEXT_LIMIT ? [...text] : null;
    const clipped = chars && chars.length > SIDE_TEXT_LIMIT;
    messages.push({
      role: p.role,
      text: clipped ? chars.slice(0, SIDE_TEXT_LIMIT - 1).join('') + '…' : text,
      at: typeof record.timestamp === 'string' ? record.timestamp : null,
    });
    if (messages.length > SIDE_MESSAGE_LIMIT) {
      messages.shift();
      truncated = true;
    }
    if (clipped) truncated = true;
  }
  if (!boundary) throw new Error('サイド会話の境界を確認できませんでした');
  return { messages, truncated };
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
  if (!rolloutPath || !exists(rolloutFile(rolloutPath))) return [];
  return codexMessagesFromRecords(await readTailJsonLines(rolloutPath, 768 * 1024), limit);
}

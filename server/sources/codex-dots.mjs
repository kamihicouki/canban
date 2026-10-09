// The desktop owns cloud synchronization. Read only its saved, user-visible dot chats.
import { clip, cleanPrompt, firstLine, LOCAL_HOST, sessionKey } from './util.mjs';

export const isCloudSession = s => s?.sourceKind === 'codex-cloud';
export const CLOUD_OPERATION_REASON = 'クラウドのセッションはCodexで操作してください。Canbanは保存済み情報の表示に対応しています。';
export const matchesDotScope = (s, scope = 'exclude') => scope === 'only' ? !!s.dot : scope === 'all' || !s.dot;
const text = v => typeof v === 'string' && v.trim() ? v.trim() : null;
const object = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v) ? v : null;
const milliseconds = v => Number.isFinite(v) && v > 0 ? v * 1000 : null;

export function parseDotCache(raw) {
  const saved = object(raw?.['electron-persisted-atom-state']?.['cloud-aeon-sidebar-cache-v1']);
  const profiles = object(saved.profilesByThreadId);
  const attachments = new Map((Array.isArray(saved.attachments) ? saved.attachments : [])
    .filter(a => id(a?.thread_id)).map(a => [a.thread_id, a]));
  const rows = new Map((Array.isArray(saved.threads) ? saved.threads : [])
    .filter(r => id(r?.id)).map(r => [r.id, r]));
  const dots = new Map(), sessions = [];
  const hostId = text(saved.hostId);
  const cachedAt = Number.isFinite(saved.refreshStartedAtMs) ? saved.refreshStartedAtMs : null;
  for (const [threadId, profile] of Object.entries(profiles)) {
    const p = object(profile), row = rows.get(threadId), a = attachments.get(threadId);
    if (!id(threadId) || !text(p.id) || p.aeon_kind !== 'orbit' || threadId === p.active_root_thread_id
      || a?.is_user_visible !== true || !a.parent_thread_id || a.parent_thread_id === threadId
      || row?.threadSource === 'dreaming' || row?.threadSource === 'aeon') continue;
    const dot = { id: p.id, name: clip(text(p.display_name) || 'dot', 120), relation: row?.threadSource === 'aeon_child' ? 'created' : 'related' };
    dots.set(threadId, dot);
    if (!row || !hostId) continue; // A reference without a saved summary is not a session.
    const preview = cleanPrompt(text(row.preview) || '');
    sessions.push({
      id: sessionKey('codex', LOCAL_HOST, threadId), nativeId: threadId, agent: 'codex',
      sourceKind: 'codex-cloud', cloud: { hostId, cachedAt }, dot,
      host: { id: hostId, alias: null, label: 'Codex Cloud', local: false, cloud: true },
      account: text(saved.accountId) ? `codex:${saved.accountId}` : null,
      title: clip(text(row.name) || firstLine(preview) || '(無題)', 160), preview: clip(preview, 280),
      cwd: null, project: null, branch: null, sourcePath: null,
      model: text(row.model), createdAt: milliseconds(row.createdAt), updatedAt: milliseconds(row.updatedAt),
      threadSource: text(row.threadSource), subagent: row.threadSource === 'subagent' || !!row.agentRole,
      archived: row.section === 'archived', automation: false, tokens: 0,
      status: 'idle', statusKnown: false, pinnedInAgent: false,
    });
  }
  return { dots, sessions };
}

export function mergeDotSessions(sessions, app, { includeCloud = true } = {}) {
  const result = new Map(sessions.map(s => [s.id, s]));
  if (includeCloud) for (const s of app.dotSessions || []) if (!result.has(s.id)) result.set(s.id, { ...s });
  return [...result.values()];
}

import { ACCOUNT_KEY } from './accounts-settings.mjs';

export const TASK_CONTEXT_KEYS = ['project', 'folder', 'section', 'agent', 'host', 'account'];

// null is an explicit "none"; an absent key follows linked sessions/launch preferences.
export function normalizeTaskContext(value) {
  if (value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('タスクの所属情報が不正です');
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!TASK_CONTEXT_KEYS.includes(key)) throw new Error('タスクの所属項目が不正です');
    if (raw === null) { out[key] = null; continue; }
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 300) throw new Error('タスクの所属情報を確認してください');
    const text = raw.trim();
    if (key === 'agent' && !['codex', 'claude'].includes(text)) throw new Error('AI Appを確認してください');
    if (key === 'account' && !ACCOUNT_KEY.test(text)) throw new Error('アカウントを確認してください');
    out[key] = text;
  }
  if (out.account && Object.hasOwn(out, 'agent') && out.agent !== out.account.split(':')[0]) throw new Error('AI Appとアカウントが一致していません');
  return out;
}

export function effectiveTaskContext(task, links = []) {
  // Multiple links are a set of facts, not a representative project/account.
  // Keep the legacy single-link API; explicit context still has three states.
  const one = links.length === 1 ? links[0] : null;
  const fallback = {
    project: one?.project || null,
    folder: one?.folder || null,
    section: one?.codexSection?.id || null,
    agent: task.context?.account?.split(':')[0] || one?.agent || (!links.length ? task.target?.agent : null) || null,
    host: one ? one.host?.id || 'local' : !links.length ? task.target?.hostId || 'local' : null,
    account: one?.account || null,
  };
  return Object.fromEntries(TASK_CONTEXT_KEYS.map(key => [key, Object.hasOwn(task.context || {}, key) ? task.context[key] : fallback[key]]));
}

export const taskContextSchema = {
  type: ['object', 'null'], additionalProperties: false,
  properties: Object.fromEntries(TASK_CONTEXT_KEYS.map(key => [key, {
    type: ['string', 'null'], maxLength: 300,
    ...(key === 'agent' ? { enum: ['codex', 'claude', null] } : {}),
  }])),
};

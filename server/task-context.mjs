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
  const fallback = {
    project: links.find(s => s.project)?.project || null,
    folder: links.find(s => s.folder)?.folder || null,
    section: links.find(s => s.codexSection)?.codexSection.id || null,
    agent: task.context?.account?.split(':')[0] || links[0]?.agent || task.target?.agent || null,
    host: links.length ? links[0].host?.id || 'local' : task.target?.hostId || 'local',
    account: links.find(s => s.account)?.account || null,
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

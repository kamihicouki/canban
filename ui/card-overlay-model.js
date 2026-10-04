// Pure rules for the card overlay (Trello's "back of card"); also exercised by the Node tests.
// A card is shown on its own layer above the board. Layout (section order, heights, column ratio)
// and width are kept per kind of card — "session" and "task" — and shared by every card of that kind.
const CARD_KINDS = ['session', 'task'];
const CARD_WIDTH_DEF = { session: 720, task: 520 };
const CARD_WIDTH_MIN = 360, CARD_WIDTH_MAX = 1200;
const TASK_SESSIONS_MAX = 8;
// Analytics and Agent Usage open on the same layer as sheets, under ids of their own ("view:analytics").
const VIEW_SHEETS = { analytics: ['chart', '分析'], usage: ['gauge', 'Agent Usage'] };
const cardKind = (id) => (String(id).startsWith('task:') ? 'task' : String(id).startsWith('view:') ? 'view' : 'session');
const viewOf = (id) => (cardKind(id) === 'view' && Object.hasOwn(VIEW_SHEETS, String(id).slice(5)) ? String(id).slice(5) : null);
function normalizeCardWidths(value) {
  const out = {};
  for (const kind of CARD_KINDS) {
    const width = value?.[kind];
    out[kind] = typeof width === 'number' && Number.isFinite(width) ? Math.min(CARD_WIDTH_MAX, Math.max(CARD_WIDTH_MIN, Math.round(width))) : CARD_WIDTH_DEF[kind];
  }
  return out;
}
function taskCardLayoutDefaults() {
  return { main: ['conv', 'memo', 'related', 'send'], heights: { conv: 110, memo: 120, related: 110 } };
}
function normalizeCardLayouts(value, defaults, heightDefaults) {
  return {
    session: normalizePaneLayout(value?.session, defaults, heightDefaults),
    task: normalizePaneLayout(value?.task ?? taskCardLayoutDefaults(), defaults, heightDefaults),
  };
}
// The task's own card, then its linked sessions (never sub-agents) side by side, at most TASK_SESSIONS_MAX.
// The order is stable: sessions already shown keep their place, new links go last, removed ones drop out.
function taskOverlayIds(taskId, links, shown = [], max = TASK_SESSIONS_MAX) {
  const ids = links.filter((l) => !l.subagent).map((l) => l.id);
  const kept = shown.filter((id) => id !== taskId && ids.includes(id));
  const rest = ids.filter((id) => !kept.includes(id));
  return { ids: [taskId, ...[...kept, ...rest].slice(0, max)], total: ids.length };
}
function taskRequestText(title, description, note) {
  return [title, description, note].map((s) => String(s || '').trim()).filter(Boolean).join('\n\n');
}

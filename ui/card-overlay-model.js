// Pure rules for the card overlay (Trello's "back of card"); also exercised by the Node tests.
// A card is shown on its own layer above the board. Its width and height are kept per kind of card —
// "session" and "task" — and shared by every card of that kind.
const CARD_KINDS = ['session', 'task'];
const CARD_WIDTH_DEF = { session: 1000, task: 760 };
const CARD_WIDTH_MIN = 560, CARD_WIDTH_MAX = 1600;
const CARD_HEIGHT_DEF = { session: 860, task: 860 };
const CARD_HEIGHT_MIN = 320, CARD_HEIGHT_MAX = 1600;
const TASK_SESSIONS_MAX = 8;
// The card board's margins follow the window: a slim one on the left, the key guide's on the right.
// Nothing here is saved; the card itself is what the user sizes.
function cardBoardGeometry(width) {
  const w = Math.max(1, width);
  const minStage = Math.min(360, w * .55), legend = Math.min(216, w * .32), margin = Math.min(Math.max(24, w * .06), w * .08);
  const left = Math.round(Math.min(margin, w - minStage - legend));
  const right = Math.round(Math.max(0, Math.min(legend, w - minStage - left)));
  return { left, right, width: w - left - right };
}
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
function normalizeCardHeights(value) {
  return Object.fromEntries(CARD_KINDS.map(kind => {
    const v = value?.[kind];
    return [kind, typeof v === 'number' && Number.isFinite(v) ? Math.min(CARD_HEIGHT_MAX, Math.max(CARD_HEIGHT_MIN, Math.round(v))) : CARD_HEIGHT_DEF[kind]];
  }));
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
// The card to open when j / k step through the cards on the board (in the order they are shown). The ends do not wrap around.
function neighborCardId(ids, current, step) {
  const i = ids.indexOf(current);
  return i < 0 ? null : ids[i + step] ?? null;
}

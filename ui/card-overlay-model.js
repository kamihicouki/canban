// Pure rules for the card overlay (Trello's "back of card"); also exercised by the Node tests.
// A card is shown on its own layer above the board. Its width and height are kept per kind of card —
// "session" and "task" — and shared by every card of that kind.
const CARD_KINDS = ['session', 'task'];
const CARD_WIDTH_DEF = { session: 1000, task: 760 };
const CARD_WIDTH_MIN = 560, CARD_WIDTH_MAX = 1600;
const CARD_HEIGHT_DEF = { session: 860, task: 860 };
const CARD_HEIGHT_MIN = 320, CARD_HEIGHT_MAX = 1600;
const TASK_SESSIONS_MAX = 8;
// The card board's margins follow the window: a slim one on each side, and room for the key guide where it is
// docked (`reserve`: the width it needs on the left or right; the right by default). Nothing here is saved.
function cardBoardGeometry(width, reserve = {}) {
  const w = Math.max(1, width);
  const want = { left: Math.max(0, reserve.left ?? 0), right: Math.max(0, reserve.right ?? KEY_GUIDE_ROOM) };
  const minStage = Math.min(360, w * .55), margin = Math.min(Math.max(24, w * .06), w * .08);
  const legendL = Math.min(want.left, w * .32), legendR = Math.min(want.right, w * .32);
  const left = Math.round(Math.max(0, Math.min(Math.max(margin, legendL), w - minStage - legendR)));
  const right = Math.round(Math.max(0, Math.min(want.right ? legendR : margin, w - minStage - left)));
  return { left, right, width: w - left - right };
}
// The key guide: one panel on every screen, docked at a corner of the stage or as a strip along its foot.
// Where it sits is shared UI state ('keyGuide'); folded, it is only its title and takes no room.
const KEY_GUIDE_DOCKS = ['tr', 'br', 'bottom', 'bl']; // clockwise: the arrows on its title walk this ring
const KEY_GUIDE_DEF = { dock: 'bottom', min: false };
const KEY_GUIDE_WIDTH = 200, KEY_GUIDE_ROOM = 216;
function normalizeKeyGuide(value) {
  return { dock: KEY_GUIDE_DOCKS.includes(value?.dock) ? value.dock : KEY_GUIDE_DEF.dock, min: value?.min === true };
}
// Where a guide dropped at (x, y) — fractions of the stage — lands: the strip in the middle of the foot,
// else the nearest corner. The top left belongs to the navigation and the ribbon, so the top is always the right.
function keyGuideDockAt(x, y) {
  if (y > .8 && x > .25 && x < .75) return 'bottom';
  if (y < .5) return 'tr';
  return x < .5 ? 'bl' : 'br';
}
function keyGuideStep(dock, step) {
  const i = Math.max(0, KEY_GUIDE_DOCKS.indexOf(dock));
  return KEY_GUIDE_DOCKS[(i + step + KEY_GUIDE_DOCKS.length) % KEY_GUIDE_DOCKS.length];
}
// Analytics and Agent Usage open on the same layer as sheets, under ids of their own ("view:analytics").
const VIEW_SHEETS = { analytics: ['chart', '分析'], usage: ['gauge', 'Agent Usage'], orbit: ['refresh', '軌道'] };
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

// Pure rules for the card overlay (Trello's "back of card"); also exercised by the Node tests.
// A card is shown on its own layer above the board. Layout (section order, heights, column ratio)
// and width are kept per kind of card — "session" and "task" — and shared by every card of that kind.
const CARD_KINDS = ['session', 'task'];
const CARD_WIDTH_DEF = { session: 1000, task: 760 };
const CARD_WIDTH_MIN = 560, CARD_WIDTH_MAX = 1600;
const CARD_HEIGHT_DEF = { session: 860, task: 860 };
const CARD_HEIGHT_MIN = 320, CARD_HEIGHT_MAX = 1600;
const TASK_SESSIONS_MAX = 8;
const CARD_BOARD_DEF = { left: .1, right: .1, shortcut: { side: 'right', x: 0, y: .1 } };
const cardBoardClamp = (n, min, max) => Math.min(max, Math.max(min, n));
function normalizeCardBoard(value) {
  const number = (n, fallback, min, max) => typeof n === 'number' && Number.isFinite(n) ? cardBoardClamp(n, min, max) : fallback;
  let left = number(value?.left, .1, .02, .4), right = number(value?.right, .1, .02, .4);
  if (left + right > .65) { const scale = .65 / (left + right); left *= scale; right *= scale; }
  return { left, right, shortcut: { side: value?.shortcut?.side === 'left' ? 'left' : 'right',
    x: number(value?.shortcut?.x, 0, 0, 1), y: number(value?.shortcut?.y, .1, 0, 1) } };
}
// Keep a usable card viewport and readable key labels even when the window shrinks.
// These are display bounds; resizing a window never overwrites the saved ratios.
function cardBoardGeometry(value, width) {
  const board = normalizeCardBoard(value), w = Math.max(1, width);
  const minStage = Math.min(360, w * .55), legend = Math.min(216, w * .32), margin = Math.min(24, w * .08);
  const minLeft = board.shortcut.side === 'left' ? legend : margin;
  const minRight = board.shortcut.side === 'right' ? legend : margin;
  const left = cardBoardClamp(w * board.left, minLeft, w - minStage - minRight);
  const right = cardBoardClamp(w * board.right, minRight, w - minStage - left);
  return { left, right, width: w - left - right };
}
function fitShortcutMap(gutter, size, position) {
  const pad = 8;
  // Anchor the map's top-left to the gutter, independently of the number of hint rows.
  return { x: gutter.left + cardBoardClamp(gutter.width * position.x, pad, Math.max(pad, gutter.width - size.width - pad)),
    y: cardBoardClamp(gutter.height * position.y, pad, Math.max(pad, gutter.height - size.height - pad)) };
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
function taskCardLayoutDefaults() {
  return { main: ['conv', 'send', 'memo'], ratio: .6, heights: { conv: 160, send: 320, memo: 120 } };
}
function normalizeCardLayouts(value, defaults, heightDefaults) {
  const legacyMain = ['conv', 'progress', 'send', 'labels', 'memo', 'detail', 'pr', 'related', 'first'];
  const legacySide = ['resume', 'task', 'add', 'prio', 'other'];
  const legacyHeights = { conv: 180, progress: 64, send: 360, labels: 84, memo: 150, detail: 320, pr: 180, related: 180, first: 150, resume: 290, task: 110, add: 130, prio: 130, other: 190 };
  const identity = ['breadcrumb', 'title', 'status'].filter(id => defaults.side.includes(id));
  const result = {};
  for (const kind of CARD_KINDS) {
    let stored = value?.[kind];
    const oldMain = kind === 'task' ? ['conv', 'memo', 'related', 'send', ...legacyMain.filter(id => !['conv', 'memo', 'related', 'send'].includes(id))] : legacyMain;
    const oldHeights = kind === 'task' ? { ...legacyHeights, conv: 110, memo: 120, related: 110 } : legacyHeights;
    // Only untouched legacy defaults migrate. User arrangements, sizes and collapsed sections survive.
    const untouched = stored && JSON.stringify(stored.main) === JSON.stringify(oldMain) && JSON.stringify(stored.side) === JSON.stringify(legacySide)
      && !stored.collapsed?.length && (stored.ratio == null || stored.ratio === 2 / 3)
      && Object.entries(stored.heights || {}).every(([id, height]) => oldHeights[id] === height);
    if (untouched) stored = null;
    if (stored && ![...(stored.main || []), ...(stored.side || [])].some(id => identity.includes(id)))
      stored = { ...stored, side: [...identity, ...(stored.side || [])] };
    if (stored && defaults.side.includes('actions') && ![...(stored.main || []), ...(stored.side || [])].includes('actions')) {
      const side = [...(stored.side || [])], at = side.indexOf('status');
      side.splice(at < 0 ? 0 : at + 1, 0, 'actions');
      stored = { ...stored, side };
    }
    const seed = kind === 'task' ? { ...defaults, ...taskCardLayoutDefaults(), collapsed: ['memo', 'other'].filter(id => [...defaults.main, ...defaults.side].includes(id)) } : defaults;
    result[kind] = normalizePaneLayout(stored ?? seed, defaults, { ...heightDefaults, ...(kind === 'task' ? taskCardLayoutDefaults().heights : {}) });
  }
  return result;
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

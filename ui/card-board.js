// The card board owns its viewport margins and the stationary shortcut map.
let cardBoardState = normalizeCardBoard(store.get('cardBoard', null));
const cardBoard = h('div', { class: 'card-board', 'aria-label': 'カードボード' });
const paneViewport = h('div', { class: 'card-board-viewport' });
const cardBoardEnd = h('span', { class: 'card-board-end', 'aria-hidden': 'true' });
const shortcutMap = h('aside', { class: 'shortcut-map', 'aria-label': 'ショートカットマップ' });
const shortcutMapGrip = h('button', { class: 'shortcut-map-grip', type: 'button',
  'aria-label': 'ショートカットマップを移動', title: 'ドラッグまたは矢印キーで余白内を移動。Alt+←→で左右を切替、Homeで初期位置',
  html: `${picon('grip', 12)}<span>キーの案内</span>` });
const paneHints = h('div', { class: 'pb-hint shortcut-hints', 'aria-label': 'この画面のキー' });
shortcutMap.append(shortcutMapGrip, paneHints);
paneViewport.append(paneStage);
const cardBoardHandles = {};
for (const side of ['left', 'right']) {
  const handle = h('div', { class: `card-board-margin ${side}`, role: 'separator', tabindex: 0,
    'aria-orientation': 'vertical', 'aria-label': `カードボードの${side === 'left' ? '左' : '右'}余白`,
    'aria-valuemin': 2, 'aria-valuemax': 40, title: '左右にドラッグして余白を調整。←→キーでも変更、Homeで10%に戻す',
    html: picon('grip', 14) });
  cardBoardHandles[side] = handle;
  handle.addEventListener('keydown', e => {
    if (e.isComposing || !['ArrowLeft', 'ArrowRight', 'Home'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    const direction = side === 'left' ? 1 : -1;
    const delta = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 2 : 12) * direction;
    resizeCardBoardMargin(side, e.key === 'Home' ? .1 : cardBoardState[side] + delta / cardBoard.clientWidth, true);
  });
  cardBoardDrag(handle, e => {
    const bounds = cardBoard.getBoundingClientRect();
    resizeCardBoardMargin(side, (side === 'left' ? e.clientX - bounds.left : bounds.right - e.clientX) / bounds.width);
  });
}
cardBoard.append(paneViewport, ...Object.values(cardBoardHandles), shortcutMap);
paneLayer.append(paneBar, cardBoard);
// Alt keeps the established [ / ] pane navigation and m list action available.
// Use physical codes as well as keys because Option changes characters on macOS.
function handleCardBoardKey(e) {
  if (paneLayer.hidden || e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.metaKey || e.ctrlKey || typingIn(e.target) || document.querySelector('.popover, dialog[open]')) return;
  let run;
  if (e.altKey && !e.shiftKey) {
    if (e.code === 'BracketLeft' || e.key === '[') run = () => cardBoardHandles.left.focus();
    else if (e.code === 'BracketRight' || e.key === ']') run = () => cardBoardHandles.right.focus();
    else if (e.code === 'KeyM' || e.key === 'm') run = () => shortcutMapGrip.focus();
  } else if (!e.altKey && !e.shiftKey && e.key === '0') run = resetCardBoard;
  if (run) { e.preventDefault(); run(); }
}
document.addEventListener('keydown', handleCardBoardKey);
const saveCardBoard = () => store.set('cardBoard', structuredClone(cardBoardState));
function cardBoardGutter(side) {
  const geometry = cardBoardGeometry(cardBoardState, cardBoard.clientWidth);
  return { left: side === 'left' ? 0 : cardBoard.clientWidth - geometry.right,
    width: geometry[side], height: cardBoard.clientHeight };
}
function positionShortcutMap() {
  if (paneLayer.hidden || shortcutMap.hidden) return;
  const gutter = cardBoardGutter(cardBoardState.shortcut.side);
  // Reserve the full legend's footprint so focusing the grip or a text field never
  // shifts its heading, including when the map is placed near the bottom edge.
  shortcutMap.style.width = `${Math.min(136, Math.max(0, gutter.width - 16))}px`;
  shortcutMap.style.height = `${Math.min(352, Math.max(0, gutter.height - 16))}px`;
  const point = fitShortcutMap(gutter, { width: shortcutMap.offsetWidth, height: shortcutMap.offsetHeight }, cardBoardState.shortcut);
  shortcutMap.style.left = `${point.x}px`; shortcutMap.style.top = `${point.y}px`;
  shortcutMap.dataset.side = cardBoardState.shortcut.side;
}
function layoutCardBoard() {
  if (paneLayer.hidden) return;
  const geometry = cardBoardGeometry(cardBoardState, cardBoard.clientWidth);
  paneLayer.style.setProperty('--gutter-left', `${geometry.left}px`);
  paneLayer.style.setProperty('--gutter-right', `${geometry.right}px`);
  paneLayer.style.setProperty('--card-board-width', `${geometry.width}px`);
  for (const side of ['left', 'right']) {
    const percent = Math.round(geometry[side] / cardBoard.clientWidth * 100);
    cardBoardHandles[side].setAttribute('aria-valuenow', percent);
    cardBoardHandles[side].setAttribute('aria-valuetext', `${percent}%`);
  }
  paneLayer.classList.toggle('stack', geometry.width < 720);
  positionShortcutMap();
}
function resizeCardBoardMargin(side, ratio, save = false) {
  // Clamp only the dragged boundary: the opposite margin remains in place.
  const other = side === 'left' ? 'right' : 'left';
  cardBoardState[side] = cardBoardClamp(ratio, .02, Math.min(.4, .65 - cardBoardState[other]));
  const geometry = cardBoardGeometry(cardBoardState, cardBoard.clientWidth);
  cardBoardState[side] = geometry[side] / cardBoard.clientWidth;
  layoutCardBoard();
  if (save) saveCardBoard();
}
function resetCardBoard() {
  cardBoardState = normalizeCardBoard(null); layoutCardBoard(); saveCardBoard();
  toast('カードボードの余白とキー案内を初期化しました');
}
// Pointer capture keeps the gesture alive outside a grip without involving backdrop clicks.
function cardBoardDrag(handle, move, start = () => {}) {
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !e.isPrimary) return;
    e.preventDefault(); e.stopPropagation(); handle.focus({ preventScroll: true });
    handle.setPointerCapture(e.pointerId);
    start(e);
    const onMove = ev => { if (ev.pointerId === e.pointerId) move(ev); };
    const end = ev => {
      if (ev.pointerId !== e.pointerId) return;
      handle.removeEventListener('pointermove', onMove); handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end); handle.removeEventListener('lostpointercapture', end);
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      saveCardBoard();
    };
    handle.addEventListener('pointermove', onMove); handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end); handle.addEventListener('lostpointercapture', end);
  });
}
let shortcutDragOffset;
cardBoardDrag(shortcutMapGrip, e => {
  const bounds = cardBoard.getBoundingClientRect();
  const x = e.clientX - bounds.left, y = e.clientY - bounds.top;
  const geometry = cardBoardGeometry(cardBoardState, bounds.width);
  if (x < geometry.left) cardBoardState.shortcut.side = 'left';
  else if (x > bounds.width - geometry.right) cardBoardState.shortcut.side = 'right';
  layoutCardBoard();
  const gutter = cardBoardGutter(cardBoardState.shortcut.side);
  cardBoardState.shortcut.x = cardBoardClamp((x - gutter.left - shortcutDragOffset.x) / gutter.width, 0, 1);
  cardBoardState.shortcut.y = cardBoardClamp((y - shortcutDragOffset.y) / gutter.height, 0, 1);
  positionShortcutMap();
}, e => {
  const map = shortcutMap.getBoundingClientRect();
  shortcutDragOffset = { x: e.clientX - map.left, y: e.clientY - map.top };
});
shortcutMapGrip.addEventListener('keydown', e => {
  if (e.isComposing || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(e.key)) return;
  e.preventDefault(); e.stopPropagation();
  const position = cardBoardState.shortcut;
  if (e.key === 'Home') Object.assign(position, CARD_BOARD_DEF.shortcut);
  else if (e.altKey && ['ArrowLeft', 'ArrowRight'].includes(e.key)) position.side = e.key === 'ArrowLeft' ? 'left' : 'right';
  else {
    const gutter = cardBoardGutter(position.side), delta = e.shiftKey ? 2 : 12;
    const axis = ['ArrowLeft', 'ArrowRight'].includes(e.key) ? 'x' : 'y';
    const range = axis === 'x' ? gutter.width : gutter.height;
    const point = fitShortcutMap(gutter, { width: shortcutMap.offsetWidth, height: shortcutMap.offsetHeight }, position);
    const current = axis === 'x' ? point.x - gutter.left : point.y;
    position[axis] = cardBoardClamp((current + (['ArrowLeft', 'ArrowUp'].includes(e.key) ? -delta : delta)) / Math.max(1, range), 0, 1);
  }
  layoutCardBoard(); saveCardBoard();
});
new ResizeObserver(positionShortcutMap).observe(shortcutMap);
new IntersectionObserver(([end]) => paneStage.classList.toggle('can-scroll-right', !end.isIntersecting),
  { root: paneStage, threshold: 1 }).observe(cardBoardEnd);

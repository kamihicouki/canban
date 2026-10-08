// The card board: the cards in the middle, the keys for this screen in the right margin. Both are fixed:
// the margins follow the window, and the key guide sits at the top of the right margin on a panel of its own,
// so it stays readable over whatever board is behind it.
const cardBoard = h('div', { class: 'card-board', 'aria-label': 'カードボード' });
const paneViewport = h('div', { class: 'card-board-viewport' });
const cardBoardEnd = h('span', { class: 'card-board-end', 'aria-hidden': 'true' });
const shortcutMap = h('aside', { class: 'shortcut-map', 'aria-label': 'キーの案内' });
const paneHints = h('div', { class: 'pb-hint shortcut-hints', 'aria-label': 'この画面のキー' });
shortcutMap.append(h('div', { class: 'shortcut-map-title', text: 'キーの案内' }), paneHints);
paneViewport.append(paneStage);
cardBoard.append(paneViewport, shortcutMap);
paneLayer.append(paneBar, cardBoard);
function positionShortcutMap() {
  if (paneLayer.hidden || shortcutMap.hidden) return;
  const { right } = cardBoardGeometry(cardBoard.clientWidth);
  shortcutMap.hidden = right < 120; // too narrow to read: the ? list still has every key
  shortcutMap.style.width = `${Math.min(240, Math.max(0, right - 16))}px`;
  shortcutMap.style.maxHeight = `${Math.max(0, cardBoard.clientHeight - 32)}px`;
}
function layoutCardBoard() {
  if (paneLayer.hidden) return;
  const geometry = cardBoardGeometry(cardBoard.clientWidth);
  paneLayer.style.setProperty('--gutter-left', `${geometry.left}px`);
  paneLayer.style.setProperty('--gutter-right', `${geometry.right}px`);
  paneLayer.style.setProperty('--card-board-width', `${geometry.width}px`);
  paneLayer.classList.toggle('stack', geometry.width < 720);
  positionShortcutMap();
}
new ResizeObserver(layoutCardBoard).observe(cardBoard);
new IntersectionObserver(([end]) => paneStage.classList.toggle('can-scroll-right', !end.isIntersecting),
  { root: paneStage, threshold: 1 }).observe(cardBoardEnd);

// The card board: the cards in the middle. The key guide (key-guide.js) floats over it and takes no room.
// The margins follow the window. Docked on the 時間軸, the board is the right side of the timeline instead.
const cardBoard = h('div', { class: 'card-board', 'aria-label': 'カードボード' });
const paneViewport = h('div', { class: 'card-board-viewport' });
const cardBoardEnd = h('span', { class: 'card-board-end', 'aria-hidden': 'true' });
paneViewport.append(paneStage);
cardBoard.append(paneViewport);
paneLayer.append(paneBar, cardBoard);
function layoutCardBoard() {
  if (paneLayer.hidden) return;
  const docked = paneDocked();
  const geometry = exchangeTrail && !docked ? { left: 12, right: 12, width: Math.max(1, cardBoard.clientWidth - 24) } : docked ? { left: 0, right: 0, width: cardBoard.clientWidth } : cardBoardGeometry(cardBoard.clientWidth, keyGuideReserve());
  paneLayer.style.setProperty('--gutter-left', `${geometry.left}px`);
  paneLayer.style.setProperty('--gutter-right', `${geometry.right}px`);
  paneLayer.style.setProperty('--card-board-width', `${geometry.width}px`);
  paneLayer.classList.toggle('stack', geometry.width < 720);
}
new ResizeObserver(layoutCardBoard).observe(cardBoard);
new IntersectionObserver(([end]) => paneStage.classList.toggle('can-scroll-right', !end.isIntersecting),
  { root: paneStage, threshold: 1 }).observe(cardBoardEnd);

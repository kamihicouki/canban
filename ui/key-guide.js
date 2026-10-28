// Part of board.html: included into its script by server/ui.mjs and shares its scope.
// The key guide: one panel for the board, the 時間軸 and an open card. Only what it lists changes with the focus
// (refreshShortcutHints in keyboard.js). It docks at a corner of the stage or as a strip along its foot: drag its
// title there, or use the arrow keys on it; – folds it to its title. It floats over the board and takes no room.
let keyGuidePlace = normalizeKeyGuide(store.get('keyGuide', null));
const keyGuideKeys = h('div', { class: 'kg-keys shortcut-hints', 'aria-label': 'この画面のキー' });
const keyGuideFold = h('button', { class: 'kg-fold', type: 'button' });
const keyGuideHead = h('div', { class: 'kg-head', tabindex: 0, title: 'ドラッグして置き場所を変える（矢印キーでも移動）',
  'aria-label': 'キーの案内の置き場所（ドラッグまたは矢印キーで移動）', 'aria-roledescription': '移動できる見出し' },
  h('span', { class: 'kg-grip', html: picon('grip', 12) }), h('span', { class: 'kg-title', text: 'キーの案内' }), keyGuideFold);
const keyGuide = h('aside', { class: 'key-guide', 'aria-label': 'キーの案内' }, keyGuideHead, keyGuideKeys);
const keyGuideZones = h('div', { class: 'kg-zones', hidden: true, 'aria-hidden': 'true' },
  ...KEY_GUIDE_DOCKS.map((dock) => h('div', { class: 'kg-zone', 'data-dock': dock, text: { tr: '右上', br: '右下', bottom: '下端', bl: '左下' }[dock] })));
document.body.append(keyGuideZones, keyGuide);

function setKeyGuidePlace(next) {
  keyGuidePlace = normalizeKeyGuide({ ...keyGuidePlace, ...next });
  store.set('keyGuide', keyGuidePlace);
  placeKeyGuide();
}
// The guide floats over the stage like a hover: it takes no room, so showing, hiding, folding or moving it
// never shifts a card (cardBoardGeometry keeps only its own margins).
const keyGuideReserve = () => ({ left: 0, right: 0 });
const stageRect = () => ($('.stage')?.getBoundingClientRect() || { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight });
function placeKeyGuide() {
  const r = stageRect(), { dock, min } = keyGuidePlace, gap = 8;
  keyGuide.dataset.dock = dock;
  keyGuide.dataset.min = String(min);
  keyGuideFold.textContent = min ? '+' : '–';
  keyGuideFold.title = min ? 'キーの案内を開く' : 'キーの案内を畳む';
  keyGuideFold.setAttribute('aria-label', keyGuideFold.title);
  keyGuideFold.setAttribute('aria-expanded', String(!min));
  const s = keyGuide.style;
  s.top = s.bottom = s.left = s.right = s.width = s.transform = '';
  s.maxHeight = `${Math.max(60, r.height - gap * 2)}px`;
  if (dock === 'tr' || dock === 'br') s.right = `${Math.round(innerWidth - r.right + gap)}px`;
  if (dock === 'bl') s.left = `${Math.round(r.left + gap)}px`;
  if (dock === 'tr') s.top = `${Math.round(r.top + gap)}px`;
  else s.bottom = `${Math.round(innerHeight - r.bottom + gap)}px`;
  if (dock === 'bottom') { s.left = `${Math.round(r.left + r.width / 2)}px`; s.transform = 'translateX(-50%)'; s.maxWidth = `${Math.max(120, r.width - gap * 2)}px`; }
  else s.maxWidth = '';
  markKeyGuideFoot();
}
// Along the foot the strip covers the end of what scrolls down to it (the detail panel d). Those scrollers end with
// --kg-foot of room, so their last row scrolls clear of it; nothing moves. A guide hidden under a dialog keeps its room.
let keyGuideFootH = 0;
function markKeyGuideFoot() {
  const strip = keyGuidePlace.dock === 'bottom' && !keyGuidePlace.min;
  if (strip && !keyGuide.hidden) keyGuideFootH = Math.max(0, Math.ceil(innerHeight - keyGuide.getBoundingClientRect().top));
  document.documentElement.style.setProperty('--kg-foot', `${strip ? keyGuideFootH : 0}px`);
}
keyGuideFold.addEventListener('click', (e) => { e.stopPropagation(); setKeyGuidePlace({ min: !keyGuidePlace.min }); });
keyGuideHead.addEventListener('keydown', (e) => {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); setKeyGuidePlace({ dock: KEY_GUIDE_DEF.dock }); }
  else if (step && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); setKeyGuidePlace({ dock: keyGuideStep(keyGuidePlace.dock, step) }); }
  else if ((e.key === 'Enter' || e.key === ' ') && e.target === keyGuideHead) { e.preventDefault(); e.stopPropagation(); setKeyGuidePlace({ min: !keyGuidePlace.min }); }
});
keyGuideHead.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('button')) return;
  e.preventDefault();
  const box = keyGuide.getBoundingClientRect(), r = stageRect(), dx = e.clientX - box.left, dy = e.clientY - box.top;
  const dockAt = (ev) => keyGuideDockAt((ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height);
  keyGuideHead.setPointerCapture(e.pointerId);
  keyGuide.classList.add('dragging');
  for (const zone of $$('.kg-zone', keyGuideZones)) placeKeyGuideZone(zone, r);
  keyGuideZones.hidden = false;
  Object.assign(keyGuide.style, { width: `${box.width}px`, transform: 'none', right: 'auto', bottom: 'auto', left: `${box.left}px`, top: `${box.top}px` });
  const move = (ev) => {
    keyGuide.style.left = `${ev.clientX - dx}px`; keyGuide.style.top = `${ev.clientY - dy}px`;
    const dock = dockAt(ev);
    for (const zone of $$('.kg-zone', keyGuideZones)) zone.classList.toggle('hot', zone.dataset.dock === dock);
  };
  const end = (ev) => {
    keyGuideHead.removeEventListener('pointermove', move); keyGuideHead.removeEventListener('pointerup', end); keyGuideHead.removeEventListener('pointercancel', end);
    keyGuide.classList.remove('dragging');
    keyGuideZones.hidden = true;
    setKeyGuidePlace(ev.type === 'pointerup' ? { dock: dockAt(ev) } : {});
  };
  keyGuideHead.addEventListener('pointermove', move); keyGuideHead.addEventListener('pointerup', end); keyGuideHead.addEventListener('pointercancel', end);
});
function placeKeyGuideZone(zone, r) {
  const gap = 8, w = KEY_GUIDE_WIDTH, h = Math.min(160, r.height / 3), s = zone.style;
  const box = {
    tr: [r.right - gap - w, r.top + gap, w, h], br: [r.right - gap - w, r.bottom - gap - h, w, h], bl: [r.left + gap, r.bottom - gap - h, w, h],
    bottom: [r.left + r.width * .25, r.bottom - gap - 40, r.width * .5, 40],
  }[zone.dataset.dock];
  Object.assign(s, { left: `${box[0]}px`, top: `${box[1]}px`, width: `${box[2]}px`, height: `${box[3]}px` });
}
// What the guide lists. Nothing to show (a dialog or a popover is on top) hides it.
function paintKeyGuide(entries) {
  keyGuide.hidden = !entries.length;
  keyGuideKeys.replaceChildren(...shortcutHints(entries).childNodes);
  placeKeyGuide();
}
new ResizeObserver(() => placeKeyGuide()).observe(document.body);
requestAnimationFrame(() => { const stage = $('.stage'); if (stage) new ResizeObserver(() => placeKeyGuide()).observe(stage); });

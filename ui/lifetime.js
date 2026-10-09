// Lifetime on the board (ui/lifetime-model.js). Included into board.html's script (shares its scope).
//   time ribbon   the board's period as one bar per day over the board. Hover or pick a day (or a phase)
//                 and the board lights the cards of that time; the period buttons sit at its end.
//   dormant fold  cards with no movement for a week fold at the foot of their list, one line each.
//   時間軸         the board by time instead of by list (`i`): needs you, running, today, yesterday, …
const RIBBON_DAYS_ALL = 90;
const PERIODS = [[7, '7日'], [30, '30日'], [90, '90日'], [0, '全期間']];
state.view = store.get('boardView', 'board') === 'timeline' ? 'timeline' : 'board';
state.lens = null;        // { day } or { life }: what the board lights, pinned by a click
state.lensPreview = null; // the same while the pointer rests on the ribbon
state.wake = new Set(store.get('wakeLists', [])); // folds that are open (list id, or lane + list id)

const timelineOn = () => state.view === 'timeline';
function setBoardView(view) {
  state.view = view === 'timeline' ? 'timeline' : 'board';
  store.set('boardView', state.view);
  if (workspace.utilityPage()) workspace.navigate('home', { reload: false });
  if (state.board) render();
}
const toggleBoardView = () => setBoardView(timelineOn() ? 'board' : 'timeline');

// ---- the view switch in the app bar: one control, the key beside it ----
function renderViewSwitch() {
  const el = $('#viewSwitch');
  if (!el) return;
  el.replaceChildren(...[['board', 'board', 'ボード'], ['timeline', 'clock', '時間軸']].map(([v, icon, label]) =>
    h('button', { type: 'button', 'aria-pressed': String(state.view === v), 'aria-label': label, title: `${label}（i で切り替え）`, onclick: () => setBoardView(v) },
      h('span', { html: picon(icon, 15) }), state.view === v ? h('span', { class: 'lbl', text: label }) : null)), ...keycap('i'));
  fitHeader(); // the switch changed width: the app bar may need to give way again
}

// ---- the ribbon ----
const lensActive = () => state.lensPreview || state.lens;
// The period's days; over the whole period, as many as the oldest card needs (two weeks to three months).
function ribbonDays(cards = []) {
  const days = Number(state.filters.days);
  if (days) return days;
  const oldest = cards.reduce((m, c) => Math.max(m, Math.min(daysAgo(c.updatedAt), RIBBON_DAYS_ALL - 1)), 0);
  return Math.max(14, oldest + 1);
}
function dayLabel(i) {
  if (i === 0) return '今日';
  if (i === 1) return '昨日';
  const d = new Date(Date.now() - i * DAY_MS);
  return d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' });
}
function renderRibbon(b) {
  const el = $('#ribbon');
  if (!el) return;
  const cards = b.lists.flatMap((l) => l.cards);
  const days = ribbonDays(cards);
  const counts = dayHistogram(cards, days);
  const max = Math.max(1, ...counts);
  const lens = state.lens;
  const life = { live: 0, fresh: 0, active: 0, dormant: 0 };
  for (const c of cards) life[lifeOf(c)]++;
  const phases = h('div', { class: 'rb-phases', role: 'group', 'aria-label': 'カードの寿命' }, Object.entries(LIFE_LABELS).map(([k, label]) =>
    h('button', { type: 'button', class: `rb-phase life-${k}`, 'aria-pressed': String(lens?.life === k), title: `${label}のカードを照らす（もう一度で解除）`,
      onpointerenter: () => previewLens({ life: k }), onpointerleave: () => previewLens(null), onfocus: () => previewLens({ life: k }), onblur: () => previewLens(null),
      onclick: () => pinLens(lens?.life === k ? null : { life: k }) },
      h('i'), h('span', { text: label }), h('b', { class: 'num', text: String(life[k]) }))));
  // Oldest day on the left, today on the right; one button per day with a roving tab stop.
  const focusDay = lens?.day ?? 0;
  const bars = h('div', { class: 'rb-bars', role: 'group', 'aria-label': `日ごとのカード（${days} 日）`, style: { '--days': days } });
  for (let i = days - 1; i >= 0; i--) {
    const n = counts[i];
    bars.append(h('button', { type: 'button', class: `rb-day${i >= DORMANT_MS / DAY_MS ? ' is-dormant' : ''}${i === 0 ? ' is-today' : ''}${n ? '' : ' is-empty'}`, 'data-day': i,
      tabindex: i === focusDay ? 0 : -1, 'aria-pressed': String(lens?.day === i), 'aria-label': `${dayLabel(i)} ${n} 件`, title: `${dayLabel(i)} · ${n} 件`,
      style: { '--h': n ? Math.max(0.12, Math.sqrt(n / max)).toFixed(3) : 0 },
      onpointerenter: () => previewLens({ day: i }), onfocus: () => previewLens({ day: i }), onblur: () => previewLens(null),
      onclick: () => pinLens(lens?.day === i ? null : { day: i }) }, h('i')));
  }
  bars.addEventListener('pointerleave', () => previewLens(null));
  bars.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: 1, ArrowRight: -1, Home: days - 1, End: -days }[e.key];
    if (step == null) return;
    e.preventDefault();
    const cur = Number(document.activeElement?.dataset.day ?? 0);
    const next = Math.max(0, Math.min(days - 1, e.key === 'Home' ? days - 1 : e.key === 'End' ? 0 : cur + step));
    const btn = bars.querySelector(`[data-day="${next}"]`);
    for (const x of bars.children) x.tabIndex = -1;
    btn.tabIndex = 0;
    btn.focus();
  });
  // The week line: left of it, cards fold as dormant.
  const weekAt = Math.min(days, DORMANT_MS / DAY_MS);
  const marks = h('div', { class: 'rb-marks', 'aria-hidden': 'true' },
    weekAt < days ? h('span', { class: 'rb-week', style: { right: `${(weekAt / days) * 100}%` }, text: '← 休眠' }) : null,
    days > 30 ? h('span', { class: 'rb-mark', style: { right: `${(30 / days) * 100}%` }, text: '30日' }) : null,
    h('span', { class: 'rb-mark rb-today', text: '今日' }));
  const period = h('div', { class: 'rb-period', role: 'group', 'aria-label': '期間' }, PERIODS.map(([k, label]) =>
    h('button', { type: 'button', 'aria-pressed': String(Number(state.filters.days) === k), title: k ? `${k} 日以内に動いたカード（置いたカードは残ります）` : 'すべての期間', text: label,
      onclick: () => setScope({ days: k }) })));
  const legend = lensActive() ? h('button', { type: 'button', class: 'rb-clear', title: '照らすのをやめる（Esc）', onclick: () => pinLens(null) }, lensText(lensActive()), h('span', { class: 'x', text: '✕' })) : null;
  el.replaceChildren(...[phases, h('div', { class: 'rb-track' }, bars, marks), legend, period].filter(Boolean));
}
function lensText(lens) {
  if (!lens) return '';
  if (lens.life) return `${LIFE_LABELS[lens.life]}を照らしています`;
  return `${dayLabel(lens.day)}に動いたカード`;
}
function previewLens(lens) {
  state.lensPreview = lens;
  applyLens();
}
function pinLens(lens) {
  state.lens = lens;
  state.lensPreview = null;
  if (state.board) renderRibbon(state.board);
  applyLens();
}
const lensHits = (el, lens) => (lens.life ? el.dataset.life === lens.life : Number(el.dataset.day) === lens.day);
// Light the cards of the chosen time; dim the rest. A fold says how many of its cards match.
function applyLens() {
  const lens = lensActive();
  const root = $('#board');
  root.classList.toggle('lens-on', !!lens);
  for (const el of root.querySelectorAll('.card[data-card-id]')) el.classList.toggle('lens-hit', !!lens && lensHits(el, lens));
  for (const fold of root.querySelectorAll('.life-fold')) {
    const hits = lens ? (fold._cards || []).filter((c) => (lens.life ? lens.life === 'dormant' : daysAgo(c.updatedAt) === lens.day)).length : 0;
    fold.classList.toggle('lens-hit', hits > 0);
    const badge = fold.querySelector('.fold-hits');
    if (badge) badge.textContent = hits ? `該当 ${hits}` : '';
  }
  const legend = $('#ribbon .rb-clear');
  if (lens && !legend && state.board) renderRibbon(state.board);
  else if (legend) legend.firstChild.textContent = lensText(lens);
}

// ---- the dormant fold at the foot of a list ----
const foldKey = (list, lane) => (lane ? `${lane.key}\u0000${list.id}` : list.id);
function dormantFold(list, cards, lane) {
  const key = foldKey(list, lane), open = state.wake.has(key);
  const fold = h('div', { class: `life-fold${open ? ' open' : ''}` });
  fold._cards = cards;
  const toggle = () => {
    if (state.wake.has(key)) state.wake.delete(key); else state.wake.add(key);
    store.set('wakeLists', [...state.wake]);
    render();
  };
  fold.append(h('button', { type: 'button', class: 'fold-head', 'aria-expanded': String(open), title: '7 日以上動きのないカード。動きがあれば自動で上に戻ります', onclick: toggle },
    h('span', { html: picon('moon', 14) }), h('span', { class: 'fold-n', text: `休眠中 ${cards.length}` }), h('span', { class: 'fold-hits' }),
    h('span', { class: 'grow' }), h('span', { class: 'fold-why', text: '7日以上動きなし' }), h('span', { class: 'fold-chev', html: picon('chev', 14) })));
  if (open) {
    const body = h('div', { class: 'fold-body', 'data-list-id': list.id });
    const n = state.shown[`${key}:dormant`] || PAGE;
    for (const card of cards.slice(0, n)) body.append(renderCard(card, list));
    if (cards.length > n) body.append(h('button', { class: 'more-btn', text: `さらに表示（残り ${cards.length - n} 件）`, onclick: () => { state.shown[`${key}:dormant`] = n + PAGE * 2; render(); } }));
    fold.append(body);
  }
  return fold;
}

// ---- 時間軸: the board by time (it reuses the inbox's reading pane) ----
const TIMELINE_GROUP_CAP = 80;
function timelineGroups(b) {
  const now = Date.now();
  const byGroup = new Map(TIME_GROUPS.map(([k]) => [k, []]));
  for (const l of b.lists) for (const c of l.cards) byGroup.get(timeGroupOf(c, now)).push({ card: c, list: l });
  const byNew = (a, c) => (c.card.updatedAt || 0) - (a.card.updatedAt || 0);
  return TIME_GROUPS.map(([k, name]) => {
    const xs = byGroup.get(k).sort(byNew);
    return [name, xs.slice(0, TIMELINE_GROUP_CAP), xs.length - TIMELINE_GROUP_CAP, k];
  });
}

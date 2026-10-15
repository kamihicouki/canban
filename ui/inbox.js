// 時間軸: the board by time, with the selected card docked on its right (the view switch, `i`; ui/lifetime.js).
// Included into board.html's script (shares its scope). Rows are sessions that need you first, then running
// ones, then by the calendar. The right side is the card itself — the same card as the overlay (card-overlay.js),
// docked on the pane layer over .inbox-main — so reading, answering and the details panel work as they do there.
// The list follows the same filters as the board; Enter opens the card large, Esc puts it back.
state.inbox = { sel: null };
const inboxOn = () => timelineOn();
const inboxRows = () => $$('#board .irow');
function inboxRow(x) {
  const { card, list } = x, task = card.kind === 'task';
  const row = h('article', { class: 'card irow', tabindex: 0, role: 'option', 'data-card-id': card.id, 'data-life': lifeOf(card), 'data-day': daysAgo(card.updatedAt), 'aria-selected': String(state.inbox.sel === card.id), title: card.title },
    faceGlyph(card.status, card.statusKnown),
    h('div', { class: 'grow' }, h('div', { class: 'irow-t', text: card.title }),
      h('div', { class: 'irow-s' }, faceWho(task ? 'task' : card.agent), dotPill(card), h('span', { class: 'ellipsis', text: (task ? card.links.length ? `${card.links.length} セッション` : 'セッションなし' : card.git?.branch || card.branch || card.directory?.name || '') }), card.unread ? h('span', { class: 'fflag fflag-new', text: '新着' }) : null)),
    h('span', { class: 'irow-time', title: fmtDate(card.updatedAt), text: relTime(card.updatedAt) }));
  const exchanges = exchangePill(card); if (exchanges) $('.irow-s', row).append(exchanges);
  row.addEventListener('click', () => inboxSelect(card.id));
  row.addEventListener('dblclick', () => inboxExpand(card.id));
  row.addEventListener('keydown', (e) => {
    if (e.target !== row || e.metaKey || e.ctrlKey || e.altKey) return;
    const p = paneDocked() && panes[0]?.id === card.id ? panes[0] : null;
    const run = {
      Enter: () => inboxExpand(card.id),
      r: () => p?.el.querySelector('[data-sec="send"] textarea')?.focus(),
      m: () => listPicker(row, card, list.id),
      l: () => labelPicker(row, card.id, card, () => {}),
      d: () => p && toggleThreadSide(p, 'details'),
      f: () => p && p.kind === 'session' && !p.d?.session?.host && toggleThreadSide(p, 'changes'),
      ...Object.fromEntries(PANE_MODES.map(([mode], i) => [String(i + 1), () => setPaneMode(mode)])),
    }[e.key];
    if (!run) return;
    e.preventDefault(); e.stopPropagation(); run();
  });
  return row;
}
function renderInbox(b) {
  const groups = timelineGroups(b);
  const first = groups.flatMap((g) => g[1])[0];
  // A card opened from inside the docked one (a parent, a linked session) may not be a row: it stays where it is.
  if (!groups.some((g) => g[1].some((x) => x.card.id === state.inbox.sel)) && !paneDocked()) state.inbox.sel = first?.card.id ?? null;
  const list = h('div', { class: 'inbox-list', role: 'listbox', 'aria-label': 'セッション' });
  for (const [name, xs, more, key] of groups) {
    if (!xs.length) continue;
    list.append(h('div', { class: `inbox-gh tg-${key}` }, h('i'), name, h('span', { class: 'n', text: String(xs.length + Math.max(0, more)) })), ...xs.map(inboxRow));
    if (more > 0) list.append(h('div', { class: 'muted inbox-more', text: `ほか ${more} 件（検索で探せます）` }));
  }
  if (!first) list.append(h('div', { class: 'muted inbox-more', text: '表示するカードがありません' }));
  const main = h('section', { class: 'inbox-main', 'aria-label': '選んだカード' }, h('div', { class: 'inbox-empty', text: first ? 'カードを選ぶと、ここで読んで返信できます' : '' }));
  const count = groups.reduce((n, [, xs, more]) => n + xs.length + Math.max(0, more || 0), 0);
  const heading = h('div', { class: 'inbox-heading' }, h('h2', { text: 'カード' }), h('span', { text: `${count}件` }));
  return h('div', { class: 'inbox' }, h('aside', { class: 'inbox-side', 'aria-label': 'カード一覧' }, heading, list), main);
}
// After every drawing of the board: the docked card follows the 時間軸 — docked on its right while it is shown,
// gone with it when the board comes back. A card opened large stays large.
function syncDockedCard() {
  if (!inboxOn() || !$('#board .inbox-main')) { if (paneDocked()) closeCards({ dock: false }); return; }
  if (paneDocked()) return paneMetrics();
  if (paneLayer.hidden && state.inbox.sel && findCard(state.inbox.sel)) openCard(state.inbox.sel, { dock: true });
}
// The row of the card on the layer is the selected one.
function markInboxSel(id) {
  state.inbox.sel = id;
  for (const r of inboxRows()) r.setAttribute('aria-selected', String(r.dataset.cardId === id));
  $(`#board .irow[data-card-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
}
function inboxSelect(id, { focus = false } = {}) {
  markInboxSel(id);
  if (focus) $(`#board .irow[data-card-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  if (!(paneDocked() && panes[0]?.id === id)) openCard(id, { dock: true });
}
function inboxStep(delta) {
  const rows = inboxRows(), i = rows.findIndex((r) => r.dataset.cardId === state.inbox.sel);
  const next = rows[Math.max(0, Math.min(rows.length - 1, (i < 0 ? 0 : i + delta)))];
  if (next) inboxSelect(next.dataset.cardId, { focus: true });
}
// Enter / double click: the same card, large over the board (Esc puts it back on the right).
function inboxExpand(id) {
  markInboxSel(id);
  if (paneDocked() && panes[0]?.id === id) expandCards();
  else openCard(id, { dock: false });
}

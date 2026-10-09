// 時間軸: the board by time, with the session on its right (the view switch, `i`; ui/lifetime.js).
// Included into board.html's script (shares its scope). Rows are sessions that need you first, then running
// ones, then by the calendar; the right side reads the last messages and answers in place. The list follows
// the same filters as the board, and a row still opens the card (Enter).
state.inbox = { sel: null, d: null, id: null, loading: false, error: null };
const inboxOn = () => timelineOn();
const inboxRows = () => $$('#board .irow');
function inboxRow(x) {
  const { card, list } = x, task = card.kind === 'task';
  const row = h('article', { class: 'card irow', tabindex: 0, role: 'option', 'data-card-id': card.id, 'data-life': lifeOf(card), 'data-day': daysAgo(card.updatedAt), 'aria-selected': String(state.inbox.sel === card.id), title: card.title },
    faceGlyph(card.status, card.statusKnown),
    h('div', { class: 'grow' }, h('div', { class: 'irow-t', text: card.title }),
      h('div', { class: 'irow-s' }, faceWho(task ? 'task' : card.agent), dotPill(card), h('span', { class: 'ellipsis', text: (task ? card.links.length ? `${card.links.length} セッション` : 'セッションなし' : card.git?.branch || card.branch || card.directory?.name || '') }), card.unread ? h('span', { class: 'fflag fflag-new', text: '新着' }) : null)),
    h('span', { class: 'irow-time', title: fmtDate(card.updatedAt), text: relTime(card.updatedAt) }));
  row.addEventListener('click', () => inboxSelect(card.id));
  row.addEventListener('dblclick', () => openCard(card.id));
  row.addEventListener('keydown', (e) => {
    if (e.target !== row || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Enter') { e.preventDefault(); openCard(card.id); }
    else if (e.key === 'r' && !task) { e.preventDefault(); e.stopPropagation(); document.querySelector('.inbox-main .peek-input')?.focus(); }
    else if (e.key === 'm') { e.preventDefault(); e.stopPropagation(); listPicker(row, card, list.id); }
    else if (e.key === 'l') { e.preventDefault(); e.stopPropagation(); labelPicker(row, card.id, card, () => {}); }
  });
  return row;
}
function renderInbox(b) {
  const groups = timelineGroups(b);
  const first = groups.flatMap((g) => g[1])[0];
  if (!groups.some((g) => g[1].some((x) => x.card.id === state.inbox.sel))) state.inbox.sel = first?.card.id ?? null;
  const list = h('div', { class: 'inbox-list', role: 'listbox', 'aria-label': 'セッション' });
  for (const [name, xs, more, key] of groups) {
    if (!xs.length) continue;
    list.append(h('div', { class: `inbox-gh tg-${key}` }, h('i'), name, h('span', { class: 'n', text: String(xs.length + Math.max(0, more)) })), ...xs.map(inboxRow));
    if (more > 0) list.append(h('div', { class: 'muted inbox-more', text: `ほか ${more} 件（検索で探せます）` }));
  }
  if (!first) list.append(h('div', { class: 'muted inbox-more', text: '表示するカードがありません' }));
  const main = h('section', { class: 'inbox-main', 'aria-label': 'プレビュー' });
  const wrap = h('div', { class: 'inbox' }, h('aside', { class: 'inbox-side' }, list), main);
  queueMicrotask(() => paintInboxMain(main));
  return wrap;
}
function inboxSelect(id, { focus = false } = {}) {
  if (state.inbox.sel !== id) { state.inbox.sel = id; state.inbox.d = null; }
  inboxRows().forEach((r) => r.setAttribute('aria-selected', String(r.dataset.cardId === id)));
  paintInboxMain($('.inbox-main'));
  if (focus) $(`.irow[data-card-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
}
function inboxStep(delta) {
  const rows = inboxRows(), i = rows.findIndex((r) => r.dataset.cardId === state.inbox.sel);
  const next = rows[Math.max(0, Math.min(rows.length - 1, (i < 0 ? 0 : i + delta)))];
  if (!next) return;
  inboxSelect(next.dataset.cardId, { focus: true });
  next.scrollIntoView({ block: 'nearest' });
}
async function paintInboxMain(main) {
  if (!main?.isConnected) return;
  const hit = state.inbox.sel ? findCard(state.inbox.sel) : null;
  if (!hit) return main.replaceChildren(h('div', { class: 'muted pane-pad', text: 'カードを選ぶと、ここで読んで返信できます' }));
  const { card } = hit;
  const head = h('div', { class: 'inbox-h' }, faceGlyph(card.status, card.statusKnown), h('h2', { text: card.title }), h('span', { class: 'grow' }),
    h('button', { class: 'btn', type: 'button', onclick: () => openCard(card.id) }, 'カードを開く ', ...keycap('Enter')));
  const meta = h('div', { class: 'inbox-meta' }, faceWho(card.kind === 'task' ? 'task' : card.agent), dirPill(card.directory || { name: 'カテゴリ無し' }),
    card.git?.branch || card.branch ? h('span', { class: 'fbranch ellipsis', text: card.git?.branch || card.branch }) : null, card.kind === 'task' ? null : faceStat(card),
    card.pr ? prPill(card.pr) : null, h('span', { class: 'ftime', text: relTime(card.updatedAt) }));
  if (card.kind === 'task') {
    return main.replaceChildren(head, meta, h('div', { class: 'inbox-body' }, card.description ? h('div', { class: 'ptext', text: card.description }) : h('div', { class: 'muted', text: '説明はありません' }),
      ...card.links.map((l) => h('button', { class: 'flink-row', type: 'button', onclick: () => inboxSelect(l.id) }, faceGlyph(l.status, l.statusKnown), faceWho(l.agent), h('span', { class: 'ellipsis grow', text: l.title }), h('span', { class: 'muted', text: relTime(l.updatedAt) })))));
  }
  const cached = state.inbox.d && state.inbox.d.session.id === card.id && state.inbox.d.session.updatedAt === card.updatedAt ? state.inbox.d : null;
  const show = (d) => {
    if (!main.isConnected || state.inbox.sel !== card.id) return;
    const nodes = peekContent(card, d, { limit: 8, onClose: () => $(`.irow[data-card-id="${CSS.escape(card.id)}"]`)?.focus(), onSent: async () => { state.inbox.d = null; load(); await paintInboxMain($('.inbox-main')); } });
    const dock = nodes.filter((n) => n.matches?.('.peek-compose, .peek-foot')), body = nodes.filter((n) => !dock.includes(n));
    const scroll = h('div', { class: 'inbox-body' }, ...body);
    main.replaceChildren(head, meta, scroll, h('div', { class: 'inbox-dock' }, ...dock));
    scroll.scrollTop = scroll.scrollHeight;
    $('.peek-input', main)?.dispatchEvent(new Event('input'));
  };
  if (cached) return show(cached);
  main.replaceChildren(head, meta, h('div', { class: 'muted pane-pad', text: '読み込み中…' }));
  try {
    const d = await bridge.callTool('canban_get_session', { cardId: card.id, messages: 10 });
    state.inbox.d = d; card.unread = false;
    show(d);
  } catch (e) { if (state.inbox.sel === card.id) main.replaceChildren(head, meta, h('div', { class: 'muted pane-pad', text: `読み込めませんでした: ${e.message}` })); }
}

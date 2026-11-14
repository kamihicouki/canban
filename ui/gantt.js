// The same cards by observed activity interval. Labels and bars share one scrolling list;
// selecting a row docks the existing card on its right, without a second WBS panel.
state.gantt = { sel: null, scroll: 0 };
const ganttOn = () => state.view === 'gantt';
const ganttRows = () => $$('#board .gantt-row');
function ganttDescription(card, bar, due) {
  const parts = [card.title];
  if (!bar) parts.push(card.kind === 'task' && !card.links?.length ? 'セッションなし' : '活動の時刻は未取得、または表示期間外');
  else {
    parts.push(bar.startKnown ? `開始: ${fmtDate(bar.start)}` : '開始の時刻は未取得');
    parts.push(`${bar.active && bar.startKnown ? '現在まで観測' : '最終更新'}: ${fmtDate(bar.end)}`);
  }
  if (due) parts.push(`${due.overdue ? '期限超過' : '期限'}: ${fmtDate(due.at)}${due.position == null ? '（表示期間外）' : ''}`);
  return parts.join('\n');
}
function ganttRow(it, range, now) {
  const { card, isTask, level } = it, bar = ganttBar(card, range, now), due = ganttDeadline(card, range, now);
  const status = isTask ? taskLifeStatus(card) : card.status;
  const known = card.statusKnown !== false && !(isTask && card.links?.length && status == null);
  const waiting = rowWaitLine(card), description = ganttDescription(card, bar, due);
  const title = h('span', { class: 'gantt-row-title', text: card.title });
  const meta = h('div', { class: 'gantt-row-meta' }, faceWho(isTask ? 'task' : card.agent, card),
    card.archived ? h('span', { class: 'gantt-archived', text: 'アーカイブ済み' }) : null,
    h('time', { title: fmtDate(card.updatedAt), text: relTime(card.updatedAt) }));
  const label = h('div', { class: 'gantt-row-label' },
    h('div', { class: 'gantt-row-heading' }, faceGlyph(status, known), title), meta,
    waiting ? h('div', { class: 'gantt-row-wait', text: waiting }) : null);
  const track = h('div', { class: 'gantt-row-track', 'aria-hidden': 'true' });
  if (bar) track.append(h('span', { class: `gantt-bar-item ${isTask ? 'task-bracket' : 'session-bar'}${bar.point ? ' is-point' : ''}${bar.active ? ' is-live' : ''}`,
    'data-start-known': String(bar.startKnown), 'data-observed-end': String(bar.end),
    style: { left: `${bar.left}%`, width: `${bar.width}%` } },
    bar.active ? h('span', { class: 'gantt-live-mark', html: picon(status === 'waiting' ? 'clock' : 'refresh', 12) }) : null));
  else track.append(h('span', { class: 'gantt-missing', text: isTask && !card.links?.length ? 'セッションなし' : '時刻は未取得・期間外' }));
  if (due?.position != null) track.append(h('span', { class: `gantt-due${due.overdue ? ' is-overdue' : ''}`, style: { left: `${due.position}%` }, text: '◆' }));
  const current = (now - range.start) / (range.end - range.start) * 100;
  if (current >= 0 && current <= 100) track.append(h('span', { class: 'gantt-now-line', style: { left: `${current}%` } }));
  const row = h('article', { class: `card gantt-row${level ? ' is-child' : ''}`, role: 'option', tabindex: state.gantt.sel === card.id ? 0 : -1,
    'data-card-id': card.id, 'data-life': lifeOf(card), 'data-day': daysAgo(card.updatedAt), 'data-status': known ? status || '' : 'unknown', 'data-parent-id': it.parentId || '',
    'aria-selected': String(state.gantt.sel === card.id), 'aria-label': [description, waiting].filter(Boolean).join('\n'), title: description }, label, track,
    due ? h('span', { class: `gantt-deadline-label${due.overdue ? ' is-overdue' : ''}`, text: `${due.overdue ? '期限超過' : '期限'} ${new Date(due.at).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })}${due.position == null ? ' · 期間外' : ''}` }) : null);
  row.addEventListener('click', () => ganttSelect(card.id));
  row.addEventListener('dblclick', () => ganttExpand(card.id));
  row.addEventListener('keydown', event => {
    if (event.target !== row || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
    const p = paneDocked() && panes[0]?.id === card.id ? panes[0] : null;
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !ganttRows()[ganttRows().indexOf(row) + (event.key === 'ArrowDown' ? 1 : -1)]) return;
    const run = {
      j: () => ganttStep(1), k: () => ganttStep(-1), ArrowDown: () => ganttStep(1), ArrowUp: () => ganttStep(-1),
      Enter: () => ganttExpand(card.id), r: () => p?.el.querySelector('[data-sec="send"] textarea')?.focus(),
      d: () => p && toggleThreadSide(p, 'details'),
      ...(!isTask ? { o: () => resume(card.id), x: () => workBundlePicker(row, card.id) } : {}),
      ...Object.fromEntries(PANE_MODES.map(([mode], i) => [String(i + 1), () => setPaneMode(mode)])),
    }[event.key];
    if (run) { event.preventDefault(); event.stopPropagation(); run(); }
  });
  return row;
}
function renderGantt(board) {
  const items = ganttItems(board), now = Date.now(), range = ganttRange(items.map(it => it.card), state.filters.days, now);
  if (!items.some(it => it.card.id === state.gantt.sel)) state.gantt.sel = null;
  const calendar = h('div', { class: 'gantt-calendar-track', 'aria-hidden': 'true' });
  const ticks = Math.min(6, range.days);
  for (let i = 0; i <= ticks; i++) {
    const time = range.start + (range.end - range.start) * i / ticks;
    calendar.append(h('span', { style: { left: `${i / ticks * 100}%` }, text: new Date(time).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' }) }));
  }
  const calendarHead = h('div', { class: 'gantt-calendar' }, h('span', { class: 'gantt-calendar-caption', text: `${items.length}件` }), calendar);
  const list = h('div', { class: 'gantt-list', role: 'listbox', 'aria-label': '観測した活動の期間', 'aria-describedby': 'ganttLegend' },
    calendarHead, ...items.map(item => ganttRow(item, range, now)));
  if (!items.length) list.append(h('p', { class: 'gantt-empty', text: '表示するカードがありません' }));
  if (!state.gantt.sel) list.querySelector('.gantt-row')?.setAttribute('tabindex', '0');
  const panel = h('section', { class: 'gantt-timeline', 'aria-label': 'ガント' },
    h('p', { class: 'gantt-legend', id: 'ganttLegend', text: '帯は観測した活動の期間です。予定ではありません' }), list);
  const dock = h('section', { class: 'inbox-main gantt-main', 'aria-label': '選んだカード', hidden: !state.gantt.sel });
  const view = h('div', { class: `gantt-view${state.gantt.sel ? ' has-selection' : ''}` }, panel, dock);
  queueMicrotask(() => { if (list.isConnected) list.scrollTop = state.gantt.scroll || 0; });
  list.addEventListener('scroll', () => { state.gantt.scroll = list.scrollTop; }, { passive: true });
  return view;
}
function ganttSelect(id, { focus = false } = {}) {
  state.gantt.sel = id;
  const view = $('#board .gantt-view'), dock = $('#board .gantt-main');
  view?.classList.add('has-selection'); if (dock) dock.hidden = false;
  for (const row of ganttRows()) {
    const selected = row.dataset.cardId === id;
    row.setAttribute('aria-selected', String(selected)); row.setAttribute('tabindex', selected ? '0' : '-1');
    if (selected && focus) { row.focus({ preventScroll: true }); row.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }
  if (!(paneDocked() && panes[0]?.id === id)) openCard(id, { dock: true });
}
function ganttStep(delta) {
  const rows = ganttRows(), index = rows.findIndex(row => row.dataset.cardId === state.gantt.sel);
  const next = rows[index < 0 ? delta > 0 ? 0 : rows.length - 1 : index + delta];
  if (next) ganttSelect(next.dataset.cardId, { focus: true });
}
function ganttExpand(id) {
  state.gantt.sel = id;
  if (paneDocked() && panes[0]?.id === id) expandCards(); else openCard(id, { dock: false });
}
function syncGanttDockedCard() {
  const view = $('#board .gantt-view'), dock = $('#board .gantt-main');
  if (!ganttOn() || !dock) { if (paneDocked()) closeCards({ dock: false }); return; }
  if (paneDocked() && panes[0]?.id) {
    // View changes keep the existing card, draft and scroll; the row selection follows it.
    state.gantt.sel = panes[0].id;
    for (const row of ganttRows()) {
      const selected = row.dataset.cardId === state.gantt.sel;
      row.setAttribute('aria-selected', String(selected)); row.setAttribute('tabindex', selected ? '0' : '-1');
    }
    view?.classList.toggle('has-selection', true); dock.hidden = false;
    return paneMetrics();
  }
  view?.classList.toggle('has-selection', !!state.gantt.sel); dock.hidden = !state.gantt.sel;
  if (paneLayer.hidden && state.gantt.sel && ganttItems(state.board).some(it => it.card.id === state.gantt.sel)) openCard(state.gantt.sel, { dock: true });
}

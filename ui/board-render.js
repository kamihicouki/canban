// Part of board.html: included into its script by server/ui.mjs and shares its scope.
// Rendering
function render() {
  const b = state.board;
  if (!b) return;
  if (state.drag) return; // don't disturb an active drag

  // header
  renderAccountsButton(b);
  // The app bar names the board (the saved view it matches) and lists the filters in effect as chips.
  $('#logo').textContent = `${activeView(b)?.name || 'すべてのセッション'} ▾`;
  renderFilterChips(b);
  $('#logo').title = `表示 ${b.totals.shown} / Codex ${b.totals.codex}・Claude ${b.totals.claude}`;
  renderStatusBar(b);
  $('#seenBtn').hidden = !b.lists.some((l) => l.cards.some((c) => c.unread));
  $('#perfBtn').hidden = !b.perf?.slow?.length;
  fitHeader();
  announceAutoMoves(b);
  workspace.render(b);
  const eb = $('#errbar');
  eb.hidden = !b.errors.length;
  eb.textContent = b.errors.join(' / ');

  const boardEl = $('#board');
  const scroll = boardEl.scrollLeft;
  const listScroll = new Map();
  const listScrollKey = (l) => JSON.stringify([l.closest('.lane')?.dataset.lane || '', l.dataset.listId]);
  const scrollTop = boardEl.scrollTop;
  boardEl.querySelectorAll('.list').forEach((l) => listScroll.set(listScrollKey(l), $('.cards', l)?.scrollTop || 0));

  const focused = document.activeElement;
  const focusedCard = boardEl.contains(focused) ? focused.closest('.card')?.dataset.cardId : null;
  const frag = document.createDocumentFragment();
  boardEl.classList.toggle('with-lanes', !!state.filters.swimlane && !inboxOn());
  boardEl.style.setProperty('--lane-max-h', (LANE_HEIGHTS[state.filters.laneHeight] || LANE_HEIGHTS.normal)[1]);
  state.lanes = state.filters.swimlane ? buildLanes(b, state.filters.swimlane) : [];
  if (state.soloLane && !state.lanes.some((l) => l.key === state.soloLane)) state.soloLane = null;
  if (inboxOn()) frag.append(renderInbox(b));
  else if (state.filters.swimlane) {
    if (state.soloLane) {
      frag.append(h('div', { class: 'solo-bar' }, `「${state.lanes.find(l => l.key === state.soloLane)?.name}」だけを表示中`,
        h('button', { class: 'lane-solo', text: '◀ 全レーンに戻る', onclick: () => setSolo(null) })));
    }
    for (const lane of state.lanes) if (!state.soloLane || lane.key === state.soloLane) frag.append(renderLane(lane));
  } else {
    for (const list of b.lists) frag.append(renderList(list));
    frag.append(renderAddList());
  }
  if (state.filters.swimlane && !inboxOn() && slackUi.visible) { const lanes = h('div', { class: 'slack-lanes' }, frag); boardEl.replaceChildren(lanes); }
  else boardEl.replaceChildren(frag);
  boardEl.classList.toggle('with-slack', slackUi.visible);
  const slackNode = slackUi.boardNode(); if (slackNode) boardEl.prepend(slackNode);
  renderSidebar(b);
  renderRibbon(b);
  renderViewSwitch();
  applyLens();
  paintLayoutChrome();
  if (focused && focused !== document.body && boardEl.contains(focused)) focused.focus({ preventScroll: true });
  else if (focusedCard) $(`.card[data-card-id="${CSS.escape(focusedCard)}"]`, boardEl)?.focus({ preventScroll: true });
  boardEl.scrollLeft = scroll;
  boardEl.scrollTop = scrollTop;
  boardEl.querySelectorAll('.list').forEach((l) => { const c = $('.cards', l); if (c) c.scrollTop = listScroll.get(listScrollKey(l)) || 0; });
  bridge.reportSize();
}

function renderList(list, { inLane = false, lane = null } = {}) {
  const over = list.wipLimit && list.count > list.wipLimit;
  const defaultHint = list.isDefault && !inLane ? '新しいセッションはここに入ります' : null;
  const el = h('section', { class: `list${over ? ' over-wip' : ''}`, 'data-list-id': list.id, 'aria-label': list.title, 'aria-description': defaultHint });
  const head = h('div', { class: 'list-head' },
    h('span', { class: 'stripe', style: { background: colorVar(list.color) } }),
    h('div', { class: 'list-title', tabindex: 0, title: [defaultHint, 'クリックして名前を変更'].filter(Boolean).join('\n'), text: list.title,
      onclick: (e) => editListTitle(e.currentTarget, list),
      onkeydown: (e) => { if (e.key === 'Enter') editListTitle(e.currentTarget, list); } }),
    h('span', { class: `count${over ? ' over' : ''}`, text: list.wipLimit ? `${list.count} / ${list.wipLimit}` : String(list.count) }),
    h('button', { class: 'icon-btn quick-task-trigger', type: 'button', 'aria-label': `${list.title}にタスクを追加`, text: '＋', onclick: () => taskQuickAdd.open({ listId: list.id, lane }) }),
    h('button', { class: 'icon-btn', 'aria-label': `${list.title} のメニュー`, text: '⋯', onclick: (e) => listMenu(e.currentTarget, list) }),
  );
  head.addEventListener('pointerdown', (e) => startListDrag(e, list, el));
  el.append(head);

  // Awake cards keep their order; the dormant ones fold at the foot (lifetime-model.js).
  const cardsEl = h('div', { class: 'cards', 'data-list-id': list.id });
  const { awake, dormant } = splitByLife(list.cards);
  const n = state.shown[list.id] || PAGE;
  for (const card of awake.slice(0, n)) cardsEl.append(renderCard(card, list));
  if (awake.length > n) {
    cardsEl.append(h('button', { class: 'more-btn', text: `さらに表示（残り ${awake.length - n} 件）`,
      onclick: () => { state.shown[list.id] = n + PAGE * 2; render(); } }));
  }
  if (dormant.length) cardsEl.append(dormantFold(list, dormant, lane));
  el.append(cardsEl);
  el.append(renderAddCard(list, { lane }));
  return el;
}

// All column buttons open the same retained task dialog, including swimlanes.
function renderAddCard(list, { lane = null } = {}) {
  return h('div', { class: 'add-card' }, h('button', { class: 'add-card-btn', type: 'button',
    text: '＋ タスクを追加', onclick: () => taskQuickAdd.open({ listId: list.id, lane }) }));
}

// The shell every card face shares (card-face.js draws the face by its lifetime).
function cardShell(card, extraClass) {
  return h('article', {
    class: `card${extraClass}${card.archived ? ' is-archived' : ''}${card.unread ? ' unread' : ''}`, tabindex: 0, 'data-card-id': card.id,
    'aria-label': `${card.title}（${card.kind === 'task' ? `${T.taskCard}・` : ''}${card.statusKnown === false ? '状態未取得' : STATUS_LABELS[card.status]}${card.unread ? '・新着' : ''}）`, title: card.title,
  });
}


// Shared by session and task cards: drag, click to open (the card floats above the board), ▶ resume, keyboard.
function attachCardBehavior(el, card, list, onResume) {
  el.addEventListener('pointerdown', (e) => startCardDrag(e, card, el));
  el.addEventListener('click', () => { if (!state.justDragged) openCard(card.id); });
  if (onResume) {
    el.append(h('button', { class: 'card-resume', title: `再開（${shortcutHelp()}）`, 'aria-label': `${card.title} を再開`, text: '▶',
      onpointerdown: (e) => e.stopPropagation(),
      onclick: (e) => { e.stopPropagation(); onResume(optsFromEvent(e)); } }));
  }
  el.addEventListener('keydown', (e) => {
    if (e.target !== el) return;
    if (e.key === 'Enter') openCard(card.id);
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    if (e.key === 'Escape' && state.peek?.id === card.id) { e.preventDefault(); e.stopPropagation(); return closePeek(); }
    if (plain && !e.shiftKey && card.kind !== 'task' && (e.key === ' ' || e.key === 'r')) { e.preventDefault(); e.stopPropagation(); return togglePeek(card, { focusInput: e.key === 'r' }); }
    if (plain && CARD_ATTR_KEYS[e.key]) { e.preventDefault(); e.stopPropagation(); return CARD_ATTR_KEYS[e.key](el, card, list); }
    const k = onResume && !e.metaKey && !e.ctrlKey && !e.altKey && CARD_KEYS[e.key.toLowerCase()];
    if (k) { e.preventDefault(); onResume(k); }
    if (ARROWS[e.key] && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (e.altKey) focusNeighbor(list.id, card.id, e.key);
      else moveByKey(card, list.id, e.key);
    }
  });
  return el;
}

function dirPill(d) {
  return h('span', { class: 'dir-pill', title: `${T.category}: ${d.name}` },
    h('i', { class: 'dir-dot', style: { background: d.color ? colorVar(d.color) : 'var(--btn-subtle-hover)' } }), d.name);
}

// Attribute keys on a focused card (Trello-like): l = labels, g = directory, m = move.
const CARD_ATTR_KEYS = {
  l: (el, card) => labelPicker(el, card.id, card, () => {}),
  g: (el, card) => directoryPicker(el, card),
  m: (el, card, list) => listPicker(el, card, list.id),

};
function listPicker(anchor, card, fromListId) {
  const lists = state.board.lists;
  picker(anchor, {
    title: 'リストへ移動', selected: [fromListId],
    items: lists.map((l, i) => ({ value: l.id, label: l.title, color: l.color, hint: `${l.count}${i < 9 ? ` · ${i + 1}` : ''}`, keywords: String(i + 1) })),
    onPick: (to) => { if (to !== fromListId) moveCard(card, fromListId, to, 0, true); },
  });
}
function directoryItems(withAuto = true) {
  const b = state.board;
  return [
    withAuto ? { value: '', label: '自動（エージェントのカテゴリに従う）', hint: '' } : null,
    { value: '__none', label: 'カテゴリ無し' },
    ...b.directories.map((d) => ({ value: d.id, label: d.name, color: d.color, hint: d.count, keywords: (d.paths || []).join(' ') })),
  ].filter(Boolean);
}
// Choose/create a category, or explicitly opt out of the agent's automatic category.
function directoryPicker(anchor, card, { cwd = card.cwd, explicit, after } = {}) {
  const cur = explicit !== undefined ? explicit || '' : card.directory?.id || '';
  const set = async (v) => {
    await act('canban_update_card', { cardId: card.id, directory: v || null }, { okMsg: v === '__none' ? `${T.category}から外しました` : v ? `📂 ${state.board.directories.find((d) => d.id === v)?.name ?? ''} に入れました` : '自動に戻しました' }).catch(() => {});
    after?.();
  };
  picker(anchor, {
    title: `${T.category}`, selected: [cur], items: directoryItems(), createText: `を新しい${T.category}として作成`,
    onPick: set,
    onCreate: async (name) => {
      const color = COLORS[(state.board.directories.length + 1) % COLORS.length];
      const r = await act('canban_create_directory', { name, color }, { reload: false }).catch(() => null);
      if (r?.result) { state.board.directories.push({ ...r.result, count: 0 }); await set(r.result.id); }
    },
  });
}




function renderAddList() {
  const wrap = h('div', { class: 'add-list' });
  const btn = h('button', { class: 'add-list-btn', text: '＋ もう1つリストを追加' });
  btn.onclick = () => {
    const input = h('input', { class: 'text-input', placeholder: 'リスト名を入力…', maxlength: 80 });
    const submit = async () => {
      const title = input.value.trim();
      if (!title) return input.focus();
      input.disabled = true;
      await act('canban_create_list', { title }).catch(() => {});
      requestAnimationFrame(() => { const b = $('.add-list-btn'); b?.click(); $('#board').scrollLeft = 1e6; });
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') render(); };
    wrap.replaceChildren(h('div', { class: 'composer' }, input,
      h('div', { class: 'row' }, h('button', { class: 'btn-primary', text: 'リストを追加', onclick: submit }),
        h('button', { class: 'icon-btn', 'aria-label': '閉じる', text: '✕', onclick: () => render() }))));
    input.focus();
  };
  wrap.append(btn);
  return wrap;
}

function editListTitle(titleEl, list) {
  if (state.drag) return;
  const input = h('input', { class: 'list-title-input', value: list.title, maxlength: 80, 'aria-label': 'リスト名' });
  let done = false;
  const commit = async (save) => {
    if (done) return; done = true;
    const v = input.value.trim();
    if (save && v && v !== list.title) await act('canban_update_list', { listId: list.id, title: v }).catch(() => {});
    else render();
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') commit(true); if (e.key === 'Escape') commit(false); };
  input.onblur = () => commit(true);
  input.onpointerdown = (e) => e.stopPropagation();
  titleEl.replaceWith(input);
  input.select();
}

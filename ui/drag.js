// Part of board.html: included into its script by server/ui.mjs and shares its scope.
// Drag & drop (pointer events; works inside sandboxed iframes)
function startCardDrag(e, card, el) {
  if (e.button !== 0 || e.target.closest('.labels')) return;
  const sx = e.clientX, sy = e.clientY;
  const rect = el.getBoundingClientRect();
  let started = false;
  const move = (ev) => {
    if (!started) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      started = true;
      const ghost = el.cloneNode(true);
      ghost.classList.add('ghost');
      ghost.style.width = `${rect.width}px`;
      document.body.append(ghost);
      const ph = h('div', { class: 'placeholder', style: { height: `${rect.height}px` } });
      el.after(ph);
      el.classList.add('drag-source');
      el.style.display = 'none';
      state.drag = { type: 'card', card, el, ghost, ph, dx: sx - rect.left, dy: sy - rect.top, fromList: el.closest('.cards').dataset.listId };
      try { el.setPointerCapture(e.pointerId); } catch {}
    }
    ev.preventDefault();
    const d = state.drag;
    d.ghost.style.left = `${ev.clientX - d.dx}px`;
    d.ghost.style.top = `${ev.clientY - d.dy}px`;
    // Dropping a session card onto the middle of a task card links it to the task;
    // near a card's edges it is a normal move. Decide before moving the placeholder.
    // Dropping onto a directory in the sidebar changes the card's directory.
    d.ph.style.display = 'none';
    const dirEl = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.side-dir');
    d.ph.style.display = '';
    if (d.dropDir !== dirEl) {
      d.dropDir?.classList.remove('drop-target');
      d.dropDir = dirEl;
      d.dropDir?.classList.add('drop-target');
    }
    if (dirEl) { d.ph.style.display = 'none'; return; }
    let under = null;
    if (card.kind !== 'task') {
      d.ph.style.display = 'none';
      const t = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.card.task');
      if (t) {
        const r = t.getBoundingClientRect();
        if (ev.clientY > r.top + r.height * 0.2 && ev.clientY < r.bottom - r.height * 0.2) under = t;
      }
    }
    if (d.dropTask !== under) {
      d.dropTask?.classList.remove('drop-target');
      d.dropTask = under;
      d.dropTask?.classList.add('drop-target');
    }
    d.ph.style.display = d.dropTask ? 'none' : '';
    if (!d.dropTask) placeCardPlaceholder(ev.clientX, ev.clientY);
    autoScroll(ev.clientX, ev.clientY);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    stopAutoScroll();
    if (!started) return;
    const d = state.drag;
    const cardsEl = d.ph.parentElement;
    const toList = cardsEl?.dataset.listId;
    // Index in the full list from the placeholder's neighbours (works with swimlanes too).
    let idx = -1;
    if (cardsEl) {
      const rest = state.board.lists.find((l) => l.id === toList).cards.filter((c) => c.id !== card.id);
      const near = (dir) => { let n = d.ph[dir]; while (n && (!n.classList.contains('card') || n.classList.contains('drag-source'))) n = n[dir]; return n; };
      const next = near('nextElementSibling');
      const prev = near('previousElementSibling');
      if (next) idx = rest.findIndex((c) => c.id === next.dataset.cardId);
      else if (prev) idx = rest.findIndex((c) => c.id === prev.dataset.cardId) + 1;
      else idx = rest.length;
      if (idx < 0) idx = rest.length;
    }
    d.ghost.remove();
    state.drag = null;
    state.justDragged = true;
    setTimeout(() => (state.justDragged = false), 0);
    if (d.dropDir) {
      const dir = d.dropDir.dataset.dirId;
      d.dropDir.classList.remove('drop-target');
      act('canban_update_card', { cardId: card.id, directory: dir }, { okMsg: dir === '__none' ? `${T.category}から外しました` : `📂 ${state.board.directories.find((x) => x.id === dir)?.name ?? ''} に入れました` }).catch(() => {});
      return;
    }
    // Directory swimlanes: dropping into another lane also moves the card to that directory.
    const laneDir = state.filters.swimlane === 'directory' ? cardsEl?.closest('.lane')?.dataset.dirId : null;
    let dirDone = null;
    if (laneDir && laneDir !== (card.directory?.id || '__none')) {
      dirDone = bridge.callTool('canban_update_card', { cardId: card.id, directory: laneDir }).catch((e) => toast(e.message, true));
      card.directory = state.board.directories.find((x) => x.id === laneDir) || null;
    }
    if (d.dropTask) {
      const taskId = d.dropTask.dataset.cardId;
      d.dropTask.classList.remove('drop-target');
      act('canban_link_session', { taskId, sessionId: card.id }, { okMsg: `${T.taskCard}に紐付けました` }).catch(() => {});
      return;
    }
    const moved = toList && idx >= 0 ? moveCard(card, d.fromList, toList, idx) : (render(), null);
    if (dirDone) Promise.all([dirDone, moved]).then(() => load());
  };
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

function placeCardPlaceholder(x, y) {
  const d = state.drag;
  const listEl = listAt(x, y);
  if (!listEl) return;
  const cardsEl = $('.cards', listEl);
  const cards = [...cardsEl.querySelectorAll(':scope > .card:not(.drag-source)')];
  let before = null;
  for (const c of cards) {
    const r = c.getBoundingClientRect();
    if (y < r.top + r.height / 2) { before = c; break; }
  }
  if (before) { if (d.ph.nextSibling !== before) cardsEl.insertBefore(d.ph, before); }
  else {
    const fold = $(':scope > .life-fold, :scope > .more-btn', cardsEl); // below the awake cards, above the fold
    if (fold) { if (d.ph.nextSibling !== fold) cardsEl.insertBefore(d.ph, fold); }
    else if (cardsEl.lastElementChild !== d.ph) cardsEl.append(d.ph);
  }
}

function listAt(x, y) {
  const cols = [...document.querySelectorAll('.list')].filter((l) => {
    const r = l.getBoundingClientRect();
    return x >= r.left - 6 && x <= r.right + 6;
  });
  if (cols.length <= 1) return cols[0] || null;
  // swimlanes: several columns share x — pick the one in the lane under the pointer
  return cols.find((l) => { const r = (l.closest('.lane') || l).getBoundingClientRect(); return y >= r.top && y <= r.bottom; }) || null;
}

// Compute an order value between neighbours in the target list (orders ascend top→bottom).
function orderAt(listId, index, excludeId) {
  const list = state.board.lists.find((l) => l.id === listId);
  const cards = list.cards.filter((c) => c.id !== excludeId);
  const prev = cards[index - 1], next = cards[index];
  if (prev && next) return (prev.order + next.order) / 2;
  if (prev) return prev.order + 1000;
  if (next) return next.order - 1000;
  return 0;
}

// Keyboard: arrows move the focused card (←→ between lists, ↑↓ within a list,
// Home/End to the top/bottom); ⌥ + arrows only move the focus.
const ARROWS = { ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1, Home: 1, End: 1 };
function moveByKey(card, listId, key) {
  const lists = state.board.lists;
  const li = lists.findIndex((l) => l.id === listId);
  const ci = lists[li].cards.findIndex((c) => c.id === card.id);
  const others = lists[li].cards.length - 1;
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const target = lists[li + (key === 'ArrowLeft' ? -1 : 1)];
    if (target) moveCard(card, listId, target.id, Math.min(ci, target.cards.length), true);
    return;
  }
  const index = key === 'ArrowUp' ? ci - 1 : key === 'ArrowDown' ? ci + 1 : key === 'Home' ? 0 : others;
  if (index < 0 || index > others || index === ci) return;
  moveCard(card, listId, listId, index, true);
}
function focusNeighbor(listId, cardId, key) {
  const lists = state.board.lists;
  const li = lists.findIndex((l) => l.id === listId);
  const ci = lists[li].cards.findIndex((c) => c.id === cardId);
  let tl = li, tc = ci;
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const step = key === 'ArrowLeft' ? -1 : 1;
    for (tl = li + step; lists[tl] && !lists[tl].cards.length; tl += step);
    if (!lists[tl]) return;
    tc = Math.min(ci, lists[tl].cards.length - 1);
  } else if (key === 'ArrowUp' || key === 'Home') tc = key === 'Home' ? 0 : Math.max(0, ci - 1);
  else tc = key === 'End' ? lists[li].cards.length - 1 : Math.min(lists[li].cards.length - 1, ci + 1);
  const target = lists[tl].cards[tc];
  if (!target) return;
  ensureShown(lists[tl].id, tc);
  $(`.card[data-card-id="${CSS.escape(target.id)}"]`)?.focus();
}
function ensureShown(listId, index) {
  if (index < (state.shown[listId] || PAGE)) return;
  state.shown[listId] = index + PAGE;
  render();
}

function moveCard(card, fromListId, toListId, index, focusAfter = false) {
  const b = state.board;
  const order = orderAt(toListId, index, card.id);
  // optimistic update
  const from = b.lists.find((l) => l.id === fromListId);
  const to = b.lists.find((l) => l.id === toListId);
  from.cards = from.cards.filter((c) => c.id !== card.id);
  from.count = from.cards.length;
  const moved = { ...card, order, placed: true };
  to.cards.push(moved);
  to.cards.sort((a, c) => a.order - c.order);
  to.count = to.cards.length;
  const newIndex = to.cards.findIndex((c) => c.id === card.id);
  if (newIndex >= (state.shown[toListId] || PAGE)) state.shown[toListId] = newIndex + PAGE;
  render();
  if (focusAfter) $(`.card[data-card-id="${CSS.escape(card.id)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (focusAfter) $(`.card[data-card-id="${CSS.escape(card.id)}"]`)?.focus();
  return bridge.callTool('canban_move_card', { cardId: card.id, toList: toListId, order })
    .catch((e) => { toast(`移動に失敗しました: ${e.message}`, true); load(); });
}

function startListDrag(e, list, listEl) {
  if (e.button !== 0 || e.target.closest('button, input, .list-title') || state.filters.swimlane) return;
  const sx = e.clientX;
  let started = false;
  const move = (ev) => {
    if (!started) {
      if (Math.abs(ev.clientX - sx) < 6) return;
      started = true;
      listEl.classList.add('dragging-list');
      state.drag = { type: 'list', list, listEl };
    }
    ev.preventDefault();
    const boardEl = $('#board');
    const others = [...boardEl.querySelectorAll('.list')].filter((l) => l !== listEl);
    let before = null;
    for (const o of others) {
      const r = o.getBoundingClientRect();
      if (ev.clientX < r.left + r.width / 2) { before = o; break; }
    }
    if (before) { if (listEl.nextSibling !== before) boardEl.insertBefore(listEl, before); }
    else boardEl.insertBefore(listEl, $('.add-list', boardEl));
    autoScroll(ev.clientX, ev.clientY);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    stopAutoScroll();
    if (!started) return;
    listEl.classList.remove('dragging-list');
    state.drag = null;
    const ids = [...document.querySelectorAll('#board .list')].map((l) => l.dataset.listId);
    const byId = new Map(state.board.lists.map((l) => [l.id, l]));
    state.board.lists = ids.map((id) => byId.get(id));
    render();
    bridge.callTool('canban_reorder_lists', { listIds: ids }).catch((err) => { toast(err.message, true); load(); });
  };
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', up);
}

let scrollTimer = null, scrollVec = [0, 0, null];
function autoScroll(x, y) {
  const boardEl = $('#board');
  const br = boardEl.getBoundingClientRect();
  const edge = 60;
  let dx = 0;
  if (x < br.left + edge) dx = -18; else if (x > br.right - edge) dx = 18;
  let dy = 0, cardsEl = null;
  const listEl = state.drag?.type === 'card' ? listAt(x, y) : null;
  if (listEl) {
    cardsEl = $('.cards', listEl);
    const r = cardsEl.getBoundingClientRect();
    if (y < r.top + 40) dy = -14; else if (y > r.bottom - 40) dy = 14;
  }
  scrollVec = [dx, dy, cardsEl];
  if ((dx || dy) && !scrollTimer) {
    scrollTimer = setInterval(() => {
      const [sx, sy, c] = scrollVec;
      if (sx) boardEl.scrollLeft += sx;
      if (sy && c) c.scrollTop += sy;
    }, 16);
  } else if (!dx && !dy) stopAutoScroll();
}
function stopAutoScroll() { clearInterval(scrollTimer); scrollTimer = null; }

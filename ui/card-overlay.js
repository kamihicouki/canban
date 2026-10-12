// Part of board.html: included into its script by server/ui.mjs and shares its scope.
// Only a press that starts and ends on the backdrop closes the card, and not the same press that just closed a popover.
let backdropDown = false;
const onBackdrop = (e) => !e.target.closest('.pane, .pane-bar, .popover, .shortcut-map');
paneLayer.addEventListener('pointerdown', e => { backdropDown = onBackdrop(e) && Date.now() - popoverClosedAt > 300; });
paneLayer.addEventListener('click', e => { if (backdropDown && onBackdrop(e)) closeCards(); backdropDown = false; });
document.body.append(paneLayer);
const panes = []; // the cards on the layer in the order they sit: a task first, then the sessions linked to it
const paneCache = new Map(); // cards that are no longer shown keep their DOM, and whatever is typed in it, until they are opened again
const PANE_CACHE_MAX = 16;
let restoringPanes = false, cardReturn = null;
const KIND_LABEL = { session: 'セッションカード', task: T.taskCard };

// The layer starts under the header and the board bar, which stay in view and in reach (as with the drawer).
function paneMetrics() {
  if (paneLayer.hidden) return;
  paneLayer.style.top = `${Math.max(0, Math.round($('.stage')?.getBoundingClientRect().top ?? 0))}px`;
  layoutCardBoard();
}
new ResizeObserver(paneMetrics).observe(paneStage);
new ResizeObserver(paneMetrics).observe(document.body);
new ResizeObserver(paneMetrics).observe($('#board'));
const cardSizeObserver = new ResizeObserver(entries => {
  for (const { target, contentRect } of entries) {
    const p = panes.find(p => p.el === target), feed = p && live.feeds.get(p.id);
    const following = feed && atFeedEnd(feed.list);
    target.style.setProperty('--card-visible-height', `${Math.round(contentRect.height)}px`);
    if (following) requestAnimationFrame(() => { if (target.isConnected && live.feeds.get(p.id) === feed) scrollFeedToEnd(feed); });
  }
});
const applyCardWidths = () => { for (const kind of CARD_KINDS) { paneLayer.style.setProperty(`--w-${kind}`, `${cardWidths[kind]}px`); paneLayer.style.setProperty(`--h-${kind}`, `${cardHeights[kind]}px`); } };
function applyPaneAttrs(p) {
  p.el.dataset.mode = paneGlobal.mode;
  p.el.dataset.kind = p.kind;
  p.el.dataset.detail = 'thread';
}

// ---- the bar over the cards: how the conversation is shown, reset layout, close ----
function buildPaneBar() {
  const mode = h('div', { class: 'seg', role: 'group', 'aria-label': '会話の表示' },
    ...PANE_MODES.map(([v, t], i) => h('button', { type: 'button', 'data-v': v, 'aria-pressed': 'false', 'aria-keyshortcuts': String(i + 1), onclick: () => setPaneMode(v) }, t, ' ', ...keycap(String(i + 1)))));
  paneBar.append(h('span', { class: 'pb-title' }), mode,
    h('button', { class: 'hbtn pb-reset', type: 'button', title: '開いている種類のカードの幅と高さを既定に戻します', onclick: resetCardLayout }, 'サイズを初期化'));
}
function paintPaneBar() {
  const view = panes[0]?.kind === 'view';
  $('.pb-title', paneBar).textContent = !panes[0] || view ? '' : panes[0].kind === 'task' && panes.length > 1 ? `${T.taskCard}と紐付いたセッション ${panes.length - 1} 件` : KIND_LABEL[panes[0].kind];
  for (const el of $$('.seg, .pb-reset', paneBar)) el.hidden = view; // a sheet has no conversation, no card layout and no neighbour to step to
  $$('button[data-v]', paneBar).forEach((b) => b.setAttribute('aria-pressed', String(paneGlobal.mode === b.dataset.v)));
  refreshShortcutHints();
}
buildPaneBar();
function setPaneMode(mode) {
  paneGlobal.mode = oneOf(mode, PANE_MODES, PANE_DEF.mode); saveGlobal();
  panes.forEach(applyPaneAttrs); paintPaneBar();
}

// ---- showing and hiding ----
function detachPane(p) {
  const i = panes.indexOf(p);
  if (i >= 0) panes.splice(i, 1);
  clearInterval(p.el._reqTimer);
  live.feeds.delete(p.id);
  cardSizeObserver.unobserve(p.el);
  p.el.remove();
  paneCache.delete(p.id); paneCache.set(p.id, p);
  for (const [id, old] of paneCache) { if (paneCache.size <= PANE_CACHE_MAX) break; if (!workspace.hasDrafts(old.el)) paneCache.delete(id); }
}
function newPane(id) {
  const p = { id, kind: cardKind(id), el: null, d: null, status: null, lastText: '' };
  if (p.kind === 'view') {
    const [icon, title] = VIEW_SHEETS[viewOf(id)];
    p.el = h('article', { class: 'pane sheet', role: 'region', 'aria-label': title, tabindex: -1, 'data-card-id': id },
      h('div', { class: 'pane-h sheet-h' }, h('div', { class: 'ph-top' }, h('span', { class: 'sheet-ic', html: picon(icon, 18) }), h('h2', { text: title }), h('span', { class: 'ph-btns' }))),
      h('div', { class: 'sheet-b' }, h('div', { class: 'muted pane-loading', text: '読み込み中…' })));
    return p;
  }
  p.el = h('article', { class: 'pane', role: 'region', 'aria-label': p.kind === 'task' ? 'タスクカード詳細' : 'セッション詳細', tabindex: -1, 'data-card-id': id }, h('div', { class: 'muted pane-loading', text: '読み込み中…' }));
  return p;
}
// The cards on the layer become exactly `ids`; cards that stay keep their DOM and drafts.
function showCards(ids) {
  closePopover();
  const wasHidden = paneLayer.hidden;
  if (wasHidden) cardReturn = document.activeElement?.closest?.('.card') || document.activeElement;
  for (const p of [...panes]) if (!ids.includes(p.id)) detachPane(p);
  const next = ids.map((id) => { const p = panes.find((x) => x.id === id) || paneCache.get(id) || newPane(id); paneCache.delete(id); return p; });
  panes.splice(0, panes.length, ...next);
  paneRow.replaceChildren(...panes.map((p) => p.el), cardBoardEnd);
  paneLayer.hidden = false;
  applyCardWidths(); paneMetrics();
  for (const p of panes) { applyPaneAttrs(p); paintPaneButtons(p); if (p.kind !== 'view') cardSizeObserver.observe(p.el); }
  paintPaneBar();
  if (!restoringPanes) store.set('openCard', ids[0]);
  workspace.syncShell(); kickLive();
  if (wasHidden) paneStage.scrollLeft = 0;
}
function closeCards() {
  if (paneLayer.hidden) return;
  closePopover();
  for (const p of [...panes]) detachPane(p);
  paneLayer.hidden = true;
  store.set('openCard', null);
  workspace.syncShell(); kickLive();
  const back = cardReturn; cardReturn = null;
  refocus(back); // refocus() finds a card the board has re-rendered since by its id
}
// Every card of the same kind shares one size.
function resetCardLayout() {
  for (const kind of new Set(panes.map((p) => p.kind).filter((k) => CARD_KINDS.includes(k)))) {
    cardWidths[kind] = CARD_WIDTH_DEF[kind];
    cardHeights[kind] = CARD_HEIGHT_DEF[kind];
  }
  saveCardWidths(); saveCardHeights(); applyCardWidths();
  toast('カードのサイズを初期化しました');
}
function setCardWidth(kind, width, save = false) {
  cardWidths[kind] = Math.min(CARD_WIDTH_MAX, Math.max(CARD_WIDTH_MIN, Math.round(width)));
  applyCardWidths();
  $$(`.pane[data-kind="${kind}"] .pane-width`).forEach((x) => x.setAttribute('aria-valuenow', cardWidths[kind]));
  if (save) saveCardWidths();
}
function setCardHeight(kind, height, save = false) {
  cardHeights[kind] = Math.min(CARD_HEIGHT_MAX, Math.max(CARD_HEIGHT_MIN, Math.round(height)));
  applyCardWidths();
  $$(`.pane[data-kind="${kind}"] .pane-height`).forEach(x => x.setAttribute('aria-valuenow', cardHeights[kind]));
  if (save) saveCardHeights();
}
function paneSizeHandle(kind, axis) {
  const horizontal = axis === 'width', corner = axis === 'corner';
  const label = corner ? 'サイズ' : horizontal ? '幅' : '高さ';
  const handle = h('div', { class: `pane-${axis}`, role: corner ? 'button' : 'separator', tabindex: 0,
    'aria-label': `${KIND_LABEL[kind]}の${label}（同じ種類のカードで共通）`,
    ...(corner ? {} : { 'aria-orientation': horizontal ? 'vertical' : 'horizontal', 'aria-valuemin': horizontal ? CARD_WIDTH_MIN : CARD_HEIGHT_MIN, 'aria-valuemax': horizontal ? CARD_WIDTH_MAX : CARD_HEIGHT_MAX, 'aria-valuenow': horizontal ? cardWidths[kind] : cardHeights[kind] }),
    title: 'ドラッグまたは矢印キーでカードのサイズを変更。Homeで既定値（同じ種類のカードで共通）',
    ...(corner ? { html: picon('grip', 14) } : {}),
    onkeydown: e => {
      if (e.key === 'Home') { e.preventDefault(); if (horizontal || corner) setCardWidth(kind, CARD_WIDTH_DEF[kind], true); if (!horizontal) setCardHeight(kind, CARD_HEIGHT_DEF[kind], true); }
      if ((horizontal || corner) && ['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); setCardWidth(kind, cardWidths[kind] + (e.key === 'ArrowLeft' ? -24 : 24), true); }
      if ((!horizontal || corner) && ['ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); const actual = handle.closest('.pane').clientHeight; setCardHeight(kind, actual + (e.key === 'ArrowUp' ? -24 : 24), true); }
    } });
  handle.onpointerdown = e => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation(); handle.setPointerCapture(e.pointerId);
    const pane = handle.closest('.pane'), initialWidth = cardWidths[kind], initialHeight = pane.clientHeight;
    const centered = paneRow.offsetWidth < paneStage.clientWidth - 48;
    const move = ev => {
      if (horizontal || corner) setCardWidth(kind, initialWidth + (ev.clientX - e.clientX) * (centered ? 2 : 1));
      if (!horizontal) setCardHeight(kind, initialHeight + ev.clientY - e.clientY);
    };
    const end = ev => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end); if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId); saveCardWidths(); saveCardHeights(); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
  };
  return handle;
}
const paneWidthHandle = kind => paneSizeHandle(kind, 'width');
const paneSizeHandles = kind => [paneWidthHandle(kind), paneSizeHandle(kind, 'height'), paneSizeHandle(kind, 'corner')];
function paneListId(p) {
  if (!p) return null;
  // Linked sessions may be grouped under a task; that task's list is not theirs.
  for (const list of state.board?.lists || []) if (list.cards.some(c => c.id === p.id)) return list.id;
  return p.d?.card?.listId || p.taskCard?.listId;
}
function adjacentPaneList(p, step) {
  const lists = state.board?.lists || [], index = lists.findIndex(l => l.id === paneListId(p));
  return index < 0 ? null : lists[index + step] || null;
}
async function movePaneToList(p, toList) {
  if (!p || p.kind === 'view' || p.movingList || toList === paneListId(p)) return;
  const target = state.board?.lists.find(l => l.id === toList);
  if (!target) return;
  p.movingList = true;
  paintCardListControls(p);
  try {
    await act('canban_move_card', { cardId: p.id, toList, position: 'top' }, { reload: false });
    if (p.d?.card) p.d.card.listId = toList;
    if (p.taskCard) p.taskCard.listId = toList;
    await load();
    toast(`「${target.title}」へ移動しました`);
  } catch { /* act reports the failure and reloads the actual placement. */ }
  finally { p.movingList = false; paintCardListControls(p); refreshShortcutHints(); }
}
function movePaneAdjacent(p, step) {
  const target = adjacentPaneList(p, step);
  if (target) return movePaneToList(p, target.id);
}
function paintCardListControls(p) {
  if (!p.listControls) return;
  const { picker: listSel, buttons } = p.listControls;
  const id = paneListId(p), list = state.board?.lists.find(l => l.id === id);
  listSel.value = id;
  listSel.textContent = `${list?.title || '—'} ▾`;
  listSel.disabled = !!p.movingList;
  for (const [step, button] of buttons) {
    const target = adjacentPaneList(p, step), direction = step < 0 ? '左' : '右', key = step < 0 ? '←' : '→';
    button.disabled = !!p.movingList || !target;
    const label = target ? `${direction}のリスト「${target.title}」へ移動` : `${direction}にリストはありません`;
    button.setAttribute('aria-label', label);
    button.title = `${label}（Shift+${key}）`;
  }
}
function cardListControls(p, listId) {
  const listSel = pickerButton({ title: 'リストへ移動', value: listId, stack: false, className: 'btn picker-btn',
    items: () => state.board.lists.map(l => ({ value: l.id, label: l.title, color: l.color, hint: l.count })),
    onChange: v => movePaneToList(p, v) });
  listSel.dataset.paneKey = 'm';
  const buttons = [-1, 1].map(step => [step, h('button', { class: 'btn card-list-step', type: 'button',
    'aria-keyshortcuts': `Shift+Arrow${step < 0 ? 'Left' : 'Right'}`, 'data-list-step': step,
    onclick: () => movePaneAdjacent(p, step) }, keycap(`⇧${step < 0 ? '←' : '→'}`))]);
  p.listControls = { picker: listSel, buttons };
  paintCardListControls(p);
  return h('span', { class: 'card-list-controls' }, listSel, ...buttons.map(([, button]) => button));
}
function cardCrumb(listSel, task = null) {
  return h('nav', { class: 'card-crumb', 'aria-label': 'パンくず' }, listSel,
    task ? [h('span', { class: 'muted', text: ' / ' }), h('button', { class: 'link-btn', text: task.title, onclick: () => openCard(task.id) })] : null);
}
function paneButtons(p) {
  return [h('button', { class: 'pane-close', type: 'button', title: 'カードを閉じる（Esc）', 'aria-label': '閉じる', onclick: () => closeCards() }, h('span', { html: picon('close', 14) }))];
}
function paintPaneButtons(p) { const slot = $('.ph-btns', p.el); if (slot) slot.replaceChildren(...paneButtons(p)); }
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || paneLayer.hidden || document.querySelector('.popover, dialog[open]')) return;
  e.preventDefault();
  if (typingIn(e.target)) { e.target.blur(); return; } // the first Esc leaves the field, the next one closes the card
  closeCards();
});

// ---- keys in the overlay: the same letters as on a focused card, plus j / k to walk through the board ----
// j / k open the next / previous card on the board in the order it is shown; [ ] move between the cards side by side;
// 1–3 change how the conversation is shown; i writes to the session; o l g m h do what the buttons beside them do.
const boardCardEl = (id) => $(`#board .card[data-card-id="${CSS.escape(id)}"]`);
async function stepOpenCard(step) {
  const root = panes[0];
  if (!root || root.kind === 'view') return;
  const cards = displayedListCards(root.id);
  const ids = cards.map(el => el.dataset.cardId);
  if (!ids.includes(root.id)) return toast('このカードはボードに表示されていません');
  const next = neighborCardId(ids, root.id, step);
  if (!next) return toast(step > 0 ? '最後のカードです' : '最初のカードです');
  const el = cards.find(el => el.dataset.cardId === next);
  cardReturn = el; // Esc gives the focus back to the card that is open now
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  // A linked session may already be beside the task. Browsing makes it the root,
  // rather than refreshing it in place; detached panes keep their drafts in cache.
  showCards([next]);
  paneStage.scrollLeft = 0;
  await openCard(next);
  if (panes[0]?.id === next) panes[0].el.focus({ preventScroll: true });
}
const focusedPane = () => { const el = document.activeElement?.closest?.('.pane'); return panes.find((p) => p.el === el) || panes[0]; };
function stepPane(step) {
  const i = panes.indexOf(focusedPane()), target = panes[i + step];
  if (target) revealPane(target.id);
}
// The button behind a pane key. In the thread layout the buttons sit in the details panel: open it first.
function paneKeyButton(p, k) {
  const find = () => p.el.querySelector(`[data-pane-key="${k}"]`);
  if (!find() && p.detailNodes) openThreadSide(p, 'details');
  return find();
}
// The Claude account picker sits in the resume part: in the thread layout, open the details panel first.
// On a task card, Alt+a picks the account of the new session instead.
function claudeAccountPicker(p) {
  if (p?.kind === 'task') { const start = p.el.querySelector('.start-account'); return start && !start.disabled ? start : null; }
  const find = () => p?.el.querySelector('.claude-account-picker');
  if (!find() && p?.detailNodes) openThreadSide(p, 'details');
  return find();
}
function focusPrompt(p) {
  const field = (x) => x.el.querySelector('[data-sec="send"] textarea');
  const ta = field(p) || panes.map(field).find(Boolean);
  if (ta) ta.focus(); else toast('指示を入力できるカードではありません');
}
document.addEventListener('keydown', e => {
  if (paneLayer.hidden || e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.metaKey || e.ctrlKey || e.altKey || typingIn(e.target) || e.target.closest?.('.card') || document.querySelector('.popover, dialog[open]')) return;
  const k = e.key, p = focusedPane();
  let run = null;
  if (e.shiftKey && (k === 'ArrowLeft' || k === 'ArrowRight') && p && p.kind !== 'view'
    && !e.target.closest?.('[role="separator"]')) {
    if (e.repeat) return;
    const step = k === 'ArrowLeft' ? -1 : 1;
    if (adjacentPaneList(p, step)) run = () => movePaneAdjacent(p, step);
  }
  else if (k === '?') run = showShortcuts;
  else if (k === 'r') run = () => openCard(panes[0].id);
  else if (k === 'a' || k === 'u') run = () => toggleView(k === 'a' ? 'analytics' : 'usage');
  else if (p && p.kind !== 'view') {
    if (k === 'j' || k === 'k') run = () => stepOpenCard(k === 'j' ? 1 : -1);
    else if (k === '[' || k === ']') run = () => stepPane(k === ']' ? 1 : -1);
    else if (/^[1-9]$/.test(k) && PANE_MODES[k - 1]) run = () => setPaneMode(PANE_MODES[k - 1][0]);
    else if (k === 'i') run = () => focusPrompt(p);
    else if ((p.kind === 'session' && (k === 'd' || (k === 'f' && !p.d?.session?.host))) || (p.kind === 'task' && k === 'd')) run = () => toggleThreadSide(p, k === 'd' ? 'details' : 'changes');
    else if (p.kind === 'session' && (k === 'z' || k === 'Delete')) run = () => paneKeyButton(p, k)?.click();
    else if (/^[olgmh]$/.test(k)) run = () => paneKeyButton(p, k)?.click();
  }
  if (run) { e.preventDefault(); run(); }
});

// ---- a small ? that explains a part ----
function helpTip(text) {
  return h('button', { class: 'help-tip', type: 'button', 'aria-label': text, title: text, text: '?',
    onclick: e => popover(e.currentTarget, 'ヒント', h('p', { text }), { width: 280 }) });
}
// ---- opening ----
async function openCard(cardId, { restore = false } = {}) {
  closePopover();
  if (workspace.utilityPage()) workspace.navigate('home', { reload: false });
  const shown = !paneLayer.hidden && panes.find((p) => p.id === cardId);
  if (cardKind(cardId) === 'view') return openView(viewOf(cardId), { shown });
  if (cardKind(cardId) === 'task') return openTaskCard(cardId, { restore, shown });
  if (shown) return loadSession(shown); // already on the layer: refresh it where it stands
  for (const l of state.board?.lists || []) for (const c of l.cards) if (c.id === cardId && c.unread) { c.unread = false; render(); }
  showCards([cardId]);
  const [p] = panes;
  await loadSession(p, { restore });
  if (panes.includes(p) && !restore) p.el.focus({ preventScroll: true });
}
async function loadSession(p, { restore = false } = {}) {
  let d;
  try {
    d = await bridge.callTool('canban_get_session', { cardId: p.id, messages: 14 });
  } catch (e) {
    if (!panes.includes(p)) return;
    if (restore && e.message.startsWith('セッションが見つかりません:')) return closeCards();
    if (p.d) return toast(e.message, true);
    p.el.replaceChildren(h('p', { class: 'muted pane-loading', text: `読み込みに失敗しました: ${e.message}` }),
      h('button', { class: 'btn', text: '再読み込み', onclick: () => loadSession(p) }),
      h('button', { class: 'pane-close', style: { margin: '8px 16px 16px' }, text: '閉じる', onclick: () => closeCards() }));
    return;
  }
  if (!panes.includes(p)) return;
  renderPaneKeepingDrafts(p, d);
}
async function openTaskCard(cardId, { restore = false, shown = null } = {}) {
  let found = findCard(cardId);
  if (!found) {
    try {
      const all = await bridge.callTool('canban_get_board', { days: 0, includeArchived: true });
      for (const list of all.lists) { const card = list.cards.find((c) => c.id === cardId); if (card) { found = { card, list }; break; } }
    } catch (e) { if (!restore) toast(e.message, true); return; }
  }
  if (!found) { if (!restore) toast('カードが見つかりません', true); return; }
  // Threads: the task beside one session at a time (the one chosen last, else the latest); the others are a click away.
  const choice = taskThreadChoice(cardId, found.card.links);
  const { ids } = taskOverlayIds(cardId, found.card.links, choice ? [choice] : [], 1);
  showCards(ids);
  const [root, ...sessions] = panes;
  await Promise.all([loadTask(root, found), ...sessions.map((p) => loadSession(p))]);
  if (panes.includes(root) && !restore && !shown) root.el.focus({ preventScroll: true });
}
// A session shown beside its task scrolls into view; any other card replaces what is on the layer.
function revealPane(id) {
  const p = panes.find((x) => x.id === id);
  if (!p) return openCard(id);
  p.el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  p.el.focus({ preventScroll: true });
}
// The links of the open task changed (a session was started, linked or unlinked): the sessions beside it follow.
function reconcileCards(board) {
  const [root] = panes;
  if (!root || root.kind !== 'task' || paneLayer.hidden) return;
  const card = board.lists.flatMap((l) => l.cards).find((c) => c.id === root.id);
  if (!card) return; // filtered out or unavailable is not a deletion
  root.taskCard = card; root.status = card.status;
  const status = $('.pane-status', root.el);
  if (status) status.replaceChildren(h('span', { class: `sdot s-${card.status}` }), STATUS_LABELS[card.status]);
  paintTaskRelated(root, card);
  const shown = panes.map((p) => p.id);
  const { ids } = taskOverlayIds(root.id, card.links, [taskThreadChoice(root.id, card.links)].filter(Boolean), 1);
  if (ids.join() === shown.join()) return;
  showCards(ids);
  // A card that comes back (linked again) was detached with its live feed: it always needs a fresh load.
  for (const p of panes) if (!shown.includes(p.id)) loadSession(p);
}
// ---- sheets: analytics and Agent Usage, on the same layer as the cards ----
const openViewKind = () => (!paneLayer.hidden && panes[0]?.kind === 'view' ? viewOf(panes[0].id) : null);
async function openView(kind, { shown = null } = {}) {
  if (!kind) return;
  if (!shown) showCards([`view:${kind}`]);
  const [p] = panes;
  workspace.syncShell();
  await loadView(p);
  if (!shown && panes.includes(p)) p.el.focus({ preventScroll: true });
}
function toggleView(kind) { return openViewKind() === kind ? closeCards() : openView(kind); }
function loadView(p) {
  const kind = viewOf(p.id);
  if (kind === 'analytics') return loadAnalytics(p);
  if (kind === 'orbit' && state.board) return loadOrbit(p);
  if (kind === 'usage' && state.board) {
    const body = $('.sheet-b', p.el), top = body.scrollTop;
    workspace.renderUsage({ el: body }, state.board);
    body.scrollTop = top;
  }
}
// After every board load: an open sheet follows the same filters and data.
function refreshViews() { for (const p of panes) if (p.kind === 'view' && !paneLayer.hidden) loadView(p); }
async function restoreCards() {
  const id = store.get('openCard', null);
  if (typeof id !== 'string' || !id) return;
  restoringPanes = true;
  try { await openCard(id, { restore: true }); } finally { restoringPanes = false; }
}

function paintViewers(p) {
  const slot = $('.viewers', p.el);
  if (!slot) return;
  const v = live.viewers.get(p.id);
  slot.hidden = !v;
  slot.textContent = v ? `👁 ${v.join('・')}でも開いています` : '';
}

function renderPaneKeepingDrafts(p, d) {
  const el = p.el;
  if (el.querySelector('.req-row textarea')) {
    // Keep the request editor while rebuilding a reset conversation cursor.
    p.d = d;
    const conversation = $('.th-conv', el);
    if (conversation && d.feed) conversation.replaceChildren(renderFeed(d, p));
    return;
  }
  const drafts = [...el.querySelectorAll('input,textarea,select')].filter(input => {
    const baseline = workspace.draftValues.get(input);
    return (baseline !== undefined && baseline !== input.value) || input.matches('.send-box textarea') && !!input.value.trim()
      || input.matches('textarea.note') && input.value !== input.defaultValue;
  }).map(input => ({ label: input.getAttribute('aria-label'), value: input.value }));
  const promptDraft = promptDrafts.get(`dispatch:${p.id}`);
  const promptValue = drafts.find(draft => draft.label === '送るプロンプト');
  if (promptDraft && promptValue) promptDraft.text = promptValue.value;
  renderPane(p, d);
  for (const draft of drafts) {
    if (!draft.label) continue;
    const input = [...el.querySelectorAll('input,textarea,select')].find(input => input.getAttribute('aria-label') === draft.label);
    if (input) input.value = draft.value;
    else if (draft.label === '送るプロンプト') keepDisabledPrompt($('.send-section', el), draft.value);
  }
}

async function changeSessionCardState(p, action) {
  if (p.cardActionBusy) return;
  if (!p.d?.session?.actions?.available) { toast(p.d?.session?.actions?.reason || 'この操作は利用できません', true); return; }
  p.cardActionBusy = true;
  try {
    await act('canban_set_session_card_state', { cardId: p.id, action }, { okMsg: action === 'delete' ? 'Codexのセッションを削除しました' : action === 'archive' ? 'Codexでアーカイブしました' : 'アーカイブから戻しました' });
    closeCards();
  } finally { p.cardActionBusy = false; }
}
function confirmSessionCardDelete(p) {
  if (p?.kind !== 'session' || !p.d?.session || p.cardActionBusy || document.querySelector('dialog[open]')) return;
  if (!p.d.session.actions?.available) { toast(p.d.session.actions?.reason || 'この操作は利用できません', true); return; }
  const cancel = h('button', { class: 'btn', type: 'button', autofocus: true }, 'キャンセル', keycap('Esc'));
  const error = h('p', { class: 'danger-text', role: 'alert' });
  const remove = h('button', { class: 'btn-danger', type: 'button', text: 'セッションを削除' });
  const dialog = h('dialog', { class: 'session-card-dialog', 'aria-labelledby': 'session-card-delete-title' },
    h('h2', { id: 'session-card-delete-title', text: 'セッションと会話履歴を削除しますか？' }),
    h('p', { text: `「${p.d.session.title}」の会話履歴と関連情報をCodexから永久に削除します。Canbanのメモ・ラベル・配置・タスクへの紐付けも削除します。元に戻せません。` }),
    h('p', { text: 'Codexが生成した子セッションも削除対象です。履歴を残して後で戻したい場合は、アーカイブをご利用ください。' }),
    error, h('div', { class: 'row' }, cancel, remove));
  cancel.onclick = () => dialog.close();
  remove.onclick = async () => {
    remove.disabled = true; cancel.disabled = true;
    try { await changeSessionCardState(p, 'delete'); dialog.close(); }
    catch (e) { error.textContent = e.message; remove.disabled = false; cancel.disabled = false; cancel.focus(); }
  };
  dialog.addEventListener('cancel', e => { if (remove.disabled) e.preventDefault(); });
  dialog.addEventListener('click', e => { if (e.target === dialog && !remove.disabled) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } });
  dialog.addEventListener('close', () => { dialog.remove(); if (p.el.isConnected) p.el.querySelector('[data-pane-key="Delete"]')?.focus({ preventScroll: true }); }, { once: true });
  document.body.append(dialog); dialog.showModal();
}
function sessionCardActions(p, card) {
  return [
    h('button', { class: 'side-btn', disabled: !p.d.session.actions?.available, 'data-pane-key': 'z', onclick: () => changeSessionCardState(p, card.archived ? 'restore' : 'archive').catch(() => {}) },
      h('span', { html: picon('box', 14) }), card.archived ? 'アーカイブから戻す' : 'アーカイブ', keycap('z')),
    h('button', { class: 'side-btn danger-text', disabled: !p.d.session.actions?.available, 'data-pane-key': 'Delete', onclick: () => confirmSessionCardDelete(p) },
      h('span', { html: picon('trash', 14) }), 'セッションを削除…', keycap('Delete')),
    h('p', { class: 'muted', text: p.d.session.actions?.reason || 'Codex本体に反映します。アーカイブは「アーカイブ済みも表示」から戻せます。' }),
  ];
}

function renderPane(p, d) {
  const el = p.el;
  const s = d.session;
  p.d = d;
  const b = state.board;
  const labelsById = new Map(b.labels.map((l) => [l.id, l]));
  const card = { ...d.card };

  const listSel = cardListControls(p, card.listId);
  const dirBtn = h('button', { class: 'side-btn', 'data-pane-key': 'g', onclick: (e) => directoryPicker(e.currentTarget, { id: s.id, cwd: s.cwd, directory: card.directory }, { explicit: card.directoryId, after: () => openCard(s.id) }) },
    h('span', { html: picon('folder', 14) }), `${card.directory ? card.directory.name : 'カテゴリ無し'}${card.directoryId ? '' : card.directory ? '（自動）' : ''}`, keycap('g'));

  const labelWrap = h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '4px' } });
  const paintLabels = () => labelWrap.replaceChildren(...(card.labels.length ? card.labels.map((id) => labelsById.get(id)).filter(Boolean).map((l) =>
    h('span', { class: 'chip', style: { background: colorVar(l.color), height: '24px', lineHeight: '24px', padding: '0 10px', color: 'var(--list-fg)', fontWeight: 600 }, text: l.name })) : [h('span', { class: 'muted', text: 'なし' })]));
  paintLabels();

  const note = h('textarea', { class: 'note', placeholder: 'メモを追加（このカンバンにだけ保存されます）', 'aria-label': 'メモ' });
  note.value = card.note;
  note.defaultValue = card.note;
  const saveNote = async () => { if (note.value !== card.note) { card.note = note.value; note.defaultValue = note.value; await act('canban_update_card', { cardId: s.id, note: note.value }, { okMsg: 'メモを保存しました' }); } };
  note.addEventListener('blur', saveNote);
  note.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveNote(); });

  const prio = h('select', { class: 'text-input', 'aria-label': '優先度' },
    h('option', { value: '', text: '未設定' }), h('option', { value: 'high', text: '高' }), h('option', { value: 'medium', text: '中' }), h('option', { value: 'low', text: '低' }));
  prio.value = card.priority || '';
  prio.onchange = () => act('canban_update_card', { cardId: s.id, priority: prio.value || null });
  const due = h('input', { class: 'text-input', type: 'date', 'aria-label': '期限' });
  due.value = card.due ? card.due.slice(0, 10) : '';
  due.onchange = () => act('canban_update_card', { cardId: s.id, due: due.value || null });

  const L = d.launch;
  if (L.claudeExecution) claudeExecutionHomes.set(s.id, L.claudeExecution.homeId);
  else claudeExecutionHomes.delete(s.id);
  const executionAccounts = L.claudeAccounts || [];
  const executionCommand = () => {
    const selected = claudeExecutionHomes.get(s.id);
    return selected ? executionAccounts.find(a => a.id === selected)?.command : L.terminal.command;
  };
  const executionIdentities = L.claudeExecutionAccounts || [];
  const executionKey = () => {
    const home = claudeExecutionHomes.get(s.id);
    return executionAccounts.find(a => a.id === home)?.account || (home ? L.claudeExecution?.account : null)
      || s.account || executionAccounts.find(a => a.id === (s.home || 'default'))?.account || '';
  };
  function saveExecutionHome(value) {
    const save = (async () => {
      accountPicker.disabled = true;
      try {
        const account = executionAccounts.find(a => a.id === value)?.account || null;
        const result = await bridge.callTool('canban_set_claude_execution', { cardId: s.id, claudeHome: value || null, account });
        L.claudeExecution = result.execution;
        if (result.execution) claudeExecutionHomes.set(s.id, result.execution.homeId); else claudeExecutionHomes.delete(s.id);
        L.claudeDesktopStatus = result.desktop;
          updateExecutionChoice();
          toast(result.desktop?.maintained ? 'CLI と Desktop に適用しました' : result.execution ? 'CLI に保存しました。Desktop は適用待ちです' : '元の CLI 設定に戻しました');
      } catch (error) {
        toast(error.message, true);
        throw error;
      } finally {
        accountPicker.value = executionKey(); accountPicker.repaint();
        accountPicker.disabled = false; updateExecutionChoice();
      }
    })();
    claudeExecutionPending.set(s.id, save);
    const done = () => { if (claudeExecutionPending.get(s.id) === save) claudeExecutionPending.delete(s.id); };
    save.then(done, done);
    return save;
  }
  function executionFooter() {
    const identity = executionIdentities.find(a => a.key === executionKey());
    const current = claudeExecutionHomes.get(s.id) || s.home || 'default';
    const rows = (identity?.profiles || []).map(home => h('label', { class: 'claude-profile-row', 'data-key': `${home.label} ${home.id} ${home.dir}`, title: `${home.dir}\n${home.id}` },
      h('input', { type: 'radio', name: `claude-profile-${s.id}`, value: home.id, checked: home.id === current,
        onchange: () => { closePopover(); saveExecutionHome(home.id).catch(() => {}); } }),
      h('span', { class: 'grow', text: home.label })));
    const details = h('details', { class: 'claude-execution-details' },
      h('summary', {}, h('span', { class: 'ic', html: picon('chev', 14) }), '接続設定を指定'),
      h('div', { class: 'claude-execution-help', text: identity ? accountName(identity.key) : '元のアカウント' }),
      rowFilter(rows, '設定名で検索'),
      h('div', { class: 'claude-profile-list', role: 'radiogroup', 'aria-label': 'Claude の接続設定' }, rows),
      h('code', { class: 'claude-profile-id', text: `現在の設定: ${current}` }));
    return h('div', { class: 'claude-execution-footer' }, details,
      h('div', { class: 'claude-execution-help', text: '同じアカウントの設定フォルダーを変更' }),
      h('button', { class: 'menu-item claude-execution-reset', text: '元の設定に戻す',
        title: '元の CLI 設定に戻します。Desktop の通常起動は現在の選択を維持します',
        onclick: () => { closePopover(); saveExecutionHome('').catch(() => {}); } }));
  }
  const accountPicker = executionIdentities.length ? pickerButton({
    title: 'Claude の実行アカウント', popoverTitle: '実行アカウント', value: executionKey(), stack: false, width: 340,
    placeholder: 'メールで検索', popoverClass: 'claude-identity-picker', footer: executionFooter,
    items: () => executionIdentities.map(a => ({ value: a.key, label: accountName(a.key), description: a.description, keywords: a.keywords,
      tag: a.sameAccount ? '元' : null, tagTitle: '元のアカウント' })),
    onChange: key => {
      const identity = executionIdentities.find(a => a.key === key);
      const savedHome = claudeExecutionHomes.get(s.id);
      const home = identity?.profiles.find(p => p.id === savedHome) || identity?.profiles.find(p => p.id === identity.preferredHomeId);
      if (home) saveExecutionHome(home.id).catch(() => {});
    },
  }) : null;
  if (accountPicker) accountPicker.classList.add('claude-account-picker');
  const term = currentTerminal(d.terminals, d.settings);
  const targetBtn = (target, label) => {
    const ok = !!term && term.targets.includes(target);
    return h('button', { class: 'seg-btn', disabled: !ok, title: ok ? `${term.label} で${label}` : `${term ? term.label : 'ターミナル'}では未対応`, text: label,
      onclick: () => resume(s.id, { route: 'terminal', target }) });
  };
  const resumeBox = s.sourceKind === 'codex-cloud' ? h('div', { class: 'resume-box' },
    h('button', { class: 'btn-primary resume-main', 'data-pane-key': 'o', type: 'button', title: L.desktop.url, onclick: () => resume(s.id, { route: 'desktop' }) }, h('span', { html: picon('free', 14) }), 'Codexで開く', ...keycap('o')),
    h('div', { class: 'muted', text: d.dispatch.unavailableReason })) : h('div', { class: 'resume-box' },
    accountPicker ? h('div', { class: 'field-label' }, h('span', { text: '実行アカウント' }), ...keycap('Alt+a')) : null,
    accountPicker,
    accountPicker ? h('div', { class: 'muted', text: '選択は CLI の再開と指示に使います。Desktop は別途適用状態を表示します。' }) : null,
    accountPicker ? h('div', { class: 'muted claude-thinking-note', text: '別アカウントでは過去の思考を再計算します。組織の思考に関する通知が出ても、会話履歴は引き継がれます。' }) : null,
    accountPicker ? h('div', { class: 'muted claude-desktop-account-note' }) : null,
    h('button', { class: 'btn-primary resume-main', 'data-pane-key': 'o', title: `既定: ${routeLabel(d.settings.launch.route, L)}・⌥ で切替\n${shortcutHelp()}`, onclick: (e) => resume(s.id, optsFromEvent(e)) },
      h('span', { text: '▶ 再開' }), ...keycap('o')),
    h('div', { class: 'field-label', text: 'デスクトップアプリ' }),
    L.desktop
      ? h('button', { class: 'side-btn', 'data-resume-desktop': '', text: `↗ ${L.desktop.label}`, title: L.desktop.url, onclick: () => resume(s.id, { route: 'desktop' }) })
      : h('div', { class: 'muted', text: s.host ? 'リモートのセッションはターミナルで再開します' : 'このセッションはデスクトップアプリでは開けません' }),
    L.desktop && L.desktop.note ? h('div', { class: 'muted', text: `${L.desktop.accountMismatch ? '⚠ ' : ''}${L.desktop.note}` }) : null,
    h('div', { class: 'field-label', text: `ターミナル${term ? `（${term.label}）` : ''}` }),
    term ? h('div', { class: 'seg-row' }, targetBtn('new-window', '新規ウィンドウ'), targetBtn('new-tab', '新規タブ'), targetBtn('split', '分割'), targetBtn('current', '既存ウィンドウ'))
      : h('div', { class: 'muted', text: '対応ターミナルが見つかりません' }),
    h('button', { class: 'side-btn', text: '⧉ 再開コマンドをコピー', onclick: () => { const command = executionCommand(); if (command) copyText(command, '再開コマンド'); else toast('選択したアカウントが見つかりません。実行先を選び直してください', true); } }),
  );

  function updateExecutionChoice() {
    const selected = claudeExecutionHomes.get(s.id);
    const option = executionAccounts.find(a => a.id === selected);
    const desktop = resumeBox.querySelector('[data-resume-desktop]');
    if (desktop) { desktop.disabled = !!selected && !option?.desktop?.link; desktop.title = selected ? option?.desktop?.reason || option?.desktop?.link?.note || '実行アカウントを選び直してください' : L.desktop.url; }
    const desktopNote = resumeBox.querySelector('.claude-desktop-account-note');
    if (desktopNote) {
        const status = L.claudeDesktopStatus;
        desktopNote.textContent = !selected ? '' : status?.pending ? `CLI に保存済み · Desktop は適用待ち。${status.reason}`
          : option?.desktop?.reason || (option?.desktop?.change ? 'CLI に保存済み · Desktop は適用待ち。アプリを終了してから再開すると適用します'
            : `Desktop の通常起動先: ${option?.desktop?.profile || '標準'}。起動済みアプリへの適用は再開時に確認します`);
      }
    resumeBox.querySelector('.resume-main').title = selected ? '選択した Claude CLI アカウントで再開' : `既定: ${routeLabel(d.settings.launch.route, L)}・⌥ で切替\n${shortcutHelp()}`;
    const note = p.el.querySelector('.claude-execution-note');
    if (note) note.textContent = selected ? `実行アカウント: ${option ? accountName(option.account) : '選択したアカウント（利用できません）'}` : `実行アカウント: ${s.accountLabel || '元のアカウント'}`;
  }
  updateExecutionChoice();

  const taskSel = pickerButton({ title: `${T.taskCard}に紐付け`, value: '', stack: false,
    items: () => [
      { value: '', label: d.task ? `紐付け中: ${d.task.title}` : `（${T.taskCard}に紐付けない）` },
      ...(d.tasks || []).filter((t) => !d.task || t.id !== d.task.id).map((t) => ({ value: t.id, label: t.title })),
      d.task ? { value: '__unlink', label: '紐付けを解除' } : null].filter(Boolean),
    onChange: (v) => onTask(v) });
  const onTask = async (v) => {
    if (!v) return;
    if (v === '__unlink') await act('canban_unlink_session', { taskId: d.task.id, sessionId: s.id }, { okMsg: '紐付けを解除しました' });
    else await act('canban_link_session', { taskId: v, sessionId: s.id }, { okMsg: `${T.taskCard}に紐付けました` });
    closeCards();
  };

  const msgs = d.recentMessages.length
    ? d.recentMessages.map((m) => h('div', { class: `msg ${m.role}` }, h('div', { class: 'who', text: `${m.role === 'user' ? 'ユーザー' : 'エージェント'}${m.at ? ` · ${fmtDate(Date.parse(m.at))}` : ''}` }), m.text))
    : [h('p', { class: 'muted', text: d.messagesError ? `メッセージを取得できませんでした: ${d.messagesError}` : 'メッセージはありません' })];

  const related = [
    d.task ? h('div', { class: 'msg' }, `このセッションは${T.taskCard} `, h('button', { class: 'link-btn', text: `「${d.task.title}」`, onclick: () => openCard(d.task.id) }), ' に紐付いています。') : null,
    d.children && d.children.length ? h('div', { class: 'sub-h', text: `サブエージェント（${d.children.length}）` }) : null,
    ...(d.children || []).map((c) => h('button', { class: 'sub-row', onclick: () => openCard(c.id) },
      h('span', { class: `sdot s-${c.status}` }), h('span', { class: 'ellipsis grow', text: c.agentName ? `${c.agentName}: ${c.title}` : c.title }),
      h('span', { class: 'muted', text: relTime(c.updatedAt) }))),
    d.parentId ? h('div', { class: 'msg' }, h('button', { class: 'link-btn', text: '↑ 親セッションを開く', onclick: () => openCard(d.parentId) })) : null,
    d.sameBranch && d.sameBranch.length ? h('div', { class: 'sub-h', text: `同じブランチのセッション（${d.sameBranch.length}）` }) : null,
    ...(d.sameBranch || []).map((c) => h('button', { class: 'sub-row', onclick: () => openCard(c.id) },
      h('span', { class: `sdot s-${c.status}` }), h('span', { class: `badge ${c.agent}`, text: c.agent === 'codex' ? 'Codex' : 'Claude' }),
      h('span', { class: 'ellipsis grow', text: c.title }), h('span', { class: 'muted', text: relTime(c.updatedAt) }))),
  ].filter(Boolean);

  // PANE_SECS supplies defaults; paneLayout controls the user's columns, order and sizes.
  const secs = {};
  secs.breadcrumb = { nodes: [cardCrumb(listSel, d.task)] };
  secs.title = { nodes: [h('h2', { text: s.title, title: s.title })] };
  secs.status = { nodes: [h('div', { class: 'sub row' }, h('span', { class: `badge ${s.agent}`, text: s.agent === 'codex' ? 'Codex' : 'Claude' }),
    s.host ? h('span', { class: 'host-chip', text: s.host.label }) : null,
    h('span', { class: 'row pane-status' }, h('span', { class: `sdot s-${s.status || 'idle'}` }), s.statusKnown === false ? '状態未取得' : STATUS_LABELS[s.status || 'idle']), h('span', { class: 'pill viewer-pill viewers', hidden: true }))] };
  secs.actions = { nodes: sessionCardActions(p, card) };
  secs.conv = { title: d.feed ? '会話' : '直近のやりとり', nodes: d.feed ? [renderFeed(d, p)] : msgs,
    extra: d.feed ? h('span', { class: `live-badge${live.on ? ' on' : ''}`, title: live.on ? 'セッションの変化をそのまま表示します' : '', text: live.on ? 'ライブ' : '' }) : null };
  if (d.feed) secs.progress = { nodes: [renderSignals(s.signals, d.git)] };
  secs.send = { nodes: [renderDispatch(d)], extra: d.dispatch.settings.enabled ? keycap('i') : null };
  if (card.slackRefs?.length) secs.slack = { nodes: [slackUi.sources(s.id, secs.send.nodes[0].querySelector('textarea'))] };
  secs.labels = { nodes: [labelWrap], extra: h('button', { class: 'link-btn', 'data-pane-key': 'l', text: '編集', onclick: e => labelPicker(e.currentTarget, s.id, card, paintLabels) }) };
  secs.memo = { nodes: [note] };
  secs.detail = { nodes: [h('dl', { class: 'kv' },
    ...kv('AI App', s.agent === 'codex' ? 'Codex' : 'Claude Code'),
    ...kv('マシン', s.sourceKind === 'codex-cloud' ? 'Codex Cloud' : s.host ? `${s.host.label}（SSH: ${s.host.alias}）` : 'このマシン'),
    ...(s.dot ? kv('dot', dotTitle(s)) : []),
    ...(s.cloud ? kv('保存済み情報の更新', s.cloud.cachedAt ? fmtDate(s.cloud.cachedAt) : '時刻不明') : []),
    ...accountKv(s),
    ...kv(`${T.category}`, card.directory ? `${card.directory.name}${card.directoryId ? '' : '（自動）'}` : 'カテゴリ無し'),
    ...kv(T.folder, s.folder || '-'),
    ...kv('作業ディレクトリ', s.cwd || '-'),
    ...kv('ブランチ', s.branch || '-'),
    ...kv('モデル', s.model || '-'),
    ...kv('作成', fmtDate(s.createdAt)),
    ...kv('最終更新', fmtDate(s.updatedAt)),
    ...kv('状態', [s.agent === 'claude' && !s.desktopKnown ? 'アーカイブ状態は不明（Claude デスクトップの情報がディスクにありません）' : s.archived ? 'アーカイブ済' : '進行中/未アーカイブ', s.pinnedInAgent ? '📌 Codex でピン留め' : null, s.subagent ? 'サブエージェント' : null, s.automation ? '⏰ Codex オートメーション' : null].filter(Boolean).join(' · ')),
  )] };
  if (d.pr) secs.pr = { title: d.pr.provider === 'gitlab' ? 'マージリクエスト' : 'プルリクエスト', extra: prPill(d.pr), nodes: [h('div', { class: 'msg' },
    h('button', { class: 'link-btn', text: `${d.pr.title}`, onclick: () => bridge.openLink(d.pr.url).catch(() => copyText(d.pr.url, 'PR の URL')) }),
    h('div', { class: 'muted', text: `${String(d.repo).replace(/^gitlab:/, 'GitLab: ')} · ${d.pr.branch}` }),
    ...(d.pr.checkRuns || []).map((c) => h('div', { class: 'check-row' }, h('span', { class: `ck ck-${/fail|error|cancel|timed/.test(c.state) ? 'failing' : /success|pass|neutral|skipped/.test(c.state) ? 'passing' : 'pending'}`, text: /fail|error|cancel|timed/.test(c.state) ? '✗' : /success|pass|neutral|skipped/.test(c.state) ? '✓' : '●' }), ` ${c.name}`)))] };
  if (related.length) secs.related = { nodes: related };
  secs.first = { nodes: [h('div', { class: 'msg user', text: s.preview || '-' })] };
  secs.resume = { nodes: [resumeBox] };
  secs.task = { nodes: [taskSel] };
  secs.add = { title: T.category, nodes: [dirBtn] };
  secs.prio = { nodes: [prio, due] };
  secs.other = { nodes: [
    s.prUrl ? h('button', { class: 'side-btn', text: '↗ PR を開く', onclick: () => bridge.openLink(s.prUrl).catch(() => copyText(s.prUrl, 'PR URL')) }) : null,
    h('button', { class: 'side-btn', text: '⧉ セッション ID をコピー', onclick: () => copyText(s.nativeId, 'セッション ID') }),
    s.sourcePath ? h('button', { class: 'side-btn', text: '⧉ ログのパスをコピー', onclick: () => copyText(s.sourcePath, 'パス') }) : null,
  ].filter(Boolean) };

  p.status = s.status || 'idle';
  p.activity = activityText(s.activity, p.status, s.signals);
  if (!d.feed) p.lastText = s.preview || '';
  el.setAttribute('aria-label', `セッション詳細: ${s.title}`);
  applyPaneAttrs(p);
  renderThreadPane(p, d, secs, { card, listSel });
  const prog = $('[data-sec="progress"]', el);
  if (prog && $('.sig-box', prog)?.hidden) $('.dsec-b', prog).append(h('span', { class: 'muted empty-progress', text: 'なし' }));
  paintPaneButtons(p);
  applyPaneAttrs(p);
  paintViewers(p);
  if (d.feed) scrollFeedToEnd(live.feeds.get(s.id));
  if (!live.on) watchRequests(el, d);
  workspace.trackDrafts(el);
}

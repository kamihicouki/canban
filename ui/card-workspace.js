// The same thread, controls and composer in a headerless context/conversation frame.
let cardWorkspaceActive = null, workspaceChangingShape = false;
const cardWorkspaceOn = () => normalizeCardShape(paneGlobal.shape) === 'workspace';
const workspacePane = () => panes.find(p => p.id === cardWorkspaceActive) || panes[0];
function setCardShape(shape) {
  const focus = document.activeElement, selection = focus && typeof focus.selectionStart === 'number' ? [focus.selectionStart, focus.selectionEnd, focus.selectionDirection] : null;
  const readings = panes.map(p => {
    const feed = live.feeds.get(p.id); if (!feed || p.el.hidden) return null;
    const edge = feed.list.getBoundingClientRect().top;
    const anchor = [...feed.list.children].find(el => el.getBoundingClientRect().bottom > edge);
    return { feed, anchor, offset: anchor ? anchor.getBoundingClientRect().top - edge : 0, following: atFeedEnd(feed.list) };
  }).filter(Boolean);
  paneGlobal.shape = normalizeCardShape(shape); saveGlobal();
  workspaceChangingShape = true;
  try { for (const p of panes) syncCardWorkspace(p); } finally { workspaceChangingShape = false; }
  syncWorkspaceSelection(); paintPaneBar(); paneMetrics();
  if (focus?.isConnected && document.activeElement !== focus) { focus.focus({preventScroll:true}); if (selection) focus.setSelectionRange(...selection); }
  for (const {feed,anchor,offset,following} of readings) {
    if (following) scrollFeedToEnd(feed);
    else if (anchor?.isConnected) feed.list.scrollTop += anchor.getBoundingClientRect().top - feed.list.getBoundingClientRect().top - offset;
  }
}
const toggleCardShape = () => setCardShape(cardWorkspaceOn() ? 'card' : 'workspace');
function syncWorkspaceSelection(id) {
  if (id && panes.some(p => p.id === id)) cardWorkspaceActive = id;
  if (!panes.some(p => p.id === cardWorkspaceActive)) cardWorkspaceActive = panes[0]?.id || null;
  for (const p of panes) {
    const hidden = cardWorkspaceOn() && p.kind !== 'view' && p.id !== cardWorkspaceActive;
    const feed = live.feeds.get(p.id);
    if (hidden && !p.el.hidden && feed) {
      const edge = feed.list.getBoundingClientRect().top;
      const anchor = [...feed.list.children].find(el => el.getBoundingClientRect().bottom > edge);
      p.workspaceReading = { top: feed.list.scrollTop, following: atFeedEnd(feed.list), anchor, offset: anchor ? anchor.getBoundingClientRect().top - edge : 0 };
    }
    const wasHidden = p.el.hidden;
    p.el.hidden = hidden;
    if (wasHidden && !hidden && feed && p.workspaceReading) {
      const reading = p.workspaceReading;
      if (reading.following) scrollFeedToEnd(feed);
      else { feed.list.scrollTop = reading.top; if (reading.anchor?.isConnected) feed.list.scrollTop += reading.anchor.getBoundingClientRect().top - feed.list.getBoundingClientRect().top - reading.offset; }
      delete p.workspaceReading;
    }
  }
  paneLayer.dataset.shape = cardWorkspaceOn() && panes[0]?.kind !== 'view' ? 'workspace' : 'card';
}
function workspaceContextOpen(p) {
  const key = paneDocked() ? 'docked' : 'wide';
  p.workspaceOpen ||= {};
  return p.workspaceOpen[key] ?? (!paneDocked() && (p.el.clientWidth || innerWidth) >= 900);
}
function toggleWorkspaceContext(p = workspacePane(), force) {
  if (!p?.workspaceFrame) return;
  p.workspaceOpen ||= {};
  const key = paneDocked() ? 'docked' : 'wide';
  p.workspaceOpen[key] = force ?? !workspaceContextOpen(p);
  if (p.workspaceOpen[key] && !p.timelineHidden) { p.timelineHidden = true; paintThreadTimeline(p); $$('[data-side-tab="timeline"]', p.el).forEach(button => button.setAttribute('aria-pressed', 'false')); }
  syncCardWorkspace(p);
  if (p.workspaceOpen[key]) p.workspaceFrame.aside.focus({ preventScroll: true });
  else p.el.querySelector('.ws-context-open')?.focus({ preventScroll: true });
}
function workspaceSummary(label, key, fn) {
  const text = h('span', { class: 'ws-excerpt' });
  const meta = h('span', { class: 'ws-observed' });
  const button = h('button', { class: 'ws-jump', type: 'button', onclick: fn, 'aria-keyshortcuts': key },
    h('span', { class: 'ws-section-title' }, label, ...keycap(key)), text, meta);
  return { button, text, meta };
}
function syncCardWorkspace(p) {
  if (!p?.el || p.kind === 'view') return;
  const body = p.el.querySelector(':scope > .th-body');
  if (!body) return;
  let frame = p.workspaceFrame;
  if (!frame || frame.body !== body) {
    const head = p.el.querySelector(':scope > .th-head'), meta = p.el.querySelector(':scope > .th-meta');
    if (!head || !meta) return;
    const strip = p.el.querySelector(':scope > .th-threads');
    const aside = h('aside', { class: 'ws-context', tabindex: -1, 'aria-label': '目的・起点・関連・現在地' });
    const collapse = h('button', { class: 'ws-control', type: 'button', onclick: () => toggleWorkspaceContext(p, false) }, '文脈を畳む ', ...keycap('q'));
    const origin = workspaceSummary(p.kind === 'task' ? '目的' : '起点', 's', () => jumpWorkspaceOrigin(p));
    const latest = workspaceSummary(p.kind === 'task' ? '最新の報告' : '最新の発言（観測）', 'e', () => jumpWorkspaceLatest(p));
    const related = h('section', { class: 'ws-related', 'aria-label': '関連する仕事と会話' });
    const relatedTitle = h('button', { class: 'ws-control', type: 'button', onclick: () => focusWorkspaceRelated(p) }, '関連 ', ...keycap('n'));
    const shape = h('button', { class: 'ws-control ws-shape', type: 'button', onclick: toggleCardShape, 'aria-keyshortcuts': 'w' });
    const identityTitle = h('span', { class: 'ws-current-title' }), identityState = h('span', { class: 'ws-current-state' });
    const compact = h('div', { class: 'ws-compact' }, identityTitle, identityState,
      h('button', { class: 'ws-control ws-context-open', type: 'button', onclick: () => toggleWorkspaceContext(p, true) }, '文脈 ', ...keycap('q')),
      h('button', { class: 'ws-control', type: 'button', onclick: () => jumpWorkspaceOrigin(p) }, p.kind === 'task' ? '目的 ' : '起点 ', ...keycap('s')),
      h('button', { class: 'ws-control', type: 'button', onclick: () => jumpWorkspaceLatest(p) }, p.kind === 'task' ? '報告 ' : '最新 ', ...keycap('e')));
    const footer = h('div', { class: 'ws-footer' });
    const controls = h('div', { class: 'ws-top-controls' }, collapse);
    frame = p.workspaceFrame = { body, head, meta, strip, aside, compact, collapse, origin, latest, related, relatedTitle, shape, footer, controls, identityTitle, identityState, detailNodes: p.detailNodes || [], relationNodes: [] };
    frame.relationNodes = frame.detailNodes.filter(node => ['related', 'cardRelations', 'pr', 'task'].includes(node.dataset.sec));
    aside.append(controls, head, meta, ...[strip].filter(Boolean), origin.button, latest.button, relatedTitle, related, footer);
  }
  const active = cardWorkspaceOn();
  p.el.dataset.shape = active ? 'workspace' : 'card';
  if (active) {
    // Never reparent an already mounted control: focused title edits keep their selection.
    if (frame.head.parentNode !== frame.aside) frame.aside.insertBefore(frame.head, frame.origin.button);
    if (frame.meta.parentNode !== frame.aside) frame.aside.insertBefore(frame.meta, frame.origin.button);
    if (frame.strip && frame.strip.parentNode !== frame.aside) frame.aside.insertBefore(frame.strip, frame.origin.button);
    p.detailNodes = frame.detailNodes.filter(node => !frame.relationNodes.includes(node));
    for (const node of frame.relationNodes) if (node.parentNode !== frame.related) frame.related.append(node);
    const taskLinks = p.el.querySelector('.th-task > [data-sec="related"]');
    if (taskLinks) { frame.taskLinks = taskLinks; frame.taskLinksNext = taskLinks.nextSibling; frame.taskLinksParent = taskLinks.parentNode; frame.related.append(taskLinks); }
    if (frame.shape.parentNode !== frame.controls) frame.controls.append(frame.shape);
    if (frame.aside.parentNode !== p.el) p.el.prepend(frame.aside, frame.compact);
    const open = workspaceContextOpen(p);
    p.el.dataset.contextOpen = String(open);
    frame.aside.hidden = !open; frame.compact.hidden = open;
    if (!open && frame.shape.parentNode !== frame.compact) frame.compact.append(frame.shape);
    frame.shape.replaceChildren('カード型 ', ...keycap('w'));
  } else {
    p.detailNodes = frame.detailNodes;
    if (frame.head.parentNode !== p.el) p.el.prepend(frame.head, ...[frame.strip].filter(Boolean), frame.meta);
    if (frame.taskLinks && frame.taskLinksParent) frame.taskLinksParent.insertBefore(frame.taskLinks, frame.taskLinksNext?.parentNode === frame.taskLinksParent ? frame.taskLinksNext : null);
    if (frame.shape.parentNode !== frame.head) frame.head.append(frame.shape);
    frame.shape.replaceChildren('2カラム ', ...keycap('w'));
    frame.aside.remove(); frame.compact.remove();
    const detailBody = p.el.querySelector('.th-side[data-tab="details"] .th-side-b');
    if (detailBody && frame.detailNodes.some(node => node.parentNode !== detailBody)) paintThreadSide(p);
  }
  if (!workspaceChangingShape) syncWorkspaceSelection();
  paintWorkspaceContext(p);
}
function paintWorkspaceContext(p) {
  const frame = p?.workspaceFrame; if (!frame) return;
  const task = p.taskCard || p.d?.card;
  const current = p.d?.session || p.pendingCard || task || {};
  frame.identityTitle.textContent = current.title || '会話を読み込み中'; frame.identityTitle.title = frame.identityTitle.textContent;
  const known = current.statusKnown !== false, currentStatus = live.feeds.get(p.id)?.status || current.status;
  const kindLabel = p.kind === 'task' ? T.taskCard : sessionKindLabel(current, { short: true });
  const statusLabel = known ? STATUS_LABELS[currentStatus] || '状態未取得' : '状態未取得';
  frame.identityState.textContent = `${kindLabel} · ${p.kind === 'task' ? '担当会話: ' : ''}${statusLabel}`;
  const origin = p.workspaceOrigin;
  frame.origin.text.textContent = p.kind === 'task' ? task?.description || '目的・説明は未記入です' : origin?.item?.text || p.d?.session?.preview || '冒頭の依頼はまだ取得していません';
  frame.origin.meta.textContent = p.kind === 'task' ? '保存されたタスクの説明' : origin ? origin.state === 'available' ? 'ログ先頭の原文' : `${origin.state === 'partial' ? '原文の一部' : '未取得'}: ${origin.reason || ''}` : '起点の抜粋・原文は押して取得';
  frame.origin.button.disabled = !!p.workspaceOriginLoading;
  if (p.workspaceOriginLoading) frame.origin.meta.textContent = 'ログ先頭の原文を取得中…';
  const feed = live.feeds.get(p.id), last = feed?.workspaceLast || workspaceLastMessage(p.d?.feed?.items);
  if (p.kind === 'task') {
    const handoff = p.workspaceTaskReport || task?.handoff;
    frame.latest.text.textContent = handoff?.latestNoteSummary?.text || handoff?.nextAction?.text || (typeof handoff?.nextAction === 'string' ? handoff.nextAction : '') || '最新の報告・次の行動は未取得です';
    const note = handoff?.latestNoteSummary;
    frame.latest.meta.textContent = `${p.workspaceTaskReport ? '最終取得した報告・提案' : '一覧の抜粋・現在は未確認'}${note?.at ? ' · ' + fmtDate(note.at) : ''}。完了承認とは別です`;
  } else {
    frame.latest.text.textContent = last?.text || p.d?.messagesError || '会話の発言は未取得です';
    const at = last?.at && Number.isFinite(Date.parse(last.at)) ? fmtDate(Date.parse(last.at)) : '発言時刻は未取得';
    frame.latest.meta.textContent = last ? `${last.k === 'user' ? 'あなた' : last.k === 'commentary' ? 'エージェント（作業中の発言）' : 'エージェント'} · ${at}` : '未取得を完了と扱いません';
  }
}
async function jumpWorkspaceOrigin(p = workspacePane()) {
  if (!p) return;
  if (p.kind === 'task') { p.el.querySelector('.th-task > [data-sec="conv"]')?.scrollIntoView({ block: 'start' }); return; }
  let feed = live.feeds.get(p.id);
  if (!feed) { toast('会話が取得できてから起点を開けます', true); return; }
  if (p.workspaceOriginLoading) return;
  if (!p.workspaceOrigin?.item || p.workspaceOrigin.state === 'unavailable') {
    p.workspaceOriginLoading = true; paintWorkspaceContext(p);
    try {
      const response = await bridge.callTool('canban_get_session', { cardId: p.id, messages: 1, includeOrigin: true });
      const data = response.result || response;
      p.workspaceOrigin = data.origin || { state: 'unavailable', item: null, reason: '接続先は起点の原文取得に未対応です' };
    } catch (e) { p.workspaceOrigin = { state: 'unavailable', item: null, reason: e.message }; }
    finally { p.workspaceOriginLoading = false; paintWorkspaceContext(p); }
  }
  const origin = p.workspaceOrigin;
  if (!origin?.item) { toast(origin?.reason || '起点の原文は取得できませんでした', true); return; }
  if (!p.el.isConnected || p.el.hidden) return;
  feed = live.feeds.get(p.id);
  if (!feed) return; // a reload may own a new list; navigate only the currently mounted feed
  let target = feed.list.querySelector('.ws-origin-message');
  if (!target && workspaceCanReuseOrigin(feed.fromStart, origin.item, p.d?.feed?.items) && feed.list.querySelector('.fi-user .raw')?.textContent === origin.item.text) target = feed.list.querySelector('.fi-user');
  if (!target) {
    target = feedItem(origin.item, feed); target.classList.add('ws-origin-message');
    const gap = h('p', { class: 'ws-origin-gap', text: `${origin.complete ? 'ログ先頭から取得した起点の原文' : '文字上限まで取得した起点の原文（一部）'}。この下は取得済みの会話です。中間の全発言を取得した表示ではありません。` });
    feed.list.prepend(target, gap);
  }
  target.tabIndex = -1; target.scrollIntoView({ block: 'start', behavior: 'instant' }); target.focus({ preventScroll: true });
}
function jumpWorkspaceLatest(p = workspacePane()) {
  if (!p) return;
  const feed = live.feeds.get(p.id);
  if (feed) { scrollFeedToEnd(feed); const last = [...feed.list.querySelectorAll('.fi-user,.fi-asst,.fi-note')].filter(el => !el.classList.contains('ws-origin-message')).at(-1); if (last) { last.tabIndex = -1; last.focus({ preventScroll: true }); } }
  else { const report = p.el.querySelector('.th-task > [data-sec="handoff"]'); if (report) { report.scrollIntoView({block:'start'}); report.tabIndex = -1; report.focus({preventScroll:true}); } }
}
function focusWorkspaceRelated(p = workspacePane()) {
  if (!p?.workspaceFrame) return;
  if (!cardWorkspaceOn()) setCardShape('workspace');
  if (!workspaceContextOpen(p)) toggleWorkspaceContext(p, true);
  const related = p.workspaceFrame.related;
  for (const details of related.querySelectorAll('details:not(.side-chat)')) details.open = true;
  (related.querySelector('button,a,summary') || p.workspaceFrame.relatedTitle).focus();
}
function cardWorkspaceAction(key, p = workspacePane()) {
  const run = { w: toggleCardShape, q: () => toggleWorkspaceContext(p), s: () => jumpWorkspaceOrigin(p), e: () => jumpWorkspaceLatest(p), n: () => focusWorkspaceRelated(p) }[key];
  if (!run) return false;
  run(); return true;
}

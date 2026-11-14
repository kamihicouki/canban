// Cross-board search augments the existing command picker; it never changes board filters.
function paletteCardDescription(card, reason = '') {
  const task = card.kind === 'task' || String(card.id || card.cardId || '').startsWith('task:');
  const surface = card.surface && SURFACE_META[card.surface]?.label;
  return [task ? T.taskCard : agentAppLabel(card.agent), task ? null : surface || '利用面未取得', card.subagent ? 'サブエージェント' : null, card.dot ? `dot · ${card.dot.name || 'dot'}` : null, card.statusKnown === false ? '状態未取得' : null, reason,
    card.directory?.name || (typeof card.directory === 'string' ? card.directory : null)].filter(Boolean).join(' · ');
}
function createPaletteSearchView({ cards, filters }) {
  let palette = null, status = null, progress = null;
  const controller = createPaletteSearch({ search: args => bridge.callTool('canban_search', args), onChange: () => {
    if (!palette?.isConnected) return;
    palette.refreshItems(); paintStatus();
  } });
  function paintStatus() {
    if (!status) return;
    const s = controller.state;
    progress.hidden = !s.loading;
    const messages = [];
    if ([...s.query].length >= 2 && !s.loading) {
      if (s.error) messages.push(`ボードの外を検索できません: ${s.error}`);
      else messages.push(`ボードの外: ${paletteOutsideRows(s.rows, cards, filters).length}件${s.total > s.rows.length ? `（検索結果の上位${s.rows.length}件内）` : ''}`);
      if (s.warnings.length) messages.push(`一部未取得: ${s.warnings.join(' / ')}`);
      const coverageWarning = paletteCoverageWarning(s.coverage);
      if (coverageWarning) messages.push(coverageWarning);
    }
    if (s.fulltext) messages.push(`本文で探せるのは直近${s.coverage?.fulltextDays || 90}日・3文字以上です`);
    status.textContent = messages.join('。');
  }
  return {
    items() {
      const s = controller.state;
      return paletteOutsideRows(s.rows, cards, filters).map(row => ({
        value: `outside:${row.cardId}`, cardId: row.cardId, label: row.title || row.cardId, group: 'ボードの外', badge: row.list,
        dot: row.statusKnown !== false && row.status !== 'idle' ? row.status : null,
        description: paletteCardDescription(row, row.outsideReason), hint: row.updatedAt ? relTime(Date.parse(row.updatedAt)) : '',
        // The server can match original requests, notes and indexed body without matching the title.
        keywords: `${s.query} ${row.agent || ''} ${row.surface || ''}`,
      }));
    },
    attach(p) {
      palette = p;
      progress = h('progress', { 'aria-label': 'ボードの外を検索中', hidden: true });
      status = h('div', { class: 'muted palette-search-status', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
      p.querySelector('.picker').append(h('div', { class: 'palette-search-footer' }, progress, status));
      const input = p.querySelector('.picker-input');
      const update = event => { if (!event?.isComposing) controller.update(input.value, { fulltext: !!filters.fulltext }); };
      input.addEventListener('input', update);
      input.addEventListener('compositionend', update);
      const close = p.onClose;
      p.onClose = () => { controller.dispose(); input.removeEventListener('input', update); input.removeEventListener('compositionend', update); close?.(); };
      update();
    },
  };
}

// Search references use the existing pane cache; their visit history is transient and bounded.
const paletteOutsideHistory = createPaletteVisitHistory({ max: 8 });
let returningPaletteOutside = false;
function paletteScrollSnapshot(root, selectors) {
  return selectors.flatMap(selector => [...root.querySelectorAll(selector)].map((node, index) => ({ root, selector, index, node, left: node.scrollLeft, top: node.scrollTop })));
}
function restorePaletteScrolls(entries) {
  for (const entry of entries) {
    const node = entry.node.isConnected ? entry.node : entry.root.querySelectorAll(entry.selector)[entry.index];
    if (node) { node.scrollLeft = entry.left; node.scrollTop = entry.top; }
  }
}
function capturePaletteOrigin() {
  const active = document.activeElement;
  const focusedId = active?.closest?.('.pane')?.dataset.cardId || active?.closest?.('.card')?.dataset.cardId || null;
  const field = active?.matches?.('input,textarea,select');
  return {
    ids: paneLayer.hidden ? [] : panes.map(p => p.id), hidden: paneLayer.hidden, docked: paneDocked(), view: state.boardView,
    panels: paneLayer.hidden ? [] : panes.map(p => ({ id: p.id, pane: p, feed: live.feeds.get(p.id), scrolls: paletteScrollSnapshot(p.el, ['.feed', '.th-conv', '.th-side', '.th-timeline-b', 'textarea']) })),
    scrolls: paletteScrollSnapshot(document, ['#board', '#board .inbox-list', '#board .cards', '#board .gantt-list', '#board .gantt-body', '#board .gantt-track']),
    stage: { left: paneStage.scrollLeft, top: paneStage.scrollTop }, inboxSel: state.inbox?.sel ?? null, ganttSel: state.gantt?.sel ?? null, cardReturn,
    focus: { node: active, cardId: focusedId, label: field ? active.getAttribute('aria-label') : null, field: !!field,
      value: field ? active.value : null, start: field ? active.selectionStart : null, end: field ? active.selectionEnd : null, direction: field ? active.selectionDirection : null },
  };
}
function rememberPaletteFeeds() {
  for (const p of panes) if (live.feeds.has(p.id)) p.paletteSavedFeed = live.feeds.get(p.id);
}
function canReturnPaletteOutsideCard() {
  return returningPaletteOutside || !paneLayer.hidden && paletteOutsideHistory.canReturn(panes.map(p => p.id));
}
async function openPaletteOutsideCard(cardId, origin = capturePaletteOrigin()) {
  paletteOutsideHistory.push(origin, cardId);
  rememberPaletteFeeds();
  try { await openCard(cardId); refreshShortcutHints(); }
  catch (error) { toast(error.message, true); }
}
function restorePaletteFocus(origin) {
  const focus = origin.focus;
  let node = focus.node?.isConnected ? focus.node : null;
  const pane = focus.cardId && panes.find(p => p.id === focus.cardId);
  if (!node && focus.field && pane) node = [...pane.el.querySelectorAll('input,textarea,select')].find(input => input.getAttribute('aria-label') === focus.label);
  if (!node && focus.cardId) node = document.querySelector(`.card[data-card-id="${CSS.escape(focus.cardId)}"]`) || pane?.el;
  if (!node && !origin.hidden) node = selectedDockedRow() || panes[0]?.el;
  node?.focus({ preventScroll: true });
  if (focus.field && node?.value === focus.value && Number.isInteger(focus.start)) {
    try { node.setSelectionRange(focus.start, focus.end, focus.direction || 'none'); } catch {}
  }
}
async function returnPaletteOutsideCard() {
  if (returningPaletteOutside) return true;
  const visit = paletteOutsideHistory.take(panes.map(p => p.id));
  if (!visit) return false;
  returningPaletteOutside = true;
  const origin = visit.origin;
  rememberPaletteFeeds();
  try {
    if (origin.hidden || !origin.ids.length) closeCards({ dock: false });
    else {
      for (const saved of origin.panels) if (!panes.some(p => p.id === saved.id) && !paneCache.has(saved.id)) paneCache.set(saved.id, saved.pane);
      showCards(origin.ids, { dock: origin.docked });
      for (const saved of origin.panels) {
        const p = panes.find(p => p.id === saved.id);
        if (!p) continue;
        const feed = p.paletteSavedFeed || saved.feed;
        if (feed?.list && p.el.contains(feed.list)) live.feeds.set(p.id, feed);
        else if (p.kind === 'session') await loadSession(p, { restore: true });
        else if (p.kind === 'task') { const found = findCard(p.id); if (found) await loadTask(p, found); }
      }
      cardReturn = origin.cardReturn;
    }
    if (state.inbox) {
      if (origin.inboxSel && timelineOn()) markInboxSel(origin.inboxSel);
      else state.inbox.sel = origin.inboxSel;
    }
    if (state.gantt) {
      state.gantt.sel = origin.ganttSel;
      for (const row of document.querySelectorAll('.gantt-row')) row.setAttribute('aria-selected', String(row.dataset.cardId === origin.ganttSel));
    }
    const restore = () => {
      restorePaletteScrolls(origin.scrolls);
      for (const saved of origin.panels) restorePaletteScrolls(saved.scrolls);
      paneStage.scrollLeft = origin.stage.left; paneStage.scrollTop = origin.stage.top;
    };
    restore();
    await new Promise(resolve => requestAnimationFrame(resolve));
    restore(); restorePaletteFocus(origin);
    kickLive(); refreshShortcutHints();
    return true;
  } catch (error) {
    paletteOutsideHistory.restore(visit); toast(`参照元へ戻れませんでした: ${error.message}`, true); return false;
  } finally { returningPaletteOutside = false; refreshShortcutHints(); }
}

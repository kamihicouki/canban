// Each secondary component keeps its own presentation preference in one shared map.
const AUXILIARY_PARTS = { ribbon: '時間の帯', card: 'カード表示', hud: '実行状況', dock: '場所' };
const normalizeAuxiliaryMode = value => value === 'pinned' ? 'pinned' : 'minimal';
function normalizeAuxiliaryPrefs(value, legacy = 'minimal') {
  const fallback = normalizeAuxiliaryMode(legacy);
  return Object.fromEntries(Object.keys(AUXILIARY_PARTS).map(key => [key, value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key) ? normalizeAuxiliaryMode(value[key]) : fallback]));
}
function nextAuxiliaryPrefs(value, key, mode) {
  const prefs = normalizeAuxiliaryPrefs(value);
  if (key == null) return Object.fromEntries(Object.keys(AUXILIARY_PARTS).map(part => [part, normalizeAuxiliaryMode(mode)]));
  return Object.hasOwn(AUXILIARY_PARTS, key) ? { ...prefs, [key]: normalizeAuxiliaryMode(mode) } : prefs;
}
function auxiliaryModeSummary(value) {
  const modes = Object.values(normalizeAuxiliaryPrefs(value));
  return modes.every(mode => mode === 'pinned') ? 'pinned' : modes.every(mode => mode === 'minimal') ? 'minimal' : 'mixed';
}
function auxiliaryLiveCards(board) {
  const cards = board?.lists?.flatMap(list => list.cards || []) || [], sessions = new Map();
  for (const card of cards) if (card.kind !== 'task') sessions.set(card.id, card);
  for (const task of cards) if (task.kind === 'task') for (const link of task.links || []) {
    if (link && typeof link.id === 'string') sessions.set(link.id, { ...sessions.get(link.id), ...link });
  }
  return [...sessions.values()].filter(card => card.statusKnown !== false && ['running', 'waiting'].includes(card.status));
}
// Secondary chrome state. The old single preference is read only as a migration fallback.
state.auxiliaryPrefs = normalizeAuxiliaryPrefs(store.get('auxiliaryPrefs', null), store.get('auxiliaryMode', null));
state.auxiliaryMode = auxiliaryModeSummary(state.auxiliaryPrefs);
let auxiliaryPanel = null;
const auxiliaryPreference = key => state.auxiliaryPrefs?.[key] || 'minimal';
function auxiliaryNode(key) {
  if (key === 'ribbon') return $('#ribbon');
  if (key === 'card') return typeof paneBar !== 'undefined' ? paneBar : null;
  if (typeof layoutParts === 'undefined') return null;
  return key === 'hud' ? layoutParts.hud : key === 'dock' ? layoutParts.dockItems : null;
}
function auxiliarySummary(key) {
  if (key === 'ribbon') {
    const period = Number(state.filters?.days) ? `${state.filters.days}日` : '全期間';
    const lens = state.lensPreview || state.lens;
    const lit = lens ? lens.life ? LIFE_LABELS[lens.life] : dayLabel(lens.day) : '';
    return `期間 ${period}${lit ? ` · 照らし中 ${lit}` : ''}`;
  }
  if (key === 'card') return PANE_MODES.find(([mode]) => mode === paneGlobal.mode)?.[1] || 'プレビュー';
  if (key === 'hud') {
    const waiting = auxiliaryLiveCards(state.board).filter(card => card.status === 'waiting').length;
    return `入力待ち ${waiting}`;
  }
  return '場所';
}
function auxiliaryExists(key) {
  if (key === 'card') return typeof paneLayer !== 'undefined' && !paneLayer.hidden && typeof panes !== 'undefined' && panes[0]?.kind !== 'view';
  return !!auxiliaryNode(key);
}
function applyAuxiliaryUi() {
  state.auxiliaryMode = auxiliaryModeSummary(state.auxiliaryPrefs);
  document.body.dataset.auxiliaryMode = state.auxiliaryMode;
  let headerChanged = false;
  for (const key of Object.keys(AUXILIARY_PARTS)) {
    const node = auxiliaryNode(key); if (!node) continue;
    const inPanel = !!node.closest('.auxiliary-panel');
    const pinned = auxiliaryPreference(key) === 'pinned';
    node.hidden = !inPanel && !pinned;
    if (key === 'hud') node.inert = !inPanel && typeof overlayOpen === 'function' && overlayOpen();
    let minimize = node.querySelector(':scope > [data-auxiliary-minimize]');
    if (!minimize) {
      minimize = h('button', { class: 'auxiliary-minimize', type: 'button', 'data-auxiliary-minimize': key, 'aria-label': `${AUXILIARY_PARTS[key]}を最小にする`, title: `${AUXILIARY_PARTS[key]}を最小にする（⌘Kでも選択）`, onclick: () => setAuxiliaryPreference(key, 'minimal') }, h('span', { html: picon('pin', 12) }), '最小');
      node.append(minimize);
    }
    minimize.hidden = !pinned || inPanel;
  }
  if (typeof layoutParts !== 'undefined') {
    const minimalDock = auxiliaryPreference('dock') !== 'pinned';
    const dockTrigger = layoutParts.dockOpen;
    if (dockTrigger) {
      const target = minimalDock ? $('#auxiliaryFragments') : layoutParts.dock;
      if (target && dockTrigger.parentElement !== target) { target.prepend(dockTrigger); headerChanged = true; }
      dockTrigger.hidden = !minimalDock;
      dockTrigger.classList.toggle('hbtn', minimalDock);
      dockTrigger.classList.toggle('auxiliary-fragment', minimalDock);
      dockTrigger.setAttribute('aria-haspopup', 'dialog');
      dockTrigger.setAttribute('aria-expanded', String(auxiliaryPanel?.key === 'dock'));
    }
    if (layoutParts.dock) {
      layoutParts.dock.dataset.auxiliaryMode = auxiliaryPreference('dock');
      layoutParts.dock.hidden = minimalDock;
    }
  }
  for (const button of $$('[data-auxiliary-open]', $('#auxiliaryFragments') || document.createElement('div'))) {
    const key = button.dataset.auxiliaryOpen;
    const hidden = !auxiliaryExists(key) || auxiliaryPreference(key) === 'pinned', summary = auxiliarySummary(key);
    headerChanged ||= button.hidden !== hidden || button.textContent !== summary;
    button.hidden = hidden; button.textContent = summary;
    button.title = `${AUXILIARY_PARTS[key]}を開く · ${button.textContent}`;
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-expanded', String(auxiliaryPanel?.key === key));
  }
  const button = $('#auxiliaryBtn');
  if (button) {
    const pinned = state.auxiliaryMode === 'pinned', label = `補助表示をすべて${pinned ? '最小にする' : '固定する'}`;
    headerChanged ||= button.getAttribute('aria-label') !== label;
    button.setAttribute('aria-pressed', String(pinned)); button.setAttribute('aria-label', label); button.title = `${label}（Alt+Shift+U）`;
    button.replaceChildren(h('span', { html: picon('layout', 15) }), h('span', { class: 'lbl', text: state.auxiliaryMode === 'mixed' ? '個別' : pinned ? '固定' : '最小' }));
  }
  if (headerChanged) fitHeader();
}
function commitAuxiliaryPrefs(prefs) {
  if (auxiliaryPanel) closePopover(auxiliaryPanel.panel);
  state.auxiliaryPrefs = normalizeAuxiliaryPrefs(prefs);
  state.auxiliaryMode = auxiliaryModeSummary(state.auxiliaryPrefs);
  store.set('auxiliaryPrefs', { ...state.auxiliaryPrefs });
  if (state.lensPreview && typeof previewLens === 'function') previewLens(null);
  applyAuxiliaryUi();
  if (typeof paneMetrics === 'function') paneMetrics();
  if (typeof syncDockedCard === 'function') syncDockedCard();
  fitHeader();
}
function setAuxiliaryPreference(key, mode) {
  commitAuxiliaryPrefs(nextAuxiliaryPrefs(state.auxiliaryPrefs, key, mode));
  if (mode === 'minimal') (key === 'dock' ? layoutParts.dockOpen : $(`[data-auxiliary-open="${key}"]`))?.focus({ preventScroll: true });
}
function setAuxiliaryMode(value) { commitAuxiliaryPrefs(nextAuxiliaryPrefs(state.auxiliaryPrefs, null, value)); }
function toggleAuxiliaryUi() { setAuxiliaryMode(state.auxiliaryMode === 'pinned' ? 'minimal' : 'pinned'); }
function auxiliaryCommands() {
  return Object.entries(AUXILIARY_PARTS).filter(([key]) => auxiliaryExists(key)).map(([key, label]) => ({
    label: `${label}を${auxiliaryPreference(key) === 'pinned' ? '最小にする' : '固定する'}`,
    run: () => setAuxiliaryPreference(key, auxiliaryPreference(key) === 'pinned' ? 'minimal' : 'pinned'),
  }));
}
function buildAuxiliaryUi() {
  if (!$('#auxiliaryBtn')) $('#viewSwitch').after(h('button', { id: 'auxiliaryBtn', class: 'hbtn auxiliary-toggle', type: 'button', 'data-pri': '2', 'aria-keyshortcuts': 'Alt+Shift+U', onclick: toggleAuxiliaryUi }));
  if (!$('#auxiliaryFragments')) $('#auxiliaryBtn').after(h('div', { id: 'auxiliaryFragments', class: 'auxiliary-fragments', role: 'group', 'aria-label': '最小の補助表示', 'data-pri': '9' },
    ...['ribbon', 'card', 'hud'].map(key => h('button', { class: 'hbtn auxiliary-fragment', type: 'button', 'data-auxiliary-open': key, 'aria-haspopup': 'dialog', onclick: event => openAuxiliaryPanel(key, event.currentTarget) }))));
  applyAuxiliaryUi();
}
function openAuxiliaryPanel(key, anchor) {
  if (auxiliaryPanel?.key === key) return closePopover(auxiliaryPanel.panel);
  if (auxiliaryPanel) closePopover(auxiliaryPanel.panel);
  const node = auxiliaryNode(key); if (!node || !auxiliaryExists(key)) return;
  const trigger = anchor || $(`[data-auxiliary-open="${key}"]`) || $('#auxiliaryBtn');
  const marker = document.createComment(`auxiliary:${key}`); node.before(marker);
  const wasInert = node.inert; node.hidden = false; node.inert = false;
  const pin = () => {
    const next = auxiliaryPreference(key) === 'pinned' ? 'minimal' : 'pinned';
    setAuxiliaryPreference(key, next);
    if (next === 'pinned') {
      const target = node.inert ? $('#auxiliaryBtn') : key === 'ribbon' ? node.querySelector('[data-auxiliary-minimize]') : node.querySelector('button:not([disabled]):not([hidden])');
      target?.focus({ preventScroll: true });
    }
  };
  const toggle = h('button', { type: 'button', class: 'menu-item auxiliary-pin', onclick: pin, 'aria-keyshortcuts': 'p' }, h('span', { html: picon('pin', 14) }), auxiliaryPreference(key) === 'pinned' ? '最小にする' : '固定する', ...keycap('p'));
  const body = h('div', { class: 'auxiliary-content' }, toggle, node);
  const panel = popover(trigger, AUXILIARY_PARTS[key], body, { width: key === 'ribbon' ? 560 : 460, placement: key === 'dock' && !trigger.closest('#auxiliaryFragments') ? 'top' : 'bottom' });
  panel.classList.add('auxiliary-panel');
  auxiliaryPanel = { key, node, panel };
  panel.onClose = () => {
    if (marker.isConnected) marker.replaceWith(node); else node.remove();
    node.inert = wasInert; if (auxiliaryPanel?.panel === panel) auxiliaryPanel = null;
    if (key === 'ribbon' && typeof previewLens === 'function') previewLens(null); else applyAuxiliaryUi();
  };
  panel.addEventListener('keydown', event => {
    if (event.key.toLowerCase() !== 'p' || event.metaKey || event.ctrlKey || event.altKey || event.isComposing || event.target.closest('input,textarea,select,[contenteditable]')) return;
    event.preventDefault(); event.stopPropagation(); pin();
  });
  applyAuxiliaryUi();
  panel.querySelector('button:not([disabled]):not(.close)')?.focus();
}
function openMinimalDock(anchor) { openAuxiliaryPanel('dock', anchor); }

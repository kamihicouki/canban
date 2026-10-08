// Part of board.html: included into its script by server/ui.mjs and shares its scope.
// Theme & lifecycle
// The user's choice (light / dark / system) wins; "system" follows the host app, then the OS.
const THEME_PREFS = ['light', 'dark', 'system'];
function applyTheme(host = state.hostTheme) {
  const pref = THEME_PREFS.includes(state.themePref) ? state.themePref : 'system';
  const theme = pref !== 'system' ? pref : host === 'dark' || host === 'light' ? host : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;
}
function setThemePref(pref) {
  state.themePref = THEME_PREFS.includes(pref) ? pref : 'system';
  store.set('themePref', state.themePref);
  applyTheme();
}
bridge.on('ui/notifications/host-context-changed', (p) => { if (p?.theme) { state.hostTheme = p.theme; applyTheme(); } });
window.addEventListener('openai:set_globals', (e) => { const t = e.detail?.globals?.theme; if (t) { state.hostTheme = t; applyTheme(); } });
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme());

function sharedUiSnapshot() {
  return {
    slackVisible: slackUi.visible, filters: { ...state.filters }, themePref: state.themePref, boardView: state.view, sidebar: state.sideOpen, workspacePage: workspace.page,
    paneGlobal: { ...paneGlobal }, cardWidths: { ...cardWidths }, cardBoard: structuredClone(cardBoardState), cardHeights: { ...cardHeights }, collapsedLanes: [...collapsedLanes],
  };
}

function sharedUiRecord(result) { return result?.result ?? result; }

function adoptSharedUi(record) {
  const value = record?.state;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  sharedUi.applying = true;
  try {
    for (const key of SHARED_UI_KEYS) if (Object.hasOwn(value, key)) store.cache(key, value[key]);
    if (value.filters && typeof value.filters === 'object' && !Array.isArray(value.filters)) state.filters = { ...DEFAULT_FILTERS, ...value.filters };
    if (typeof value.sidebar === 'boolean') state.sideOpen = value.sidebar;
    if (typeof value.slackVisible === 'boolean') { slackUi.visible = value.slackVisible; if (slackUi.visible) slackUi.refresh(); }
    if (typeof value.themePref === 'string') { state.themePref = value.themePref; applyTheme(); }
    if (value.boardView === 'board' || value.boardView === 'timeline') state.view = value.boardView;
    if (value.paneGlobal && typeof value.paneGlobal === 'object') Object.assign(paneGlobal, { mode: oneOf(value.paneGlobal.mode, PANE_MODES, PANE_DEF.mode) });
    if (value.cardWidths) Object.assign(cardWidths, normalizeCardWidths(value.cardWidths));
    if (value.cardBoard) cardBoardState = normalizeCardBoard(value.cardBoard);
    if (value.cardHeights) Object.assign(cardHeights, normalizeCardHeights(value.cardHeights));
    workspace.navigate(workspacePage(value.workspacePage), { save: false, reload: false });
    if (Array.isArray(value.collapsedLanes)) {
      collapsedLanes.clear();
      for (const name of value.collapsedLanes) if (typeof name === 'string') collapsedLanes.add(name);
    }
    sharedUi.revision = record.revision;
    sharedUi.dirty = false;
    sharedUi.blocked = false;
    store.cache('sharedUiPending', null);
  } finally {
    sharedUi.applying = false;
  }
  $('#sharedUiConflict')?.remove();
  return true;
}

async function applySharedUi(record, { redraw = true } = {}) {
  if (!record?.state) return;
  if (hasUnsavedPaneInput()) {
    toast('入力途中の内容を保持しています。保存または入力を消してから共有状態を読み込んでください。', true);
    return;
  }
  const wasApplying = sharedUi.applying;
  sharedUi.applying = true;
  let adopted;
  try { adopted = adoptSharedUi(record); }
  finally { sharedUi.applying = wasApplying; }
  if (!adopted) return;
  applyCardWidths(); layoutCardBoard(); panes.forEach(applyPaneAttrs); paintPaneBar();
  if (redraw) {
    await load();
    if (state.board) renderSidebar(state.board);
    render();
  }
}

async function reloadSharedUi() {
  try {
    const result = sharedUiRecord(await bridge.callTool('canban_get_ui_state'));
    if (result?.state) await applySharedUi(result);
    else {
      sharedUi.revision = result?.revision ?? sharedUi.revision;
      sharedUi.dirty = false; sharedUi.blocked = false;
      store.cache('sharedUiPending', null); $('#sharedUiConflict')?.remove();
    }
  } catch (error) { toast(`共有状態を読み込めませんでした: ${error.message}`, true); }
}
function notifySharedUiConflict() {
  if ($('#sharedUiConflict')) return;
  const notice = h('div', { id: 'sharedUiConflict', class: 'toast error', role: 'alert' },
    '別のCanban画面で状態が更新されました。この画面からの同期を止めています。 ',
    h('button', { class: 'toast-btn', text: '共有状態を読み込む', onclick: () => reloadSharedUi() }));
  document.body.append(notice); clearTimeout(toastTimer);
}

function scheduleSharedUiSave() {
  if (!sharedUi.ready || sharedUi.blocked || sharedUi.inflight) return;
  clearTimeout(sharedUi.timer);
  sharedUi.timer = setTimeout(flushSharedUi, 350);
}

async function flushSharedUi() {
  if (!sharedUi.ready || !sharedUi.dirty || sharedUi.blocked || sharedUi.inflight) return;
  if (!Number.isSafeInteger(sharedUi.revision)) return;
  sharedUi.inflight = true;
  const generation = sharedUi.generation;
  try {
    const result = sharedUiRecord(await bridge.callTool('canban_save_ui_state', { expectedRevision: sharedUi.revision, state: sharedUiSnapshot() }));
    if (result?.conflict) {
      sharedUi.blocked = true;
      notifySharedUiConflict();
    } else if (result?.saved) {
      sharedUi.revision = result.revision;
      sharedUi.dirty = sharedUi.generation !== generation;
      store.cache('sharedUiPending', sharedUi.dirty ? { revision: sharedUi.revision } : null);
    }
  } catch (error) {
    console.warn('canban: shared screen state save failed', error);
  } finally {
    sharedUi.inflight = false;
    if (sharedUi.dirty && !sharedUi.blocked) scheduleSharedUiSave();
  }
}

async function initializeSharedUi() {
  try {
    const current = sharedUiRecord(await bridge.callTool('canban_get_ui_state'));
    const pending = store.get('sharedUiPending', null);
    if (pending && Number.isSafeInteger(pending.revision)) {
      sharedUi.revision = pending.revision;
      sharedUi.dirty = true;
      sharedUi.ready = true;
      if (current.revision !== pending.revision) {
        sharedUi.blocked = true;
        notifySharedUiConflict();
      } else scheduleSharedUiSave();
      return;
    }
    sharedUi.revision = current.revision;
    if (current.state) adoptSharedUi(current);
    else {
      const result = sharedUiRecord(await bridge.callTool('canban_save_ui_state', { expectedRevision: current.revision, state: sharedUiSnapshot() }));
      if (result?.saved) sharedUi.revision = result.revision;
      else if (result?.conflict && result.state) adoptSharedUi(result);
    }
    sharedUi.ready = true;
  } catch (error) {
    sharedUi.revision = 0;
    sharedUi.ready = true;
    console.warn('canban: shared screen state load failed', error);
  }
}

function hasUnsavedPaneInput() {
  if ([...paneCache.values()].some((p) => workspace.hasDrafts(p.el))) return true;
  if ([...promptDrafts.values()].some(d => d.images.length || d.skills.length || d.sending || d.text !== d.baseline)) return true;
  return workspace.hasDrafts() || [...document.querySelectorAll('.send-box textarea')].some((input) => input.value.trim())
    || [...document.querySelectorAll('textarea.note')].some((input) => input.value !== input.defaultValue);
}

let lastSharedUiCheck = 0;
async function checkSharedUiOnReturn() {
  if (!sharedUi.ready || !idle() || document.visibilityState !== 'visible' || sharedUi.blocked || sharedUi.inflight) return;
  // Rebuilding panes must preserve prompts and card notes still being edited.
  if (hasUnsavedPaneInput()) return;
  if (Date.now() - lastSharedUiCheck < 800) return;
  lastSharedUiCheck = Date.now();
  const generation = sharedUi.generation;
  try {
    const result = sharedUiRecord(await bridge.callTool('canban_get_ui_state'));
    if (result.revision === sharedUi.revision) {
      if (sharedUi.dirty) scheduleSharedUiSave();
      return;
    }
    if (sharedUi.dirty || generation !== sharedUi.generation) {
      sharedUi.blocked = true;
      notifySharedUiConflict();
      return;
    }
    if (hasUnsavedPaneInput()) return;
    await applySharedUi(result);
  } catch (error) {
    console.warn('canban: shared screen state refresh failed', error);
  }
}

function scheduleSharedUiCheck() {
  clearTimeout(sharedUi.checkTimer);
  sharedUi.checkTimer = setTimeout(checkSharedUiOnReturn, 150);
}

function idle() { return !state.drag && !document.querySelector('.popover, .list-title-input, .composer, .peek-input:focus'); }
let lastPoll = 0;
setInterval(() => {
  // With the live watch on, this is only a safety net (remote hosts, missed events).
  const every = live.on ? (state.board && hasLive(state.board) ? 30000 : 120000) : state.board && hasLive(state.board) ? 15000 : 60000;
  if (Date.now() - lastPoll < every || document.visibilityState !== 'visible' || !idle()) return;
  lastPoll = Date.now();
  load();
}, 5000);
window.addEventListener('focus', () => { scheduleSharedUiCheck(); if (idle()) load(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSharedUiCheck(); });
window.addEventListener('resize', () => bridge.reportSize());

(async () => {
  const ctx = await bridge.init();
  state.hostTheme = ctx.theme;
  applyTheme(ctx.theme);
  if (ctx.displayMode === 'inline') {
    $('#refresh').after(h('button', { class: 'hbtn', title: '全画面で開く', 'aria-label': '全画面で開く', text: '⤢', onclick: () => bridge.requestFullscreen() }));
  }
  await initializeSharedUi();
  await load();
  live.on = true;
  liveLoop();
  await restoreCards();
})();

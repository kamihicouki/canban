// Part of board.html: included into its script by server/ui.mjs and shares its scope.
// Resume (desktop app / terminal) and its shortcuts
const TARGET_LABELS = { 'new-window': '新規ウィンドウ', 'new-tab': '新規タブ', split: '分割', current: '既存ウィンドウ' };
const TERMINAL_NAMES = { ghostty: 'Ghostty', terminal: 'Terminal.app', iterm: 'iTerm2' };
function launchPrefs() { return state.board?.settings?.launch || { route: 'desktop', terminal: 'terminal', target: 'new-window' }; }
function currentTerminal(terminals = state.board?.terminals || [], settings = state.board?.settings) {
  const want = settings?.launch?.terminal;
  return terminals.find((t) => t.id === want) || terminals[0] || null;
}
function routeLabel(route, launch) {
  if (route === 'desktop' && launch && !launch.desktop) return 'ターミナル';
  return route === 'desktop' ? 'デスクトップアプリ' : `ターミナル・${TARGET_LABELS[launchPrefs().target]}`;
}
// Click modifiers: ⌥ = the other route, ⇧ = terminal new window, ⌘ = terminal new tab, ⌃ = terminal existing window.
function optsFromEvent(e) {
  if (e.shiftKey) return { route: 'terminal', target: 'new-window' };
  if (e.metaKey) return { route: 'terminal', target: 'new-tab' };
  if (e.ctrlKey) return { route: 'terminal', target: 'current' };
  if (e.altKey) return { route: launchPrefs().route === 'desktop' ? 'terminal' : 'desktop' };
  return {};
}
// Keys on a focused card.
const claudeExecutionHomes = new Map();
const claudeExecutionPending = new Map();
const CARD_KEYS = {
  o: {},
  d: { route: 'desktop' },
  t: { route: 'terminal' },
  w: { route: 'terminal', target: 'new-window' },
  n: { route: 'terminal', target: 'new-tab' },
  s: { route: 'terminal', target: 'split' },
  e: { route: 'terminal', target: 'current' },
};
function shortcutHelp() {
  return 'クリック: 既定 / ⌥: もう一方の経路 / ⇧: 新規ウィンドウ / ⌘: 新規タブ / ⌃: 既存ウィンドウ';
}
async function resume(cardId, opts = {}) {
  try {
    await claudeExecutionPending.get(cardId);
    const r = await bridge.callTool('canban_open_session', { cardId, ...opts });
    if (r.route === 'desktop') toast(r.exact ? 'デスクトップアプリで開きました' : 'フォルダを開きました（続きはターミナルで再開できます）');
    else toast(`${TERMINAL_NAMES[r.terminal] || 'ターミナル'}で再開しました（${TARGET_LABELS[r.target] || r.target}${r.fellBack ? '・未対応のため新規ウィンドウ' : ''}）`);
  } catch (e) {
    toast(e.message, true);
  }
}

// Clipboard with a visible fallback (sandboxed iframes may block both clipboard and prompt()).
async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label}をコピーしました`);
    return;
  } catch {}
  const input = h('input', { class: 'text-input', readonly: true, value: text, 'aria-label': label });
  const p = popover(document.activeElement || document.body, `${label}（⌘C でコピー）`, h('div', {}, input));
  p.style.left = '50%'; p.style.top = '30%'; p.style.transform = 'translateX(-50%)';
  input.focus(); input.select();
}

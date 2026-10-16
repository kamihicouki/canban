// Part of board.html: included into its script by server/ui.mjs and shares its scope.
// The card's terminal: a shell at the session's project root in the thread's right panel (t), so the work can be
// checked without leaving Canban. The shell lives on the server (server/terminal.mjs) per card while Canban runs;
// closing the card keeps it, and opening the card again shows the same screen. Local sessions only.
const cardTerms = new Map(); // cardId → { term, fit, host, id, offset, closed, reading, error }
const TERM_KEYS = { leave: 'Shift+Esc' };

function termTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return { background: v('--term-bg'), foreground: v('--term-fg'), cursor: v('--term-cursor'), cursorAccent: v('--term-bg'), selectionBackground: v('--term-sel') };
}

function termCall(name, args) { return bridge.callTool(name, args).then((r) => r.result ?? r); }

function terminalPanel(p) {
  const cardId = p.id;
  let t = cardTerms.get(cardId);
  if (!t) {
    const host = h('div', { class: 'term-host' });
    const term = new Terminal({ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, lineHeight: 1.15, cursorBlink: true, scrollback: 5000, allowProposedApi: false, theme: termTheme() });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    t = { term, fit, host, id: null, offset: 0, closed: false, reading: false, error: '', writes: Promise.resolve(), cwd: '' };
    cardTerms.set(cardId, t);
    // Shift+Esc leaves the terminal for the card's keys; every other key, Esc included, goes to the shell.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.key === 'Escape' && e.shiftKey) { e.preventDefault(); term.blur(); p.el.focus({ preventScroll: true }); return false; }
      return true;
    });
    term.onData((data) => { if (t.id && !t.closed) t.writes = t.writes.then(() => termCall('canban_terminal_write', { id: t.id, data })).catch(() => {}); });
    let resizeTimer = 0;
    term.onResize(({ cols, rows }) => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (t.id && !t.closed) termCall('canban_terminal_resize', { id: t.id, cols, rows }).catch(() => {}); }, 120);
    });
    new ResizeObserver(() => { if (t.host.isConnected && t.host.clientWidth) { try { t.fit.fit(); } catch {} } }).observe(host);
  }
  const status = h('span', { class: 'term-cwd ellipsis', title: t.cwd, text: t.cwd || '起動中…' });
  const restart = h('button', { class: 'btn', type: 'button', text: '開き直す', hidden: !t.closed, onclick: () => restartTerminal(p) });
  const end = h('button', { class: 'btn', type: 'button', text: '終了', hidden: t.closed || !t.id, title: 'シェルを終了してターミナルを閉じる',
    onclick: async () => { if (t.id) await termCall('canban_terminal_close', { id: t.id }).catch(() => {}); markTerminalClosed(t, '終了しました'); } });
  t.paint = () => { status.textContent = t.error || t.cwd || '起動中…'; status.title = t.cwd; restart.hidden = !t.closed; end.hidden = t.closed || !t.id; };
  const head = h('div', { class: 'term-head' }, h('span', { html: picon('terminal', 13) }), status, h('span', { class: 'grow' }), restart, end, ...keycap(TERM_KEYS.leave));
  const box = h('div', { class: 'term-panel' }, head, t.host);
  queueMicrotask(() => {
    if (!t.host.isConnected) return;
    if (!t.term.element) t.term.open(t.host);
    t.term.options.theme = termTheme();
    try { t.fit.fit(); } catch {}
    if (!t.id && !t.closed) startTerminal(p, t); else pumpTerminal(t);
    t.term.focus();
  });
  return box;
}

async function startTerminal(p, t) {
  t.error = '';
  try {
    const r = await termCall('canban_terminal_open', { cardId: p.id, cols: t.term.cols, rows: t.term.rows });
    t.id = r.id; t.cwd = r.cwd; t.closed = false;
    // A shell that kept running while the card was closed is shown from the start of what the server still holds.
    t.offset = r.start;
    t.paint?.();
    pumpTerminal(t);
  } catch (e) {
    markTerminalClosed(t, e.message);
  }
}

function restartTerminal(p) {
  const t = cardTerms.get(p.id);
  if (!t) return;
  t.id = null; t.closed = false; t.offset = 0;
  t.term.reset();
  t.paint?.();
  startTerminal(p, t);
}

function markTerminalClosed(t, why) {
  t.closed = true;
  t.error = why || '';
  t.paint?.();
}

// Reads while the panel is on screen. Hosts that serialize tool calls (live.mode 'short') get short polls so the
// terminal never holds up the board's own calls.
async function pumpTerminal(t) {
  if (t.reading || !t.id || t.closed) return;
  t.reading = true;
  try {
    while (t.id && !t.closed && t.host.isConnected && document.visibilityState === 'visible') {
      const long = live.mode === 'long';
      const r = await termCall('canban_terminal_read', { id: t.id, since: t.offset, timeoutMs: long ? 15000 : 0 });
      if (r.data) t.term.write(r.data);
      t.offset = r.offset;
      if (r.exited) { markTerminalClosed(t, `シェルが終了しました${r.code != null ? `（${r.code}）` : ''}`); break; }
      if (!long) await sleep(r.data ? 60 : 400);
    }
  } catch (e) {
    markTerminalClosed(t, e.message);
  } finally {
    t.reading = false;
  }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') for (const t of cardTerms.values()) pumpTerminal(t); });
new MutationObserver(() => { for (const t of cardTerms.values()) t.term.options.theme = termTheme(); })
  .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

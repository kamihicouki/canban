// Optional browser smoke test: node --test tests/board-smoke.browser.mjs
// Drives the board in a headless Chrome over the DevTools protocol (no extra packages) with fictional
// source data, walks through every view and layer, and fails on any uncaught error in the page. Unit tests
// compile the script; this catches what only breaks at run time (a name left behind by a removed feature).
// CANBAN_BROWSER_EXECUTABLE selects the browser; without one, the test is skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeFixtures } from './helpers.mjs';

const chromeBin = process.env.CANBAN_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every step runs in the page; a step that throws is reported like an uncaught error.
const WALK = `
const w = (t = 400) => new Promise((r) => setTimeout(r, t));
const key = (k, o = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));
const errs = [];
const step = async (name, fn, t = 500) => { try { await fn(); } catch (e) { errs.push(name + ': ' + e.message); } await w(t); };
await step('today', () => document.querySelector('.rb-day.is-today').click());
await step('esc', () => key('Escape'));
for (const k of ['live', 'fresh', 'active', 'dormant']) await step('phase ' + k, () => document.querySelector('.rb-phase.life-' + k).click(), 150);
await step('period 7', () => [...document.querySelectorAll('.rb-period button')].find((b) => b.textContent === '7日').click(), 1200);
await step('period all', () => [...document.querySelectorAll('.rb-period button')].find((b) => b.textContent === '全期間').click(), 1200);
await step('fold', () => document.querySelector('.fold-head')?.click());
await step('lanes', () => [...document.querySelectorAll('.side-sec-lanes button')].find((b) => b.textContent === 'AI Apps').click(), 1000);
await step('lanes off', () => [...document.querySelectorAll('.side-sec-lanes button')].find((b) => b.textContent === 'なし').click(), 1000);
await step('theme', () => document.querySelector('[data-look]').click());
await step('esc', () => key('Escape'));
await step('palette', () => key('k', { metaKey: true }));
await step('esc', () => key('Escape'));
await step('time axis', () => key('i'), 1000);
await step('row', () => document.querySelector('.irow')?.click(), 1500);
await step('board', () => key('i'), 800);
await step('session', () => document.querySelector('.card.face:not(.task)').click(), 3000);
await step('details', () => key('d'));
await step('changes', () => key('f'), 1200);
await step('esc', () => key('Escape'), 600);
await step('analytics', () => key('a'), 2000);
await step('analytics off', () => key('a'));
await step('usage', () => key('u'), 1500);
await step('usage off', () => key('u'));
return { errs, sessionOpened: !!document.querySelector('.th-conv') || true };
`;

test('the board, the ribbon, the time axis and the card layers run without page errors', { skip: !fs.existsSync(chromeBin) && 'no Chrome' }, async (t) => {
  const fx = makeFixtures();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-smoke-'));
  const port = 4700 + Math.floor(Math.random() * 200);
  const host = spawn(process.execPath, ['tests/dev-host.mjs', String(port)], { cwd: root, stdio: 'ignore',
    env: { ...process.env, CANBAN_DATA_DIR: dataDir, CANBAN_CODEX_HOME: fx.codexHome, CANBAN_CLAUDE_HOME: fx.claudeHome, CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir,
      CANBAN_LAUNCH_DRYRUN: '1', CANBAN_SEARCH_INDEX: '0', CANBAN_BACKGROUND: '0' } });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-smoke-chrome-'));
  const cdpPort = port + 1000;
  const chrome = spawn(chromeBin, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  t.after(() => {
    host.kill(); chrome.kill(); fx.cleanup?.();
    setTimeout(() => { for (const d of [dataDir, profile]) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }, 300);
  });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://localhost:${port}`)).ok) break; } catch {} await sleep(100); }
  let target;
  for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((x) => x.type === 'page'); } catch {} }
  assert.ok(target, 'Chrome started');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map(); const pageErrors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://localhost:${port}/direct` });
  for (let i = 0; i < 80; i++) {
    const r = await cdp('Runtime.evaluate', { expression: '!!document.querySelector(".card.face") && !!document.querySelector("#ribbon .rb-day")', returnByValue: true });
    if (r.result?.result?.value) break;
    await sleep(250);
  }
  const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${WALK} })()`, awaitPromise: true, returnByValue: true });
  ws.close();
  assert.equal(r.result?.exceptionDetails, undefined, JSON.stringify(r.result?.exceptionDetails));
  assert.deepEqual(r.result.result.value.errs, []);
  assert.deepEqual(pageErrors.filter((e) => !/ResizeObserver/.test(e)), []);
});

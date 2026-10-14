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
import { DatabaseSync } from 'node:sqlite';
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
  await step('exchanges open', async () => {
    const button = document.querySelector('[data-card-id="codex:t1"] .exchange-pill');
    const count = button.querySelector('.exchange-count');
    if (!count || count.clientWidth < count.scrollWidth) throw new Error('card exchange count clipped');
    button.click();
    await w(500);
    if (!document.querySelector('.exchange-history .exchange-event')) throw new Error('message history missing');
    if (!document.querySelector('.exchange-popover .close .keycap')) throw new Error('Esc key hint missing');
    if (!document.querySelector('.exchange-history').textContent.includes('サブエージェント')) throw new Error('agent provenance missing');
  });
  await step('exchanges counterpart view', () => {
    document.querySelector('[data-exchange-mode="peer"]').click();
    const groups = document.querySelectorAll('.exchange-group');
    if (groups.length !== 2) throw new Error('counterpart grouping lost a peer');
    if (document.querySelectorAll('.exchange-event').length !== 3) throw new Error('repeat message lost');
    groups[0].querySelector('summary').click();
  });
  await step('exchanges chronology', () => {
    document.querySelector('[data-exchange-mode="timeline"]').click();
    if (document.querySelectorAll('.exchange-event').length !== 3) throw new Error('switch lost history');
  });
  await step('exchanges esc', () => { key('Escape'); if (document.querySelector('.exchange-popover')) throw new Error('popup stayed open'); });
  await step('exchanges keyboard', async () => {
    document.querySelector('.rb-phase.life-fresh').click();
    const lens = document.querySelector('#board');
    if (!lens.classList.contains('lens-on')) throw new Error('time highlight missing before popup');
    document.querySelector('[data-card-id="codex:t1"]').focus();
    key('M', { shiftKey: true }); await w(500);
    if (!document.querySelector('.exchange-popover')) throw new Error('Shift+M did not open popup');
    if (!document.activeElement.closest('.exchange-popover')) throw new Error('keyboard focus stayed outside popup');
    key('Escape');
    if (!lens.classList.contains('lens-on')) throw new Error('Esc also cleared the time highlight');
    key('Escape');
  });
await step('lanes', () => [...document.querySelectorAll('.side-sec-lanes button')].find((b) => b.textContent === 'AI Apps').click(), 1000);
await step('lanes off', () => [...document.querySelectorAll('.side-sec-lanes button')].find((b) => b.textContent === 'なし').click(), 1000);
await step('theme', () => document.querySelector('[data-look]').click());
await step('esc', () => key('Escape'));
await step('palette', () => key('k', { metaKey: true }));
await step('esc', () => key('Escape'));
await step('time axis', () => key('i'), 1000);
await step('row', () => document.querySelector('.irow')?.click(), 1500);
await step('timeline exchanges keyboard', async () => {
  document.querySelector('.irow[data-card-id="codex:t1"]').focus();
  key('M', { shiftKey: true }); await w(500);
  if (!document.querySelector('.exchange-popover')) throw new Error('timeline Shift+M did not open popup');
  key('Escape');
  if (!document.querySelector('#paneLayer').classList.contains('docked')) throw new Error('Esc closed the docked card');
});
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

test('the board, the ribbon, the time axis and the card layers run without page errors', { timeout: 120000, skip: !fs.existsSync(chromeBin) && 'no Chrome' }, async (t) => {
  const fx = makeFixtures();
  const edgeDb = new DatabaseSync(path.join(fx.codexHome, 'state_5.sqlite'));
  edgeDb.exec("CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT); INSERT INTO thread_spawn_edges VALUES ('t1','t2')");
  edgeDb.prepare("UPDATE threads SET title='リリースの確認', name='リリースの確認', updated_at_ms=? WHERE id='t1'").run(Date.now() - 120000);
  edgeDb.exec("UPDATE threads SET title='検証', name='検証' WHERE id='t2'");
  edgeDb.close();
  for (const [source, id, minute] of [['peer-x', 'x1', 40], ['t2', 's1', 45], ['peer-x', 'x2', 48]]) {
    const envelope = `<codex_delegation><source_thread_id>${source}</source_thread_id><input>メッセージ ${id}</input></codex_delegation>`;
    const item = id === 'x2' ? { type: 'FunctionCallOutput', id, namespace: 'codex_app', name: 'send_message_to_thread', output: envelope }
      : { type: 'UserMessage', id, content: [{ type: 'text', text: envelope }] };
    fs.appendFileSync(fx.rollout, JSON.stringify({ timestamp: `2026-10-14T01:${minute}:00Z`, type: 'event_msg', payload: { type: 'item_completed', item } }) + '\n');
  }
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
  assert.equal(r.result?.exceptionDetails, undefined, JSON.stringify(r.result?.exceptionDetails));
  assert.deepEqual(r.result.result.value.errs, []);
  assert.deepEqual(pageErrors.filter((e) => !/ResizeObserver/.test(e)), []);
  if (process.env.CANBAN_SMOKE_SHOTS) {
    const dir = path.resolve(process.env.CANBAN_SMOKE_SHOTS);
    fs.mkdirSync(dir, { recursive: true });
    for (const layout of ['board', 'timeline']) for (const theme of ['light', 'dark']) for (const mode of ['timeline', 'peer']) {
      const capture = await cdp('Runtime.evaluate', { expression: `(async()=>{
        document.querySelector('.exchange-popover .close')?.click();
        if(!document.querySelector('#paneLayer').classList.contains('docked'))document.querySelector('.pane-close')?.click();
        await new Promise(r=>setTimeout(r,200));
        if(!document.querySelector('#paneLayer').hidden&&!document.querySelector('#paneLayer').classList.contains('docked'))throw new Error('sheet still overlays the board');
        if (!!document.querySelector('.inbox') !== ${layout === 'timeline'}) document.dispatchEvent(new KeyboardEvent('keydown',{key:'i',bubbles:true}));
        await new Promise(r=>setTimeout(r,400));
        if(!!document.querySelector('.inbox') !== ${layout === 'timeline'})throw new Error('wrong board view');
        document.documentElement.dataset.theme=${JSON.stringify(theme)};
        for(const b of document.querySelectorAll('.fold-head[aria-expanded="false"]')) b.click();
        const button=document.querySelector('[data-card-id="codex:t1"] .exchange-pill');
        const card=button?.closest('.card'),time=card?.querySelector('.ffoot .ftime');
        if(time&&time.getBoundingClientRect().right>card.getBoundingClientRect().right)throw new Error('card time clipped by exchange badge');
        if(!button)throw new Error('exchange button missing in ${layout}');button.click();
        for(let i=0;i<40&&!document.querySelector('.exchange-event');i++)await new Promise(r=>setTimeout(r,100));
        if(!document.querySelector('.exchange-event'))throw new Error('history not loaded');
        document.querySelector('[data-exchange-mode="${mode}"]').click();
        return true;
      })()`, awaitPromise: true, returnByValue: true });
      assert.equal(capture.result.exceptionDetails, undefined, JSON.stringify(capture.result.exceptionDetails));
      const shot = await cdp('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(dir, `${layout}-${theme}-${mode}.png`), Buffer.from(shot.result.data, 'base64'));
    }
  }
  ws.close();
});

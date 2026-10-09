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
import { makeLayoutFixtures } from './layout-fixture.mjs';

const chromeBin = process.env.CANBAN_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every step runs in the page; a step that throws is reported like an uncaught error.
const WALK = `
const key = (k, o = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));
const w = () => new Promise(r => setTimeout(r, 120));
const errs = [];
const check = (v, text) => { if (!v) throw new Error(text); };
document.querySelector('.fold-head')?.click();
const before = [...document.querySelectorAll('.card')].map(el => el.dataset.cardId).sort().join(',');
check(before.length > 0, 'fixture contains visible cards');
const calls = []; const callTool = window.openai.callTool;
window.openai.callTool = (name, args) => { calls.push(name); return callTool(name, args); };
document.querySelector('[data-look]').click();
check(document.querySelectorAll('[data-layout-choice]').length === 5, '5 layout choices must be selectable');
key('Escape');
const snapshotUi = () => Object.fromEntries(['filters','themePref','layout','boardView','sidebar','workspacePage','paneGlobal','cardWidths','cardHeights','collapsedLanes'].map(k => [k, localStorage.getItem('sk:'+k)]));
for (const id of ['trello', 'classic', 'rail', 'omni', 'hud']) {
  const initialUi = snapshotUi();
  key('k', { metaKey: true });
  const cmd = [...document.querySelectorAll('.picker-row')].find(el => el.textContent.includes('レイアウト: ' + ({trello:'Trello',classic:'定番',rail:'レール',omni:'オムニバー',hud:'ライブ HUD'})[id]));
  check(cmd, 'palette layout command: ' + id); calls.length = 0; cmd.click();
  check(!calls.includes('canban_get_board') && !calls.includes('canban_mark_all_seen') && !calls.includes('canban_mark_seen'), 'layout has no board/seen calls: ' + calls.join(','));
  calls.length = 0; await w();
  check(document.body.dataset.layout === id, 'layout applied: ' + id);
  const afterUi = snapshotUi();
  check(Object.keys(initialUi).every(k => k === 'layout' || initialUi[k] === afterUi[k]), 'only layout preference changed: ' + id);
  check([...document.querySelectorAll('.card')].map(el => el.dataset.cardId).sort().join(',') === before, 'same card IDs: ' + id);
  if (id === 'hud') check(document.querySelector('.hud-tile'), 'HUD renders the running fixture');
  const rect = document.querySelector('.stage').getBoundingClientRect();
  check(rect.width > 300 && rect.height > 300, 'board surface: ' + id);
  key('i'); await w();
  check(document.querySelector('.inbox'), 'timeline available: ' + id);
  key('i'); await w(); calls.length = 0;
}
// All 20 directed transitions preserve an open card and its reply draft.
document.querySelector('.card.face:not(.task)').click();
for (let i = 0; i < 30 && !document.querySelector('#paneLayer [data-sec="send"] textarea'); i++) await w();
const draft = document.querySelector('#paneLayer [data-sec="send"] textarea');
check(draft, 'session reply input is available');
draft.value = '合成の下書き・送信しない'; draft.dispatchEvent(new Event('input', {bubbles:true}));
const ids = ['trello','classic','rail','omni','hud'];
const pickLayout = id => { key('k',{metaKey:true}); const cmd = [...document.querySelectorAll('.picker-row')].find(el=>el.textContent.includes('レイアウト: '+({trello:'Trello',classic:'定番',rail:'レール',omni:'オムニバー',hud:'ライブ HUD'})[id])); check(cmd,'palette opens once');cmd.click(); };
for (const from of ids) for (const to of ids) if (from !== to) {
  pickLayout(from); pickLayout(to);
  check(!document.querySelector('#paneLayer').hidden,'card layer stays open');
  check(document.querySelector('#paneLayer [data-sec="send"] textarea') === draft && draft.value === '合成の下書き・送信しない','card draft survives '+from+' to '+to);
}
key('Escape'); await w(); check(document.querySelector('#paneLayer').hidden,'Esc closes only the card');
const settingsEntry = document.querySelector('.layout-dock [data-place="settings"], .layout-rail [data-place="settings"]') || document.querySelector('#sidebar [data-page="settings"]');
settingsEntry.click(); await w();
const field = document.querySelector('.mgmt-drawer input[type="number"]');
check(field,'management input exists');
const originalFieldValue = field.value;
const fieldDraft = originalFieldValue === '3' ? '4' : '3';
field.value = fieldDraft; field.dispatchEvent(new Event('input',{bubbles:true}));
for (const from of ids) for (const to of ids) if (from !== to) {
  pickLayout(from); pickLayout(to);
  check(!document.querySelector('.mgmt-drawer').hidden,'management stays open');
  check(field.isConnected && field.value === fieldDraft,'management draft survives '+from+' to '+to);
}
field.value = originalFieldValue; key('Escape'); await w();
check(document.querySelector('.mgmt-drawer').hidden,'Esc closes management');
return { errs };
`;

test('five selectable layouts retain board and timeline cards', { skip: !fs.existsSync(chromeBin) && 'no Chrome' }, async (t) => {
  const fx = makeLayoutFixtures();
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
    const r = await cdp('Runtime.evaluate', { expression: '!!document.querySelector(".list") && !!document.querySelector("#ribbon .rb-day")', returnByValue: true });
    if (r.result?.result?.value) break;
    await sleep(250);
  }
  await cdp('Runtime.evaluate', { expression: `document.querySelector('[data-look]').click()` });
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.join(root, 'docs/design/layout-restoration'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/design/layout-restoration/after-picker-light.png'), Buffer.from(shot.result.data, 'base64'));
  await cdp('Runtime.evaluate', { expression: `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))` });
  const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${WALK} })()`, awaitPromise: true, returnByValue: true });
  assert.equal(r.result?.exceptionDetails, undefined, JSON.stringify(r.result?.exceptionDetails));
  const output = path.join(root, 'docs/design/layout-restoration');
  const run = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(result.result?.exceptionDetails, undefined, JSON.stringify(result.result?.exceptionDetails));
    return result.result?.result?.value;
  };
  for (const theme of ['light', 'dark']) {
    await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true})); [...document.querySelectorAll('.picker-row')].find(b=>b.textContent.includes('色: '+${JSON.stringify(theme === 'light' ? 'ライト' : 'ダーク')})).click()`);
    for (const [layout, name] of [['trello','Trello'],['classic','定番'],['rail','レール'],['omni','オムニバー'],['hud','ライブ HUD']]) {
      await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true})); [...document.querySelectorAll('.picker-row')].find(b=>b.textContent.includes('レイアウト: '+${JSON.stringify(name)})).click()`);
      for (const view of ['board', 'timeline']) {
        if (view === 'timeline') await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'i',bubbles:true}))`);
        await sleep(180);
        const shot = await cdp('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(output, `${layout}-${view}-${theme}.png`), Buffer.from(shot.result.data, 'base64'));
        assert.equal(await run(`document.documentElement.scrollWidth <= 1280 && document.querySelector('.topbar').getBoundingClientRect().height < 65`), true, `${layout}/${view}/${theme} viewport and app bar`);
        if (layout === 'omni') assert.equal(await run(`document.querySelector('.layout-dock').getBoundingClientRect().bottom < document.querySelector('.board-shortcuts').getBoundingClientRect().top`), true, 'dock leaves keyboard hints visible');
        if (view === 'timeline') await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'i',bubbles:true}))`);
      }
      // The only reachable entry opens management once and Esc closes it.
      const selector = layout === 'omni' ? '.layout-dock [data-place="settings"]' : layout === 'rail' ? '.layout-rail [data-place="settings"]' : '#sidebar [data-page="settings"]';
      await run(`document.querySelector(${JSON.stringify(selector)}).click()`);
      assert.equal(await run(`!document.querySelector('.mgmt-drawer').hidden`), true);
      await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
      assert.equal(await run(`document.querySelector('.mgmt-drawer').hidden`), true);
    }
  }
  ws.close();
  assert.equal(r.result?.exceptionDetails, undefined, JSON.stringify(r.result?.exceptionDetails));
  assert.deepEqual(r.result.result.value.errs, []);
  assert.deepEqual(pageErrors.filter((e) => !/ResizeObserver/.test(e)), []);
});

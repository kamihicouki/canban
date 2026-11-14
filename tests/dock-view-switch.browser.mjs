// Timeline/gantt view changes retain the same pane, draft and reading state in isolated Chrome.
// Run separately or with the board smoke to verify this interaction independently.
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
const w=ms=>new Promise(r=>setTimeout(r,ms));
const selectView=async name=>{document.querySelector('#viewSwitch button[aria-label="'+name+'"]').click();await w(150);};
const selectRow=async(selector,id)=>{const row=document.querySelector(selector+'[data-card-id="'+id+'"]');if(!row)throw Error('missing row '+id);row.click();for(let i=0;i<100&&!document.querySelector('.pane[data-card-id="'+id+'"] .send-box textarea');i++)await w(30);return document.querySelector('.pane[data-card-id="'+id+'"]');};
const assertSelected=(selector,id,pane,draft)=>{const selected=document.querySelector(selector+'[aria-selected="true"]');if(selected?.dataset.cardId!==id)throw Error('selected row differs from open card');const shown=[...document.querySelectorAll('#paneLayer .pane')];if(shown.length!==1||shown[0]!==pane)throw Error('pane DOM recreated or different card displayed');if(pane.querySelector('.send-box textarea').value!==draft)throw Error('draft lost across views');if(document.querySelector('.gantt-main')?.hidden&&selector==='.gantt-row')throw Error('initial gantt dock remained hidden');};
await selectView('時間軸');const a=await selectRow('.irow','codex:t1');const inputA=a.querySelector('.send-box textarea');inputA.value='Aの下書き';inputA.dispatchEvent(new Event('input',{bubbles:true}));
await selectView('ガント');assertSelected('.gantt-row','codex:t1',a,'Aの下書き');
const b=await selectRow('.gantt-row','codex:t3');const inputB=b.querySelector('.send-box textarea');inputB.value='Bの下書き';inputB.dispatchEvent(new Event('input',{bubbles:true}));
await selectView('時間軸');assertSelected('.irow','codex:t3',b,'Bの下書き');
const aAgain=await selectRow('.irow','codex:t1');await selectView('ガント');assertSelected('.gantt-row','codex:t1',aAgain,'Aの下書き');
const beforeCycle=await selectRow('.gantt-row','codex:t3');await selectView('ボード');await selectView('時間軸');assertSelected('.irow','codex:t3',beforeCycle,'Bの下書き');
return {errs:[]};
`;
test('timeline and gantt keep the selected pane, draft and DOM across direct view changes', { timeout: 120000, skip: !fs.existsSync(chromeBin) && 'no Chrome' }, async (t) => {
  const fx = makeFixtures();
  const sourceDb = new DatabaseSync(path.join(fx.codexHome, 'state_5.sqlite'));
  sourceDb.prepare("UPDATE threads SET updated_at_ms=?,archived=0 WHERE id IN ('t1','t3')").run(Date.now());
  sourceDb.close();
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
  assert.deepEqual(pageErrors.filter(e=>!/ResizeObserver/.test(e)),[]);
});

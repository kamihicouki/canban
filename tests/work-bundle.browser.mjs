// Explicit bundling and undo through the real UI and MCP tools, using only isolated fictional data.
// Run separately from the board smoke so this mutation regression remains independently reproducible.
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
const rpc=async(name,args)=>{const r=await fetch('/rpc',{method:'POST',body:JSON.stringify({name,arguments:args})}).then(r=>r.json());if(r.error||r.result?.isError)throw Error(JSON.stringify(r));return r.result.structuredContent;};
const board=()=>rpc('canban_get_board',{days:0,includeArchived:true});
const tasks=b=>b.lists.flatMap(l=>l.cards).filter(c=>c.kind==='task');
const before=tasks(await board()).length;
for(const b of document.querySelectorAll('.fold-head[aria-expanded="false"]'))b.click();
const row=document.querySelector('.card[data-card-id="codex:t1"]');if(!row)throw Error('missing session row');row.click();
for(let i=0;i<100&&!document.querySelector('.pane .th-head [data-side-tab="details"]');i++)await w(50);
document.querySelector('.pane .th-head [data-side-tab="details"]').click();
let entry;for(let i=0;i<100;i++){entry=document.querySelector('[data-work-bundle="codex:t1"]');if(entry)break;await w(50);}
if(!entry)throw Error('missing task picker entry');
const originalPane=entry.closest('.pane');const originalComposer=originalPane.querySelector('.send-box textarea');
originalComposer.value='未送信の下書きを保持します';originalComposer.dispatchEvent(new Event('input',{bubbles:true}));originalComposer.setSelectionRange(3,7);
const originalFeed=originalPane.querySelector('.feed');originalFeed.scrollTop=400;const readingTop=originalFeed.scrollTop;
if(readingTop<=0)throw Error('long conversation fixture does not scroll');
const assertReadingAndDraft=()=>{const shown=document.querySelector('.pane[data-card-id="codex:t1"]');if(shown!==originalPane)throw Error('bundle replaced pane DOM');const composer=shown.querySelector('.send-box textarea');if(composer.value!=='未送信の下書きを保持します')throw Error('bundle lost draft');if(composer.selectionStart!==3||composer.selectionEnd!==7)throw Error('bundle lost caret');if(Math.abs(shown.querySelector('.feed').scrollTop-readingTop)>2)throw Error('bundle lost reading position');};

entry.click();for(let i=0;i<100&&![...document.querySelectorAll('.popover .picker-row')].some(b=>b.textContent.includes('新しいタスクカードにまとめる'));i++)await w(50);
const choices=[...document.querySelectorAll('.popover .picker-row')];
const create=choices.find(b=>b.textContent.includes('新しいタスクカードにまとめる'));
if(!create)throw Error('missing create choice');
if(tasks(await board()).length!==before)throw Error('opening picker wrote state');
create.click();create.click();
for(let i=0;i<100&&!document.querySelector('.toast-btn');i++)await w(50);
const bundled=tasks(await board());if(bundled.length!==before+1)throw Error('new task not single-flight');
if(!bundled.some(t=>t.linkedSessionIds.includes('codex:t1')))throw Error('membership missing');
assertReadingAndDraft();
if(!originalPane.querySelector('[data-work-bundle]').textContent.includes('いまの仕事:'))throw Error('membership label did not update after bundling');
// Hold the trailing exchange read: metadata and the rebuilt composer are already usable
// while undo is still running, so caret preservation must not depend on its final callback.
const originalCallTool=window.openai.callTool;let releaseUndoExchanges,undoExchangeHeld=false;
const undoExchangeGate=new Promise(resolve=>{releaseUndoExchanges=resolve;});
window.openai.callTool=async(name,args)=>{const result=await originalCallTool(name,args);if(name==='canban_exchanges'){undoExchangeHeld=true;await undoExchangeGate;}return result;};
document.querySelector('.toast-btn').click();
for(let i=0;i<100;i++){if(tasks(await board()).length===before)break;await w(50);}
if(tasks(await board()).length!==before)throw Error('undo retained unchanged created task');
for(let i=0;i<100&&originalPane.querySelector('[data-work-bundle]').textContent.includes('いまの仕事:');i++)await w(30);
assertReadingAndDraft();
if(originalPane.querySelector('[data-work-bundle]').textContent.includes('いまの仕事:'))throw Error('membership label did not update after undo');
for(let i=0;i<100&&!undoExchangeHeld;i++)await w(20);
if(!undoExchangeHeld)throw Error('undo exchange delay was not exercised');
assertReadingAndDraft();
releaseUndoExchanges();window.openai.callTool=originalCallTool;
for(let i=0;i<200&&document.querySelector('.toast')?.textContent.includes('取り消しています');i++)await w(30);
assertReadingAndDraft();
const seed=await rpc('canban_create_task',{title:'すでにまとめた仕事'});await rpc('canban_link_session',{taskId:seed.cardId,sessionId:'codex:t1'});
const pane=document.querySelector('.pane[data-card-id="codex:t1"]');pane.focus();pane.dispatchEvent(new KeyboardEvent('keydown',{key:'x',bubbles:true}));
for(let i=0;i<100&&![...document.querySelectorAll('.popover .picker-row')].some(b=>b.textContent.includes('新しいタスクカードにまとめる'));i++)await w(50);
const bundleInput=document.querySelector('.popover .picker-input');if(!bundleInput)throw Error('x did not open the bundle picker');
bundleInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
for(let i=0;i<100&&!document.querySelector('.toast-btn');i++)await w(50);
if(!tasks(await board()).some(t=>t.linkedSessionIds.includes('codex:t1')))throw Error('x then Enter silently unlinked the existing membership');
const keptTask=tasks(await board()).find(t=>t.linkedSessionIds.includes('codex:t1')).id;
pane.focus();pane.dispatchEvent(new KeyboardEvent('keydown',{key:'x',bubbles:true}));
for(let i=0;i<100&&![...document.querySelectorAll('.popover .picker-row')].some(b=>b.textContent.includes('この仕事から外す'));i++)await w(50);
const membershipChoices=[...document.querySelectorAll('.popover .picker-row')];
if(!membershipChoices.at(-1)?.textContent.includes('この仕事から外す'))throw Error('explicit unlink is not last');
membershipChoices.at(-1).click();
for(let i=0;i<100;i++){if(!tasks(await board()).some(t=>t.linkedSessionIds.includes('codex:t1')))break;await w(50);}
if(tasks(await board()).some(t=>t.linkedSessionIds.includes('codex:t1')))throw Error('explicit unlink failed');
for(let i=0;i<200&&!document.querySelector('.toast')?.textContent.includes('仕事の紐付けを解除しました');i++)await w(50);
const unlinkUndo=document.querySelector('.toast-btn');if(!unlinkUndo)throw Error('unlink completion has no undo');unlinkUndo.click();
for(let i=0;i<200;i++){if(tasks(await board()).find(t=>t.id===keptTask)?.linkedSessionIds.includes('codex:t1'))break;await w(50);}
if(!tasks(await board()).find(t=>t.id===keptTask)?.linkedSessionIds.includes('codex:t1'))throw Error('explicit unlink undo did not restore membership');
for(const action of ['move','unlink']) {
 const sessionPane=document.querySelector('.pane[data-card-id="codex:t1"]');
 if(!sessionPane.querySelector('[data-sec="related"] .link-btn'))sessionPane.querySelector('[data-side-tab="details"]').click();
 const beforeOverlayInput=sessionPane.querySelector('.send-box textarea');
 const parentLink=sessionPane.querySelector('[data-sec="related"] .link-btn');if(!parentLink)throw Error('current parent link was not refreshed');parentLink.click();
 for(let i=0;i<200&&document.querySelectorAll('#paneLayer .pane').length!==2;i++)await w(30);
 if(!document.querySelector('.pane[data-card-id="'+keptTask+'"]'))throw Error('task-and-child overlay not open');
 const child=document.querySelector('.pane[data-card-id="codex:t1"]');
 for(let i=0;i<200&&child.querySelector('.send-box textarea')===beforeOverlayInput;i++)await w(30);
 if(!child.querySelector('[data-work-bundle]'))child.querySelector('[data-side-tab="details"]').click();
 const composer=child.querySelector('.send-box textarea');composer.value='親子overlayの下書き '+action;composer.dispatchEvent(new Event('input',{bubbles:true}));composer.setSelectionRange(2,6);
 const childFeed=child.querySelector('.feed');childFeed.scrollTop=600;const childTop=childFeed.scrollTop;
 const membership=child.querySelector('[data-work-bundle]');membership.closest('details').open=true;membership.focus();membership.click();
 for(let i=0;i<200&&![...document.querySelectorAll('.popover .picker-row')].some(b=>b.textContent.includes('この仕事から外す'));i++)await w(30);
 const option=[...document.querySelectorAll('.popover .picker-row')].find(b=>action==='unlink'?b.textContent.includes('この仕事から外す'):b.querySelector('.picker-label')?.textContent==='すでにまとめた仕事');
 if(!option)throw Error('overlay membership choice missing');option.click();
 for(let i=0;i<200&&!document.querySelector('.toast-btn');i++)await w(40);
 const shown=document.querySelector('.pane[data-card-id="codex:t1"]');if(shown!==child||document.querySelectorAll('#paneLayer .pane').length!==1)throw Error('moving child out of parent overlay hid or replaced its conversation');
 const restoredInput=shown.querySelector('.send-box textarea');
 if(restoredInput.value!=='親子overlayの下書き '+action||restoredInput.selectionStart!==2||restoredInput.selectionEnd!==6)throw Error('parent overlay move lost draft or caret: '+JSON.stringify({action,value:restoredInput.value,start:restoredInput.selectionStart,end:restoredInput.selectionEnd}));
 if(Math.abs(shown.querySelector('.feed').scrollTop-childTop)>2)throw Error('parent overlay move lost scroll');
 if(document.activeElement?.getAttribute('aria-label')!=='仕事にまとめる')throw Error('parent overlay move lost control focus: '+JSON.stringify({action,tag:document.activeElement?.tagName,label:document.activeElement?.getAttribute('aria-label'),cls:document.activeElement?.className}));
 const undo=document.querySelector('.toast-btn');if(!undo)throw Error('overlay action not completed');undo.click();
 for(let i=0;i<200;i++){if(tasks(await board()).find(t=>t.id===keptTask)?.linkedSessionIds.includes('codex:t1'))break;await w(40);}
 if(!tasks(await board()).find(t=>t.id===keptTask)?.linkedSessionIds.includes('codex:t1'))throw Error('overlay undo did not restore owner');
 for(let i=0;i<200&&document.querySelector('.toast')?.textContent.includes('取り消しています');i++)await w(30);
}



return {errs:[]};
`;
test('work bundle picker creates once and undo restores the original state', { timeout: 120000, skip: !fs.existsSync(chromeBin) && 'no Chrome' }, async (t) => {
  const fx = makeFixtures();
  for(let i=0;i<220;i++)fs.appendFileSync(fx.rollout,JSON.stringify({timestamp:new Date().toISOString(),type:'event_msg',payload:{type:'item_completed',item:{type:i%2?'AgentMessage':'UserMessage',phase:'final',content:[{type:'Text',text:'架空の会話 '+i+'。長い会話の読む位置を確認します。'.repeat(12)}]}}})+'\n');
  const sourceDb = new DatabaseSync(path.join(fx.codexHome, 'state_5.sqlite'));
  sourceDb.prepare("UPDATE threads SET updated_at_ms=? WHERE id='t1'").run(Date.now());
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

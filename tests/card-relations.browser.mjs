// Manual references, prerequisites and derivations through the real UI and MCP, using isolated fictional data.
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
const wait=async fn=>{for(let i=0;i<150;i++){const v=fn();if(v)return v;await w(40);}throw Error('UI condition timed out: '+(document.querySelector('.cr-status')?.textContent||'no relation section')+' / '+(document.querySelector('.toast')?.textContent||''));};
const rpc=async(name,args)=>{const r=await fetch('/rpc',{method:'POST',body:JSON.stringify({name,arguments:args})}).then(r=>r.json());if(r.error||r.result?.isError)throw Error(JSON.stringify(r));return r.result.structuredContent;};
const b=await rpc('canban_create_task',{title:'関連検証B'}),c=await rpc('canban_create_task',{title:'関連検証C'});
const originalCall=window.openai.callTool;let returningToSource=false;
window.openai.callTool=async(name,args)=>{if(returningToSource&&args?.cardId==='codex:t1'){if(name==='canban_get_session')await w(100);if(name==='canban_get_card_relations')await w(600);}return originalCall(name,args);};
for(const row of document.querySelectorAll('.fold-head[aria-expanded="false"]'))row.click();
document.querySelector('.card[data-card-id="codex:t1"]').click();
const source=await wait(()=>document.querySelector('.pane[data-card-id="codex:t1"] .send-box textarea')?.closest('.pane'));
const openRelations=async()=>{const pane=document.querySelector('#paneLayer .pane');pane.focus();pane.dispatchEvent(new KeyboardEvent('keydown',{key:'R',code:'KeyR',altKey:true,shiftKey:true,bubbles:true}));return wait(()=>pane.querySelector('details[data-sec="cardRelations"][open] [data-card-relations]'));};
await openRelations();await wait(()=>source.querySelector('.cr-status').textContent.includes('手動の関連 0件'));
const draft=source.querySelector('.send-box textarea');draft.value='関連を辿っても残す下書き';draft.dispatchEvent(new Event('input',{bubbles:true}));draft.setSelectionRange(2,5);
const feed=source.querySelector('.feed');feed.scrollTop=400;const top=feed.scrollTop;if(top<=0)throw Error('long fixture does not scroll');
const pick=async(label)=>{const row=await wait(()=>[...document.querySelectorAll('.popover .picker-row')].find(row=>row.querySelector('.picker-label')?.textContent===label));row.click();};
const link=async(kindLabel,targetTitle)=>{
 document.querySelector('#paneLayer .pane .cr-add').click();await pick(kindLabel);
 const input=await wait(()=>document.querySelector('.popover .picker-input'));input.value=targetTitle;input.dispatchEvent(new Event('input',{bubbles:true}));await pick(targetTitle);await w(200);
};
await link('参考として関連付ける','関連検証B');await wait(()=>source.querySelector('.cr-row[data-relation-kind="ref"]'));
await link('このカードが先に必要','関連検証B');await wait(()=>source.querySelector('.cr-row[data-relation-kind="blocks"]'));
if((await rpc('canban_get_card_relations',{cardId:'codex:t1'})).relations.length!==2)throw Error('manual edges not stored separately');
source.querySelector('.cr-row[data-relation-kind="ref"] .cr-title').click();
const targetB=await wait(()=>document.querySelector('.pane[data-card-id="'+b.cardId+'"] [data-card-relations]'));
await wait(()=>targetB.querySelector('.cr-row[data-relation-kind="ref"]'));
if(targetB.querySelector('.cr-back').hidden)throw Error('single return entry missing');
await wait(()=>document.activeElement===targetB.querySelector('.cr-back'));
await link('このカードから派生したカード','関連検証C');await wait(()=>targetB.querySelector('.cr-row[data-relation-kind="derived"]'));
targetB.querySelector('.cr-row[data-relation-kind="derived"] .cr-title').click();
const targetC=await wait(()=>document.querySelector('.pane[data-card-id="'+c.cardId+'"] [data-card-relations]'));
await wait(()=>targetC.querySelector('.cr-row[data-relation-kind="derived"]'));
await link('このカードから派生したカード','関連検証B');
await wait(()=>document.querySelector('.toast.error')?.textContent.includes('循環'));
if((await rpc('canban_get_card_relations',{cardId:c.cardId})).relations.length!==1)throw Error('cycle refusal changed edges');
targetC.querySelector('.cr-back').click();await wait(()=>document.querySelector('.pane[data-card-id="'+b.cardId+'"] .cr-back:not([hidden])'));
returningToSource=true;
document.querySelector('.pane[data-card-id="'+b.cardId+'"] .cr-back').click();
await wait(()=>document.querySelector('.pane[data-card-id="codex:t1"] .cr-row[data-relation-kind="ref"]'));
// Cached rows appear before the return navigation has refreshed them. Wait for its public focus return.
await wait(()=>document.activeElement===document.querySelector('.pane[data-card-id="codex:t1"] .cr-row[data-relation-kind="ref"] .cr-title'));
const restored=document.querySelector('.pane[data-card-id="codex:t1"]');
if(restored!==source)throw Error('navigation replaced the source pane DOM');
if(restored.querySelector('.send-box textarea').value!=='関連を辿っても残す下書き')throw Error('navigation lost draft');
if(restored.querySelector('.send-box textarea').selectionStart!==2)throw Error('navigation lost caret');
if(Math.abs(restored.querySelector('.feed').scrollTop-top)>2)throw Error('navigation lost reading position');
restored.querySelector('.cr-row[data-relation-kind="ref"] .cr-remove').click();
await wait(()=>restored.querySelector('.cr-status')?.textContent.includes('手動の関連 1件')&&!restored.querySelector('.cr-row[data-relation-kind="ref"]')&&restored.querySelector('.cr-row[data-relation-kind="blocks"] .cr-title:not(:disabled)'));
const afterRemoval=await rpc('canban_get_card_relations',{cardId:'codex:t1'});
if(afterRemoval.relations.some(r=>r.kind==='ref'))throw Error('ref removal was not persisted');
if(!afterRemoval.relations.some(r=>r.kind==='blocks'))throw Error('removing ref also removed prerequisite');
const relationTrace=[{phase:'reference removed',savedKinds:afterRemoval.relations.map(r=>r.kind),shownKinds:[...restored.querySelectorAll('.cr-row')].map(r=>r.dataset.relationKind)}];
await rpc('canban_delete_task',{cardId:c.cardId});
const prerequisite=await wait(()=>restored.querySelector('.cr-row[data-relation-kind="blocks"] .cr-title:not(:disabled)'));
relationTrace.push({phase:'unrelated task deleted',shownKinds:[...restored.querySelectorAll('.cr-row')].map(r=>r.dataset.relationKind),prerequisiteReachable:prerequisite.isConnected&&!prerequisite.disabled});prerequisite.click();
const missingPanel=await wait(()=>document.querySelector('.pane[data-card-id="'+b.cardId+'"] .cr-row[data-relation-kind="derived"]'));
await wait(()=>missingPanel.querySelector('.cr-title')?.disabled);
if(!missingPanel.textContent.includes('未取得'))throw Error('missing target was not identified');
missingPanel.querySelector('.cr-remove').click();
await wait(()=>!document.querySelector('.pane[data-card-id="'+b.cardId+'"] .cr-row[data-relation-kind="derived"]'));
window.openai.callTool=originalCall;
return {errs:[],relationTrace};
`;
test('manual card references, prerequisites and derivations preserve drafts and reject cycles', { timeout: 120000, skip: !fs.existsSync(chromeBin) && 'no Chrome' }, async (t) => {
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
  console.log('manual relation state trace:',JSON.stringify(r.result.result.value.relationTrace));
  assert.deepEqual(pageErrors.filter(e=>!/ResizeObserver/.test(e)),[]);
});

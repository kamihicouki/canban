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
import { Store } from '../server/store.mjs';

const chromeBin = process.env.CANBAN_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const root = process.env.CANBAN_AREA_SOURCE || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every step runs in the page; a step that throws is reported like an uncaught error.
const WALK = `
const w=ms=>new Promise(r=>setTimeout(r,ms));
document.documentElement.dataset.theme='__THEME__';
const label={board:'ボード',timeline:'時間軸',gantt:'ガント'}['__VIEW__'];
document.querySelector('#viewSwitch [aria-label="'+label+'"]').click(); await w(250);
for(const fold of document.querySelectorAll('.fold-head[aria-expanded="false"]'))fold.click();
const row=document.querySelector('#board [data-card-id="__CARD__"]');
if(!row)throw Error('fixture card missing for area measurement');
const started=performance.now();row.click();
for(let i=0;i<100&&(!document.querySelector('.pane[data-card-id="__CARD__"] .feed .fi-user')||!document.querySelector('.pane[data-card-id="__CARD__"] textarea'));i++)await w(25);
const readyMs=Math.round(performance.now()-started);
await w(150);
const pane=document.querySelector('.pane[data-card-id="__CARD__"]');
const rect=e=>{const r=e?.getBoundingClientRect();return r?{x:r.x,y:r.y,width:r.width,height:r.height}:null};
const paneRect=rect(pane),main=rect(pane.querySelector('.th-main')),conversation=rect(pane.querySelector('.th-conv')),input=rect(pane.querySelector('.send-box textarea'));
if((!input?.height||!conversation?.height)&&!document.querySelector('#auxiliaryBtn')&&'__VIEW__'==='gantt')return {cardId:'__CARD__',view:'gantt',theme:'__THEME__',available:false,limitation:'Baseline selected gantt card has a zero-size dock; no usable conversation area was measurable',pane:paneRect,dock:rect(document.querySelector('#board .inbox-main'))};
if(!input?.height||!conversation?.height)throw Error(JSON.stringify({reason:'conversation or input unavailable',view:'__VIEW__',pane:paneRect,main,conversation,input,dock:rect(document.querySelector('#board .inbox-main')),viewRect:rect(document.querySelector('.gantt-view')),layer:rect(document.querySelector('#paneLayer')),board:rect(document.querySelector('#board'))}));
return {cardId:'__CARD__',view:'__VIEW__',theme:'__THEME__',viewport:[1280,800],cardUsableMs:readyMs,pane:paneRect,main,conversation,input,ribbonHeight:rect(document.querySelector('#ribbon')).height,paneBarHeight:rect(document.querySelector('.pane-bar')).height,keyGuideMin:document.querySelector('.key-guide').dataset.min,source:document.querySelector('#auxiliaryBtn')?'completion':'baseline'};
`;
test('conversation area and input remain usable across board, timeline and gantt', { timeout: 120000, skip: !fs.existsSync(chromeBin) && 'no Chrome' }, async (t) => {
  const fx = makeFixtures();
  const sourceDb = new DatabaseSync(path.join(fx.codexHome, 'state_5.sqlite'));
  sourceDb.prepare("UPDATE threads SET updated_at_ms=? WHERE id='t1'").run(Date.now());
  sourceDb.close();
  const questionFile=path.join(fx.claudeHome,'projects','-r-web','c2.jsonl');
  const timestamp=new Date().toISOString();
  for(let i=0;i<220;i++)fs.appendFileSync(questionFile,JSON.stringify({type:i%2?'assistant':'user',timestamp,message:{content:[{type:'text',text:`架空の検証メッセージ ${i}。決済フォームの入力検証を確認します。`}]}})+'\n');
  fs.appendFileSync(questionFile,JSON.stringify({type:'assistant',timestamp,message:{content:[{type:'tool_use',id:'evaluation-question',name:'AskUserQuestion',input:{questions:[{question:'検証方法を選んでください',options:[{label:'実機'},{label:'架空データ'}]}]}}]}})+'\n');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-smoke-'));
  if(process.env.CANBAN_AREA_PARENT==='1'){const store=new Store(dataDir);const task=await store.createTask({title:'決済フォームの検証'});await store.linkSession({taskId:task.cardId,sessionId:'claude:c2'});await store.close();}
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
    const r = await cdp('Runtime.evaluate', { expression: '!!document.querySelector(".card.face, .irow, .gantt-row") && !!document.querySelector("#ribbon .rb-day")', returnByValue: true });
    if (r.result?.result?.value) break;
    await sleep(250);
  }
  const output=path.resolve(process.env.CANBAN_AREA_OUTPUT || '.local/unified-completion/area-after');
  fs.mkdirSync(output,{recursive:true});
  const measurements=[];
  for(const cardId of (process.env.CANBAN_AREA_PARENT==='1'?['claude:c2']:['codex:t1','claude:c2']))for(const view of (process.env.CANBAN_AREA_PARENT==='1'?['timeline']:['board','timeline','gantt']))for(const theme of ['light','dark']){
    await cdp('Page.navigate',{url:'http://localhost:'+port+'/direct'});
    for(let i=0;i<100;i++){const r=await cdp('Runtime.evaluate',{expression:'!!document.querySelector(".card.face, .irow, .gantt-row")',returnByValue:true});if(r.result?.result?.value)break;await sleep(100);}
    const expression='(async()=>{'+WALK.replaceAll('__CARD__',cardId).replaceAll('__VIEW__',view).replaceAll('__THEME__',theme)+'})()';
    const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    assert.equal(r.result?.exceptionDetails,undefined,JSON.stringify(r.result?.exceptionDetails));
    const measurement=r.result.result.value;
    if(process.env.CANBAN_AREA_PARENT==='1'){const head=await cdp('Runtime.evaluate',{expression:'document.querySelector(".th-head").getBoundingClientRect().height',returnByValue:true});measurement.threadHeaderHeight=head.result.result.value;assert.ok(measurement.threadHeaderHeight<=44,'parent breadcrumb must remain one row: '+measurement.threadHeaderHeight);}
    measurements.push(measurement);
    const shot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    fs.writeFileSync(path.join(output,cardId.replace(':','-')+'-'+view+'-'+theme+'.png'),Buffer.from(shot.result.data,'base64'));
  }
  fs.writeFileSync(path.join(output,'measurements.json'),JSON.stringify({conditions:'isolated makeFixtures; t1 updated now and c2 with 220 messages plus unanswered AskUserQuestion; 1280x800; no real sends; per-view fresh navigation; single timing sample until feed content and composer exist, excluding 150ms screenshot settling; not a performance claim',measurements},null,2)+String.fromCharCode(10));
  assert.deepEqual(pageErrors.filter(e=>!/ResizeObserver/.test(e)),[]);
});

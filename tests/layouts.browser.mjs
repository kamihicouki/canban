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
const ensureAuxiliary = mode => { for(let i=0;i<2&&document.body.dataset.auxiliaryMode!==mode;i++) key('U',{code:'KeyU',altKey:true,shiftKey:true}); check(document.body.dataset.auxiliaryMode===mode,'auxiliary mode '+mode); };
const noRects = selector => [...document.querySelectorAll(selector)].every(el=>el.getClientRects().length===0);
const snapshotUi = () => Object.fromEntries(['auxiliaryPrefs','auxiliaryMode','filters','themePref','layout','boardView','sidebar','workspacePage','paneGlobal','cardWidths','cardHeights','collapsedLanes','keyGuide'].map(k => [k, localStorage.getItem('sk:'+k)]));
for (const id of ['trello', 'classic', 'rail', 'omni', 'hud']) {
  const initialUi = snapshotUi();
  key('k', { metaKey: true });
  for (let i = 0; i < 30 && !document.querySelector('.popover.palette .picker-row'); i++) await w();
  const cmd = [...document.querySelectorAll('.picker-row')].find(el => el.textContent.includes('レイアウト: ' + ({trello:'Trello',classic:'定番',rail:'レール',omni:'オムニバー',hud:'ライブ HUD'})[id]));
  check(cmd, 'palette layout command: ' + id); calls.length = 0; cmd.click();
  check(!calls.includes('canban_get_board') && !calls.includes('canban_mark_all_seen') && !calls.includes('canban_mark_seen'), 'layout has no board/seen calls: ' + calls.join(','));
  calls.length = 0; await w();
  check(document.body.dataset.layout === id, 'layout applied: ' + id);
  const afterUi = snapshotUi();
  check(Object.keys(initialUi).every(k => k === 'layout' || initialUi[k] === afterUi[k]), 'only layout preference changed: ' + id);
  check([...document.querySelectorAll('.card')].map(el => el.dataset.cardId).sort().join(',') === before, 'same card IDs: ' + id);
  if (id === 'hud') check(document.querySelector('.hud-tile'), 'HUD renders the running fixture');
  ensureAuxiliary('minimal'); await w();
  check(noRects('#ribbon, .live-hud'),'minimal removes ribbon and HUD from layout: '+id);
  const session=document.querySelector('.card.face:not(.task)'); check(session,'session available: '+id);session.click();
  for(let i=0;i<50&&!document.querySelector('.pane .th-conv');i++)await w();
  check(noRects('.pane-bar'),'minimal removes open-card display bar: '+id);
  const ribbonNode=document.querySelector('#ribbon'), ribbonHome=ribbonNode.parentNode;
  const periodChip=document.querySelector('[data-auxiliary-open="ribbon"]'),cardChip=document.querySelector('[data-auxiliary-open="card"]');
  check(periodChip.getClientRects().length>0&&/期間 (?:[0-9]+日|全期間)/.test(periodChip.textContent),'minimal keeps a readable period fragment: '+id);
  check(cardChip.getClientRects().length>0&&cardChip.textContent.trim(),'minimal keeps the card display name: '+id);
  if(id==='hud')check(document.querySelector('[data-auxiliary-open="hud"]').textContent.includes('入力待ち'),'minimal keeps waiting count');
  periodChip.click();await w();
  check(document.querySelector('.auxiliary-panel #ribbon')===ribbonNode,'period fragment moves the existing ribbon DOM: '+id);
  ribbonNode.querySelector('.rb-day[data-day="0"]').focus();ribbonNode.querySelector('.rb-day[data-day="0"]').click();await w();
  check(periodChip.textContent.includes('照らし中'),'minimal shows the pinned lens state');
  ribbonNode.querySelector('.rb-clear').focus();ribbonNode.querySelector('.rb-clear').click();await w();
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'p',bubbles:true}));await w();
  let prefs=JSON.parse(localStorage.getItem('sk:auxiliaryPrefs'));
  check(prefs.ribbon==='pinned'&&prefs.card==='minimal'&&document.body.dataset.auxiliaryMode==='mixed','individual pin does not change other parts');
  check(ribbonNode.parentNode===ribbonHome&&ribbonNode.getClientRects().length>0&&!document.querySelector('.popover'),'pin restores same ribbon to its original place');
  check(!document.querySelector('#board').classList.contains('lens-on'),'pinning the ribbon does not start a focus preview');
  cardChip.click();await w();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'p',bubbles:true}));await w();
  prefs=JSON.parse(localStorage.getItem('sk:auxiliaryPrefs'));check(prefs.ribbon==='pinned'&&prefs.card==='pinned','later individual choice preserves earlier choice');
  document.querySelector('.pane-bar [data-auxiliary-minimize="card"]').click();await w();
  prefs=JSON.parse(localStorage.getItem('sk:auxiliaryPrefs'));check(prefs.ribbon==='pinned'&&prefs.card==='minimal','individual minimization preserves other pins');
  const guide=document.querySelector('.key-guide'), guideBefore=guide.dataset.min;document.querySelector('.kg-fold').click();
  const guideChosen=guide.dataset.min;
  ensureAuxiliary('pinned');await w();
  check(document.querySelector('#ribbon').getClientRects().length>0,'pinned restores ribbon: '+id);
  check(document.querySelector('.pane-bar').getClientRects().length>0,'pinned restores card display bar: '+id);
  if(id==='hud')check(document.querySelector('.live-hud').getClientRects().length>0,'pinned restores HUD');
  ensureAuxiliary('minimal');await w();
  check(guide.dataset.min===guideChosen,'bulk does not overwrite independent key-guide choice');
  if(guide.dataset.min!==guideBefore)document.querySelector('.kg-fold').click();
  check(noRects('#ribbon, .live-hud, .pane-bar'),'minimal removes secondary regions again: '+id);
  key('Escape');await w();check(document.querySelector('#paneLayer').hidden,'card closes after toggling: '+id);
  if(id==='rail'){
    const rail=document.querySelector('.layout-rail'),side=document.querySelector('#sidebar');
    const r=rail.getBoundingClientRect(),a=side.getBoundingClientRect();
    check(rail.closest('#sidebar')===side&&!document.querySelector('.app-content > .layout-rail'),'rail has no separate sidebar');
    check(r.left>=a.left&&r.right<=a.right,'rail stays inside the existing sidebar width');
  }
  key('p'); await w();
  check([...document.querySelectorAll('.picker-row')].some(el => el.textContent.includes('Codexのプロジェクト: UI検証')), 'source picker uses observed source facets: ' + id);
  key('Escape'); await w();
  const rect = document.querySelector('.stage').getBoundingClientRect();
  check(rect.width > 300 && rect.height > 300, 'board surface: ' + id);
  key('i'); await w();
  check(document.querySelector('.inbox'), 'timeline available: ' + id);
  key('i'); await w();check(document.querySelector('.gantt-view'),'gantt available: '+id);
  key('i');await w();check(!document.querySelector('.inbox,.gantt-view'),'i returns to board: '+id); calls.length = 0;
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
// Real DOM picker / saved-view buttons -> real RPC. No access to the app's private scope.
const fixtureTool=async(name,args)=>{const response=await window.openai.callTool(name,args);check(!response.isError,name);const data=response.structuredContent;return data.result||data;};
const originalFilters=JSON.parse(localStorage.getItem('sk:filters')||'{}');
const restoreView=await fixtureTool('canban_save_view',{name:'回帰前の表示',filters:originalFilters});
const created=await fixtureTool('canban_create_task',{title:'作業場所の統合回帰',context:{folder:'web'}});
const aliasTaskId=created.cardId;
await fixtureTool('canban_link_session',{taskId:aliasTaskId,sessionId:'claude:c2'});
const savedView=await fixtureTool('canban_save_view',{name:'タスク種別の統合回帰',filters:{cardKind:'task',days:0,dotScope:'all'}});
key('r');
for(let i=0;i<50&&![...document.querySelectorAll('#sidebar .side-row')].some(el=>el.textContent.includes(savedView.name));i++)await w();
key('p'); await w();
const folderChoice=[...document.querySelectorAll('.picker-row')].find(el=>el.textContent.includes('/r/web'));
check(folderChoice,'working-folder candidate is reachable by p');folderChoice.click();
for(let i=0;i<50&&!document.querySelector('[data-card-id="'+aliasTaskId+'"]');i++)await w();
check(document.querySelector('[data-card-id="'+aliasTaskId+'"]'),'working-folder picker retains its advertised alias task');
check(JSON.parse(localStorage.getItem('sk:filters')).workingFolder==='/r/web','new picker sends workingFolder');
check(!JSON.parse(localStorage.getItem('sk:filters')).folder,'new picker does not use the old folder predicate');
[...document.querySelectorAll('#sidebar .side-row')].find(el=>el.textContent.includes(savedView.name)).click();
for(let i=0;i<50&&!document.querySelector('.filter-chip[title="タスクカードのみ を外す"]');i++)await w();
check(document.querySelectorAll('.card.face.task').length>0&&!document.querySelector('.card.face:not(.task)'),'saved task-only view survives load');
const kindChip=[...document.querySelectorAll('#filterChips button')].find(el=>el.textContent.includes('タスクカードのみ'));
check(kindChip,'saved card kind is visible as a removable chip');kindChip.click();
for(let i=0;i<50&&!document.querySelector('.card.face:not(.task)');i++)await w();
check(document.querySelector('.card.face:not(.task)'),'chip removal restores session cards');
[...document.querySelectorAll('#sidebar .side-row')].find(el=>el.textContent.includes(restoreView.name)).click();await w();
await fixtureTool('canban_delete_task',{cardId:aliasTaskId});
await fixtureTool('canban_delete_view',{viewId:savedView.id});
await fixtureTool('canban_delete_view',{viewId:restoreView.id});key('r');await w();
return { errs };
`;

test('five selectable layouts retain board and timeline cards', { skip: !fs.existsSync(chromeBin) && 'no Chrome' }, async (t) => {
  const fx = makeLayoutFixtures();
  fs.writeFileSync(path.join(fx.codexHome, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { native: { name: 'UI検証', rootPaths: ['/r/web'] } }, 'thread-project-assignments': { t1: { projectId: 'native' } } }));
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
  fs.mkdirSync(path.resolve(process.env.CANBAN_LAYOUT_SHOTS || path.join(root, 'docs/design/layout-restoration')), { recursive: true });
  fs.writeFileSync(path.join(path.resolve(process.env.CANBAN_LAYOUT_SHOTS || path.join(root, 'docs/design/layout-restoration')), 'after-picker-light.png'), Buffer.from(shot.result.data, 'base64'));
  await cdp('Runtime.evaluate', { expression: `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))` });
  const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${WALK} })()`, awaitPromise: true, returnByValue: true });
  assert.equal(r.result?.exceptionDetails, undefined, JSON.stringify(r.result?.exceptionDetails));
  const output = path.resolve(process.env.CANBAN_LAYOUT_SHOTS || path.join(root, 'docs/design/layout-restoration'));
  const run = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(result.result?.exceptionDetails, undefined, JSON.stringify(result.result?.exceptionDetails));
    return result.result?.result?.value;
  };
  // Individual pins are shared state, not transient panel visibility. Reload only after the
  // fictional server has read back the same preference map, so startup cannot race its save.
  const individual = await run(`(async()=>{
    const w=ms=>new Promise(r=>setTimeout(r,ms));
    for(let i=0;i<2&&document.body.dataset.auxiliaryMode!=='minimal';i++)document.querySelector('#auxiliaryBtn').click();
    document.querySelector('[data-auxiliary-open="ribbon"]').click();await w(80);
    document.querySelector('.auxiliary-pin').click();await w(80);
    const expected=JSON.parse(localStorage.getItem('sk:auxiliaryPrefs'));
    if(expected.ribbon!=='pinned'||expected.hud!=='minimal'||expected.card!=='minimal'||expected.dock!=='minimal')throw Error('individual preference map not isolated');
    for(let i=0;i<40;i++){
      const packet=await fetch('/rpc',{method:'POST',body:JSON.stringify({name:'canban_get_ui_state',arguments:{}})}).then(r=>r.json());
      const data=packet.result?.structuredContent,record=data?.result||data;
      if(JSON.stringify(record?.state?.auxiliaryPrefs)===JSON.stringify(expected))return expected;
      await w(100);
    }
    throw Error('individual auxiliary preference was not saved to shared state');
  })()`);
  await run(`window.__layoutReloadMarker=true`);
  await cdp('Page.reload',{ignoreCache:true});
  for(let i=0;i<80;i++){
    const ready=await cdp('Runtime.evaluate',{expression:`!window.__layoutReloadMarker&&!!document.querySelector('#board .card')&&!!document.querySelector('#auxiliaryFragments')`,returnByValue:true});
    if(ready.result?.result?.value)break;
    await sleep(150);
  }
  assert.equal(await run(`JSON.stringify(JSON.parse(localStorage.getItem('sk:auxiliaryPrefs')))===${JSON.stringify(JSON.stringify(individual))}&&document.body.dataset.auxiliaryMode==='mixed'&&document.querySelector('#ribbon').getClientRects().length>0`),true,'individual pin restores after reload and shared adoption');
  await run(`for(let i=0;i<2&&document.body.dataset.auxiliaryMode!=='minimal';i++)document.querySelector('#auxiliaryBtn').click()`);
  const chooseCommand = label => run(`(async()=>{
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true}));
    for(let i=0;i<100;i++){
      const choice=[...document.querySelectorAll('.picker-row')].find(button=>button.textContent.includes(${JSON.stringify(label)}));
      if(choice){choice.click();return true;}await new Promise(resolve=>setTimeout(resolve,50));
    }throw Error('command unavailable: '+${JSON.stringify(label)});
  })()`);
  const press=async(key,code,vk)=>{await cdp('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:vk,...(key==='Enter'?{text:'\r',unmodifiedText:'\r'}:{})});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk});};
  for (const theme of ['light', 'dark']) {
    await chooseCommand('色: '+(theme==='light'?'ライト':'ダーク'));
    for (const [layout, name] of [['trello','Trello'],['classic','定番'],['rail','レール'],['omni','オムニバー'],['hud','ライブ HUD']]) {
      await chooseCommand('レイアウト: '+name);
      if(layout==='trello')for(const lensView of ['ボード','時間軸']){
        await run(`document.querySelector('#viewSwitch button[aria-label="'+${JSON.stringify(lensView)}+'"]').click()`);
        for(let attempt=0;attempt<3;attempt++){
          await run(`(()=>{const trigger=document.querySelector('[data-auxiliary-open="ribbon"]');trigger.focus();trigger.click();window.__lensPhase=document.querySelector('#ribbon .rb-phase.life-live');window.__lensPhase.focus()})()`);
          assert.equal(await run(`window.__lensPhase.isConnected&&document.activeElement===window.__lensPhase`),true,'focus preview preserves the same phase button before its click');
          const point=await run(`(()=>{const r=window.__lensPhase.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
          await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
          await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
          assert.equal(await run(`document.querySelector('#board').classList.contains('lens-on')&&document.querySelector('[data-auxiliary-open="ribbon"]').textContent.includes('照らし中 動いている')`),true,'phase click and minimal summary agree: '+JSON.stringify(await run(`({lens:document.querySelector('#board').className,summary:document.querySelector('[data-auxiliary-open="ribbon"]').textContent,phase:document.querySelector('#ribbon .rb-phase.life-live').getAttribute('aria-pressed'),focus:document.activeElement?.outerHTML?.slice(0,180),popup:!!document.querySelector('.popover')})`)));
          await press('Escape','Escape',27);
          assert.equal(await run(`!document.querySelector('.popover')&&document.querySelector('#board').classList.contains('lens-on')&&document.querySelector('[data-auxiliary-open="ribbon"]').textContent.includes('照らし中 動いている')`),true,'first Escape closes only the popup and retains the pinned lens');
          await press('Escape','Escape',27);
          assert.equal(await run(`!document.querySelector('#board').classList.contains('lens-on')&&!document.querySelector('[data-auxiliary-open="ribbon"]').textContent.includes('照らし中')`),true,'next Escape clears the lens and its summary together');
        }
        await run(`(()=>{const trigger=document.querySelector('[data-auxiliary-open="ribbon"]');trigger.focus();trigger.click();document.querySelector('#ribbon .rb-phase.life-live').focus()})()`);
        assert.equal(await run(`document.querySelector('#board').classList.contains('lens-on')&&document.querySelector('[data-auxiliary-open="ribbon"]').textContent.includes('照らし中')`),true,'focus-only preview has a matching minimal summary');
        await press('Escape','Escape',27);
        assert.equal(await run(`!document.querySelector('.popover')&&!document.querySelector('#board').classList.contains('lens-on')&&!document.querySelector('[data-auxiliary-open="ribbon"]').textContent.includes('照らし中')`),true,'closing an unpinned preview clears it instead of stranding a lens with no Escape action');
        await run(`document.querySelector('#viewSwitch button[aria-label="ボード"]').click()`);
      }
      if(layout==='omni'){
        assert.equal(await run(`document.querySelectorAll('.dock-open').length===1&&document.querySelector('.dock-open').parentElement.id==='auxiliaryFragments'&&document.querySelector('.layout-dock').hidden`),true,'minimal places is one app-bar entry with no empty floating dock');
        await run(`window.__dockTrigger=document.querySelector('.dock-open');document.querySelector('#auxiliaryBtn').click()`);
        assert.equal(await run(`document.querySelector('.dock-open')===window.__dockTrigger&&window.__dockTrigger.closest('.layout-dock')&&!document.querySelector('.layout-dock').hidden`),true,'pin restores the same trigger to its dock');
        await run(`document.querySelector('#auxiliaryBtn').click()`);
        await run(`if(document.body.dataset.auxiliaryMode!=='minimal')document.querySelector('#auxiliaryBtn').click();document.querySelector('.dock-open').focus()`);
        await press('Enter','Enter',13);await sleep(120);
        assert.equal(await run(`!!document.querySelector('.popover .dock-items')&&!!document.activeElement.closest('.popover')`),true,'Enter opens minimal places and moves focus: '+JSON.stringify(await run(`({active:document.activeElement?.outerHTML?.slice(0,250),popover:document.querySelector('.popover')?.outerHTML?.slice(0,250),inert:document.querySelector('.layout-dock').inert})`)));
        await press('Escape','Escape',27);await sleep(100);
        assert.equal(await run(`!document.querySelector('.popover')&&document.activeElement===document.querySelector('.dock-open')`),true,'Escape restores minimal dock trigger focus');
        const point=await run(`(()=>{const r=document.querySelector('.dock-open').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});await sleep(100);
        assert.equal(await run(`!!document.querySelector('.popover .dock-items')&&!!document.activeElement.closest('.popover')`),true,'pointer opens minimal places and moves focus: '+JSON.stringify(await run(`(()=>{const r=document.querySelector('.dock-open').getBoundingClientRect();return{active:document.activeElement?.outerHTML?.slice(0,180),hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML?.slice(0,250),dock:JSON.stringify(r.toJSON()),guide:JSON.stringify(document.querySelector('.key-guide').getBoundingClientRect().toJSON())}})()`)));
        await press('Escape','Escape',27);await sleep(100);
        assert.equal(await run(`document.activeElement===document.querySelector('.dock-open')`),true,'pointer-opened places returns focus on Escape');
      }
      for (const view of ['board', 'timeline']) {
        await run(`document.querySelector('#viewSwitch button[aria-label="'+${JSON.stringify(view === 'timeline' ? '時間軸' : 'ボード')}+'"]')?.click()`);
        await sleep(180);
        if(layout==='omni'&&view==='timeline'){
          const sendPoint=await run(`(async()=>{
            const row=document.querySelector('.irow[data-card-id="claude:c2"]')||document.querySelector('.irow[data-card-id^="codex:"]');
            if(!row)throw Error('session row unavailable for pointer regression');row.click();
            for(let i=0;i<100&&!document.querySelector('.pane .send-round');i++)await new Promise(r=>setTimeout(r,50));
            const send=document.querySelector('.pane .send-round');if(!send)throw Error('send button unavailable');
            window.__sendPointerReached=false;send.addEventListener('click',e=>{e.preventDefault();e.stopImmediatePropagation();window.__sendPointerReached=true;},{capture:true,once:true});
            const r=send.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};
          })()`);
          await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...sendPoint});await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...sendPoint});
          assert.equal(await run(`window.__sendPointerReached===true&&document.querySelector('.dock-open').closest('#auxiliaryFragments')!==null&&!document.querySelector('.dock-open').closest('[inert]')`),true,'minimal places never intercepts send pointer and remains reachable with docked card');
          const dockPoint=await run(`(()=>{const r=document.querySelector('.dock-open').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
          await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...dockPoint});await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...dockPoint});
          assert.equal(await run(`!!document.querySelector('.popover .dock-items')&&!document.querySelector('.popover .dock-items').closest('[inert]')`),true,'places popup remains operable above the card');
          await press('Escape','Escape',27);
          assert.equal(await run(`document.activeElement===document.querySelector('.dock-open')`),true,'places popup restores app-bar trigger focus above a card');
        }
        const shot = await cdp('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(output, `${layout}-${view}-${theme}.png`), Buffer.from(shot.result.data, 'base64'));
        assert.equal(await run(`document.documentElement.scrollWidth <= 1280 && document.querySelector('.topbar').getBoundingClientRect().height < 65`), true, `${layout}/${view}/${theme} viewport and app bar`);
        if (layout === 'omni') assert.equal(await run(`(() => { const d = document.querySelector('.layout-dock').getBoundingClientRect(), g = document.querySelector('.key-guide').getBoundingClientRect(); return d.bottom <= g.top || g.bottom <= d.top || d.right <= g.left || g.right <= d.left; })()`), true, 'dock leaves keyboard hints visible');
        await run(`document.querySelector('#viewSwitch button[aria-label="ボード"]')?.click()`);
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

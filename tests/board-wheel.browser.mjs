// Real wheel input over long, isolated fictional lists must scroll the list itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from '../server/store.mjs';
import { makeFixtures } from './helpers.mjs';

const chromeBin = process.env.CANBAN_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const root = path.resolve(import.meta.dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('native mouse wheel scrolls long timeline and gantt lists', { timeout: 60000, skip: !fs.existsSync(chromeBin) && 'no Chrome' }, async t => {
  const fx = makeFixtures(), dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-wheel-data-'));
  const store = new Store(dataDir);
  for (let i = 0; i < 500; i++) await store.createTask({ title: `ホイール検証の架空タスク ${i}` });
  await store.close();
  const port = 5100 + Math.floor(Math.random() * 200), cdpPort = port + 1000;
  const host = spawn(process.execPath, ['tests/dev-host.mjs', String(port)], { cwd: root, stdio: 'ignore', env: {
    ...process.env, CANBAN_DATA_DIR: dataDir, CANBAN_CODEX_HOME: fx.codexHome, CANBAN_CLAUDE_HOME: fx.claudeHome,
    CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir, CANBAN_LAUNCH_DRYRUN: '1', CANBAN_SEARCH_INDEX: '0', CANBAN_BACKGROUND: '0',
  } });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-wheel-chrome-'));
  const chrome = spawn(chromeBin, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  t.after(() => {
    host.kill(); chrome.kill(); fx.cleanup();
    setTimeout(() => { for (const dir of [dataDir, profile]) try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, 300);
  });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://localhost:${port}`)).ok) break; } catch {} await sleep(100); }
  let target;
  for (let i = 0; i < 50 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find(x => x.type === 'page'); } catch {} if (!target) await sleep(200); }
  assert.ok(target, 'Chrome started');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => { ws.onopen = resolve; });
  t.after(() => ws.close());
  let sequence = 0;
  const pending = new Map(), errors = [];
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  };
  const cdp = (method, params = {}) => new Promise(resolve => { const id = ++sequence; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(result.result?.exceptionDetails, undefined, JSON.stringify(result.result?.exceptionDetails));
    return result.result.result.value;
  };
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://localhost:${port}/direct` });
  for (let i = 0; i < 100; i++) { if (await evaluate('!!document.querySelector(".card.face")')) break; await sleep(100); }
  const timings=[];
  for (const [name, selector] of [['時間軸', '.inbox-list'], ['ガント', '.gantt-list']]) {
    await t.test(name, async () => {
    const drawStart=performance.now();
    const point = await evaluate(`(async()=>{
      document.querySelector('#viewSwitch button[aria-label="${name}"]').click();
      for(let i=0;i<100;i++){
        const ready=document.querySelector('${selector}'),layer=document.querySelector('#paneLayer');
        if(ready&&ready.scrollHeight>ready.clientHeight&&(layer.hidden||layer.querySelector('.th-conv')))break;
        await new Promise(r=>setTimeout(r,30));
      }
      const list=document.querySelector('${selector}');
      if(!list||list.scrollHeight<=list.clientHeight)throw Error('fixture list must overflow: ${name}');
      if(!document.querySelector('#paneLayer').hidden&&!document.querySelector('#paneLayer .th-conv'))throw Error('initial dock must finish loading: ${name}');
      list.scrollTop=20;if(!list.scrollTop)throw Error('native scroll range missing: ${name}');list.scrollTop=0;
      window.__wheelNodes = [list]; window.__wheelScrolls=[];


      list.addEventListener('scroll',()=>window.__wheelScrolls.push({top:list.scrollTop,connected:list.isConnected,at:performance.now()}));
      window.__wheelObserver?.disconnect();
      const observer = window.__wheelObserver = new MutationObserver(()=>{const current=document.querySelector('${selector}');if(current&&current!==window.__wheelNodes.at(-1)){window.__wheelNodes.push(current);window.__wheelScrolls.push({replaced:true,top:current.scrollTop,at:performance.now()});}});
      observer.observe(document.querySelector('#board'),{childList:true,subtree:true});
      document.addEventListener('wheel',event=>{const actual=document.querySelector('${selector}');document.querySelector('#refresh').click();queueMicrotask(()=>{window.__wheelTrace={at:performance.now(),prevented:event.defaultPrevented,target:event.target.className,overflow:getComputedStyle(actual).overflowY,height:actual.clientHeight,content:actual.scrollHeight};});},{once:true});
      const r=list.getBoundingClientRect(),x=r.left+Math.min(r.width/2,100),y=r.top+Math.min(r.height/2,100);
      if(!document.elementFromPoint(x,y)?.closest('${selector}'))throw Error('wheel target is covered: ${name}');
      return {x,y};
    })()`);
    const drawMs=performance.now()-drawStart;
    timings.push({view:name,rows:500,readyMs:Math.round(drawMs),condition:'one sample, isolated data, 1280x800, view switch to scrollable list and dock frame; detail may still load; not a speedup claim'});
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
    await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 240 });
    let top = 0;
    for (let i = 0; i < 30 && !top; i++) { await sleep(50); top = await evaluate(`document.querySelector('${selector}').scrollTop`); }
    assert.ok(top > 0, `${name}: wheel must increase native list scrollTop; ${JSON.stringify(await evaluate('({wheel:window.__wheelTrace,scrolls:window.__wheelScrolls,nodes:window.__wheelNodes.length})'))}`);
    t.diagnostic(`${selector}: mouseWheel(deltaY=240), scrollTop 0 -> ${top}; ${JSON.stringify(await evaluate('({wheel:window.__wheelTrace,scrolls:window.__wheelScrolls,nodes:window.__wheelNodes.length})'))}`);
    const reloaded = await evaluate(`(async()=>{
      const previous=document.querySelector('${selector}'),previousRow=previous.querySelector('[data-card-id]');
      document.querySelector('#refresh').click();
      for(let i=0;i<100&&document.querySelector('${selector} [data-card-id]')===previousRow;i++)await new Promise(r=>setTimeout(r,30));
      const current=document.querySelector('${selector}');
      if(current.querySelector('[data-card-id]')===previousRow)throw Error('board rows did not refresh after reload: ${name}');
      if(current!==previous)throw Error('refresh detached its native scroll container: ${name}');
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      return current.scrollTop;
    })()`);
    assert.ok(Math.abs(reloaded-top)<=2, `${name}: reload must preserve wheel reading position (${top} -> ${reloaded}); ${JSON.stringify(await evaluate('window.__wheelScrolls'))}`);
    });
  }
  t.diagnostic(JSON.stringify(timings));
  assert.deepEqual(errors.filter(error => !/ResizeObserver/.test(error)), []);
});

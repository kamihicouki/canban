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
await step('create task or direct session', async () => {
  const tasks = async () => {
    const packet = await fetch('/rpc', { method: 'POST', body: JSON.stringify({ name: 'canban_get_board', arguments: { days: 0 } }) }).then(r => r.json());
    return packet.result.structuredContent.lists.flatMap(l => l.cards).filter(c => c.kind === 'task').length;
  };
  const fill = (selector, value) => { const el = document.querySelector(selector); if (!el) throw new Error('missing ' + selector); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const before = await tasks();
  document.querySelector('#quickTaskBtn').click();
  try {
    const dialog = document.querySelector('.task-quick-dialog');
    if (!dialog.querySelector('[data-create-mode="session"]')) throw new Error('direct session choice missing');
    if (!dialog.querySelector('textarea').getBoundingClientRect().height) throw new Error('task description hidden');
    fill('.task-title', '作成UIの確認');
    document.querySelector('[data-create-mode="session"]').click();
    if (document.querySelectorAll('.session-destination input').length !== 4) throw new Error('agent destinations missing');
    fill('.session-prompt', 'README の構成を確認してください');
    fill('.session-cwd', '/r/web');
    for (const destination of ['claude-desktop', 'codex-terminal', 'claude-terminal', 'codex-desktop']) {
      document.querySelector('input[value="' + destination + '"]').click();
      if (!document.activeElement.matches('input[name="session-destination"]:checked')) throw new Error('destination change lost keyboard focus');
      if (!document.querySelector('.session-prompt').value.includes('README')) throw new Error('destination change lost request');
    }
    document.querySelector('.session-prompt').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true }));
    if (!document.querySelector('.task-quick-feedback').hidden) throw new Error('IME Enter started a session');
    document.querySelector('[data-create-mode="task"]').click();
    if (document.querySelector('.task-title').value !== '作成UIの確認') throw new Error('task draft lost');
    document.querySelector('[data-create-mode="session"]').click();
    if (!document.querySelector('.session-prompt').value.includes('README')) throw new Error('session draft lost');
    for (let i = 0; i < 40 && document.querySelector('.task-quick-actions .btn-primary').disabled; i++) await w(100);
    if (document.querySelector('.task-quick-actions .btn-primary').disabled) throw new Error('desktop targets not ready');
    document.querySelector('.session-prompt').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    for (let i = 0; i < 40 && !document.querySelector('.task-quick-feedback').textContent.includes('新規画面'); i++) await w(100);
    if (!document.querySelector('.task-quick-feedback').textContent.includes('新規画面')) throw new Error('desktop opening result missing: ' + document.querySelector('.task-quick-feedback').textContent);
    if (await tasks() !== before) throw new Error('direct start created a task');
    document.querySelector('.task-quick-head button').click();
    document.querySelector('#quickTaskBtn').click();
    if (!document.querySelector('.session-prompt').value.includes('README')) throw new Error('closed session draft lost');
    document.querySelector('[data-create-mode="task"]').click();
    document.querySelector('.task-quick-actions .btn-primary').click();
    for (let i = 0; i < 40 && await tasks() === before; i++) await w(100);
    if (await tasks() !== before + 1) throw new Error('task creation failed');
  } finally { document.querySelector('.task-quick-dialog')?.close(); }
}, 300);
await step('unsupported environment keeps start controls visible', async () => {
  document.querySelector('#quickTaskBtn').click();
  document.querySelector('[data-create-mode="session"]').click();
  document.querySelector('.session-new-request:not([hidden])')?.click();
  document.querySelector('input[value="claude-desktop"]').click();
  for(let i=0;i<30&&!document.querySelector('select[aria-label="開始設定（Claudeの環境）"] option[value="fixture-env"]');i++) await w(100);
  const select=document.querySelector('select[aria-label="開始設定（Claudeの環境）"]'); select.value='fixture-env'; select.dispatchEvent(new Event('change',{bubbles:true}));
  const dialog=document.querySelector('.task-quick-dialog'), button=dialog.querySelector('.btn-primary');
  if(!dialog.textContent.includes('完全適用は未確認') || !button.disabled) throw new Error('unsupported preset is not explained and blocked');
  if(button.getBoundingClientRect().bottom>dialog.getBoundingClientRect().bottom) throw new Error('start action clipped by preset explanation');
  const folder=dialog.querySelector('select[aria-label="開始設定（Claudeの環境）"]');folder.value='__folder';folder.dispatchEvent(new Event('change',{bubbles:true}));
  const next=document.querySelector('.task-quick-dialog'); if(next.querySelector('.btn-primary').getBoundingClientRect().bottom>next.getBoundingClientRect().bottom) throw new Error('folder start action clipped');
  next.close();
});
await step('task start keeps unknown result and uses new payload only after an edited explicit submit', async () => {
  const taskId=document.querySelector('.card.task').dataset.cardId;
  const rpc=async(name,args)=>fetch('/rpc',{method:'POST',body:JSON.stringify({name,arguments:args})});
  await rpc('canban_link_session',{taskId,sessionId:'codex:t1'});key('r');await w(500);
  document.querySelector('[data-card-id="'+taskId+'"]').click();
  for(let i=0;i<30&&!document.querySelector('#paneLayer [data-sec="send"] textarea');i++) await w(100);
  const input=document.querySelector('#paneLayer [data-sec="send"] textarea');
  const send=document.querySelector('#paneLayer .send-round');
  const tool=window.openai.callTool, calls=[];
  window.openai.callTool=async(name,args)=>{
    if(name!=='canban_start_session')return tool(name,args);
    calls.push(JSON.parse(JSON.stringify(args)));
    return {structuredContent:{state:'uncertain',note:'fixture: 開始結果は未確認です。元アプリを確認してください。',receipt:{requestId:args.clientRequestId,status:'unresolved'}}};
  };
  const submit=async()=>{send.click();for(let i=0;i<30&&send.disabled;i++) await w(50);};
  try {
    input.value='first fake task request';input.dispatchEvent(new Event('input',{bubbles:true}));await submit();
    if(!document.querySelector('.toast')?.textContent.includes('開始結果は未確認です'))throw new Error('existing launch result toast missing');
    if(!document.querySelector('#paneLayer').textContent.includes('前回の開始結果は未確認'))throw new Error('unknown result hint missing');
    await submit();
    if(calls[0].clientRequestId!==calls[1].clientRequestId)throw new Error('unchanged request lost idempotency');
    input.value='edited fake task request';input.dispatchEvent(new Event('input',{bubbles:true}));await w(100);
    if(calls.length!==2)throw new Error('editing automatically relaunched');
    await submit();
    if(calls[2].prompt!==input.value||calls[2].clientRequestId===calls[1].clientRequestId)throw new Error('edited prompt reused old launch');
    const folder=document.querySelector('#paneLayer input[aria-label="作業フォルダ"]');folder.value='/r/other';folder.dispatchEvent(new Event('change',{bubbles:true}));await submit();
    if(calls[3].cwd!=='/r/other'||calls[3].clientRequestId===calls[2].clientRequestId)throw new Error('edited start setting reused old launch');
    document.querySelector('#paneLayer button[aria-label="開始する場所を選ぶ"]').click();
    const newRequestRow=[...document.querySelectorAll('.popover .menu-item')].find(button=>button.textContent.includes('新しい依頼に切り替える'));
    const rowRect=newRequestRow.getBoundingClientRect(), toastRect=document.querySelector('.toast').getBoundingClientRect();
    if(rowRect.left<toastRect.right&&rowRect.right>toastRect.left&&rowRect.top<toastRect.bottom&&rowRect.bottom>toastRect.top)throw new Error('new-request menu row is covered by the launch error toast');
    newRequestRow.click();
    if(calls.length!==4)throw new Error('new-request choice automatically launched');
    await submit();
    if(calls[4].prompt!==calls[3].prompt||calls[4].clientRequestId===calls[3].clientRequestId)throw new Error('unchanged explicit new request reused old ID');
    key('k',{metaKey:true});
    const fresh=[...document.querySelectorAll('.picker-row')].find(button=>button.textContent.includes('タスク: 新しい依頼に切り替える'));
    if(!fresh)throw new Error('palette new-request action missing');fresh.click();
    if(calls.length!==5)throw new Error('palette new-request action automatically launched');
    await submit();if(calls[5].clientRequestId===calls[4].clientRequestId)throw new Error('palette new-request action reused old ID');

  } finally {window.openai.callTool=tool;key('Escape');document.querySelector('.pane-close')?.click();await rpc('canban_unlink_session',{taskId,sessionId:'codex:t1'});key('r');await w(500);}
});
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
    for (let i = 0; i < 40 && !document.querySelector('.exchange-history .exchange-event'); i++) await w(100);
    if (!document.querySelector('.exchange-history .exchange-event')) throw new Error('message history missing');
    if (!document.querySelector('.exchange-popover .close .keycap')) throw new Error('Esc key hint missing');
    if (!document.querySelector('.exchange-history').textContent.includes('サブエージェント')) throw new Error('agent provenance missing');
  });
  await step('exchanges counterpart view', () => {
    document.querySelector('[data-exchange-mode="peer"]').click();
    const groups = document.querySelectorAll('.exchange-group');
    if (groups.length !== 2) throw new Error('counterpart grouping lost a peer');
    if (document.querySelectorAll('.exchange-event').length !== 4) throw new Error('repeat message lost');
    groups[0].querySelector('summary').click();
  });
  await step('exchanges chronology', () => {
    document.querySelector('[data-exchange-mode="timeline"]').click();
    if (document.querySelectorAll('.exchange-event').length !== 4) throw new Error('switch lost history');
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
await step('row', () => document.querySelector('.irow[data-card-id="codex:t1"]').click(), 1500);
await step('conversation labels and draft', async () => {
  const pane = document.querySelector('.pane[data-kind="session"]');
  if (!pane) throw new Error('selected session did not open');
  // Card content is fetched asynchronously; wait for the message, not a fixed click delay.
  for (let i = 0; i < 100 && !pane.querySelector('.fi-user .fi-content .raw'); i++) await w(100);
  const original = pane.querySelector('.fi-user .fi-content .raw');
  if (original?.textContent !== 'ログインを直して') throw new Error('original prompt changed: ' + JSON.stringify(original?.textContent));
  const stamp = pane.querySelector('.fi-user time');
  if (stamp?.getAttribute('datetime') !== '2026-09-20T00:00:01.000Z') throw new Error('message timestamp changed');
  if (!pane.querySelector('.fi-asst .fi-who')?.textContent.includes('Codex')) throw new Error('assistant speaker missing');
  const input = pane.querySelector('.send-box textarea');
  if (!input) throw new Error('composer unavailable');
  input.value = '未送信の下書き';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const feed = pane.querySelector('.feed');
  feed.scrollTop = 0;
  const before = feed.scrollTop;
  pane.querySelector('[data-side-tab="details"]').click();
  pane.querySelector('[data-side-tab="details"]').click();
  await w(100);
  if (feed.scrollTop !== before) throw new Error('details changed reading position');
  document.querySelector('.irow[data-card-id="codex:t1"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await w(400);
  document.querySelector('.pane-close').click();
  await w(400);
  const restored = document.querySelector('.pane[data-kind="session"] .send-box textarea');
  if (restored?.value !== '未送信の下書き') throw new Error('draft lost when returning to timeline');
  restored.value = '';
  restored.dispatchEvent(new Event('input', { bubbles: true }));
});
await step('timeline exchanges keyboard', async () => {
  document.querySelector('.irow[data-card-id="codex:t1"]').focus();
  key('M', { shiftKey: true }); await w(500);
  if (!document.querySelector('.exchange-popover')) throw new Error('timeline Shift+M did not open popup');
  key('Escape');
  if (!document.querySelector('#paneLayer').classList.contains('docked')) throw new Error('Esc closed the docked card');
});
await step('board', () => key('i'), 800);
await step('session', () => document.querySelector('.card.face:not(.task)').click(), 3000);
await step('relationship card views, cycles, history and drafts', async () => {
  const rootCard = document.querySelector('.card[data-card-id="codex:t1"]');
  rootCard.click();
  for(let i=0;i<40&&!document.querySelector('.pane[data-card-id="codex:t1"] .exchange-touchpoint');i++) await w(100);
  const root = document.querySelector('.pane[data-card-id="codex:t1"]');
  if(!root.querySelector('.th-meta .exchange-pill')) throw new Error('detail message entry missing');
  if([...root.querySelectorAll('.fi-user .fi-content')].some(el=>el.textContent.includes('<codex_delegation>'))) throw new Error('delivery metadata leaked into conversation');
  if([...root.querySelectorAll('.fi-user .fi-content')].some(el=>el.textContent==='メッセージ s1')) throw new Error('delivery repeated outside the contact');
  const input = root.querySelector('.send-box textarea');
  input.value = '循環しても残る下書き'; input.dispatchEvent(new Event('input', {bubbles:true}));
  root.querySelector('.feed').scrollTop = 0;
  const received = [...root.querySelectorAll('.exchange-touchpoint')].find(el => el.textContent.includes('メッセージ s1'))?.querySelector('button');
  if (!received || received.disabled) throw new Error('available incoming touchpoint missing');
  received.click();
  for(let i=0;i<40&&!document.querySelector('.pane[data-card-id="codex:t2"] .exchange-touchpoint');i++) await w(100);
  const first = [...document.querySelectorAll('.pane-row > .pane')].map(el=>el.dataset.cardId);
  if (first.join() !== 'codex:t2,codex:t1') throw new Error('incoming peer did not open left: '+first);
  for (const view of ['spread', 'center', 'stack']) {
    const button = document.querySelector('[data-exchange-view="'+view+'"]:is(button)');
    button.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true})); button.click();
    if(document.querySelector('#paneLayer').hidden) throw new Error('view control closed the layer');
    if(document.querySelector('#paneLayer').dataset.exchangeView!==view) throw new Error('view did not change');
  }
  const peek = document.querySelector('.exchange-stack-peek');
  if (peek) {
    peek.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); peek.click(); await w(100);
    if(document.querySelector('#paneLayer').hidden) throw new Error('stack peek closed the layer');
    document.querySelector('[aria-label="前に見ていたカードへ戻る"]').click(); await w(100);
  }
  for(let i=0;i<8;i++) {
    const active = document.querySelector('.pane[data-trail-active="true"]');
    const next = active.querySelector('.exchange-touchpoint-peer:not(:disabled)');
    if(!next) throw new Error('cycle touchpoint unavailable');
    const sent = next.closest('.exchange-touchpoint').classList.contains('is-sent');
    const sourceId = active.dataset.cardId;
    next.click(); await w(100);
    const shown = [...document.querySelectorAll('.pane-row > .pane')].map(el=>el.dataset.cardId);
    const peerId = document.querySelector('.pane[data-trail-active="true"]').dataset.cardId;
    if ((shown.indexOf(peerId) > shown.indexOf(sourceId)) !== sent) throw new Error('event direction did not match side');
  }
  if(document.querySelectorAll('.exchange-trail-path button').length!==10) throw new Error('cycle added unexpected visits');
  if(document.querySelectorAll('.pane-row > .pane').length!==2) throw new Error('revisit duplicated feed DOM');
  if(root.querySelector('.send-box textarea').value!=='循環しても残る下書き') throw new Error('cycle lost draft');
  const before = document.querySelector('.exchange-trail-path [aria-current="step"]').dataset.exchangeVisit;
  document.querySelector('.pane[data-trail-active="true"]').focus(); key('Escape'); await w(100);
  if(document.querySelector('.exchange-trail-path [aria-current="step"]').dataset.exchangeVisit===before) throw new Error('Esc did not return one visit');
  document.querySelector('[aria-label="次に見ていたカードへ進む"]').click(); await w(100);
  if(document.querySelector('.exchange-trail-path [aria-current="step"]').dataset.exchangeVisit!==before) throw new Error('forward did not restore visit');
  document.querySelector('.exchange-trail-path button[data-exchange-visit="v0"]').click(); await w(100);
  if(root.querySelector('.send-box textarea').value!=='循環しても残る下書き') throw new Error('origin lost draft');
  if(root.querySelector('.feed').scrollTop !== 0) throw new Error('origin lost reading position');
  const mode = root.dataset.mode;
  key('2',{shiftKey:true,code:'Digit2'});
  if(root.dataset.mode!==mode || document.querySelector('#paneLayer').dataset.exchangeView!=='center') throw new Error('view shortcut also changed conversation mode');
  input.value=''; input.dispatchEvent(new Event('input',{bubbles:true}));
  root.querySelector('.pane-close').click();
  rootCard.click(); await w(500);
});
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
  const appDir = path.dirname(fx.desktopDir);
  fs.writeFileSync(path.join(appDir,'config.json'),JSON.stringify({lastKnownAccountUuid:'fixture-account'}));
  fs.writeFileSync(path.join(appDir,'ccd-session-presets.json'),JSON.stringify({byAccount:{'fixture-account':{presets:[{id:'fixture-env',name:'複数フォルダの環境',target:{kind:'local',cwd:'/r/web',additionalFolders:['/r/api']}}]}}}));
  const edgeDb = new DatabaseSync(path.join(fx.codexHome, 'state_5.sqlite'));
  edgeDb.exec("CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT); INSERT INTO thread_spawn_edges VALUES ('t1','t2')");
  edgeDb.prepare("UPDATE threads SET title='リリースの確認', name='リリースの確認', updated_at_ms=? WHERE id='t1'").run(Date.now() - 120000);
  const peerRollout = path.join(fx.codexHome, 'sessions', 'rollout-peer.jsonl');
  fs.writeFileSync(peerRollout, JSON.stringify({ timestamp: '2026-10-14T01:44:00Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'peer-request', content: [{type:'text',text:'<codex_delegation><source_thread_id>t1</source_thread_id><input>レビューしてください</input></codex_delegation>'}] } } })+'\n');
  edgeDb.prepare("UPDATE threads SET title='検証', name='検証', rollout_path=? WHERE id='t2'").run(peerRollout);
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
  const openLive = await cdp('Runtime.evaluate', { expression: `(async()=>{document.querySelector('.card[data-card-id="codex:t1"]').click();for(let i=0;i<40&&!document.querySelector('.pane[data-card-id="codex:t1"] .exchange-touchpoint');i++)await new Promise(r=>setTimeout(r,100));return !!document.querySelector('.pane[data-card-id="codex:t1"] .exchange-touchpoint')})()`, awaitPromise:true, returnByValue:true });
  assert.equal(openLive.result?.result?.value,true,'open existing card before live receipt');
  fs.appendFileSync(fx.rollout, JSON.stringify({timestamp:new Date().toISOString(),type:'event_msg',payload:{type:'item_completed',item:{type:'UserMessage',id:'live-receipt',content:[{type:'text',text:'<codex_delegation><source_thread_id>t2</source_thread_id><input>開いたまま届いた結果</input></codex_delegation>'}]}}})+'\n');
  const liveReceipt = await cdp('Runtime.evaluate', { expression: `(async()=>{for(let i=0;i<100;i++){if([...document.querySelectorAll('.pane[data-card-id="codex:t1"] .exchange-touchpoint')].some(el=>el.textContent.includes('開いたまま届いた結果')))return true;await new Promise(r=>setTimeout(r,100));}return false;})()`, awaitPromise:true, returnByValue:true });
  assert.equal(liveReceipt.result?.result?.value,true,'live receipt adds a contact without reopening');
  const closeLive = await cdp('Runtime.evaluate', {expression:`document.querySelector('.pane-close')?.click()`,returnByValue:true});
  assert.equal(closeLive.result?.exceptionDetails,undefined);

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
  if (process.env.CANBAN_CREATION_SHOTS) {
    const dir = path.resolve(process.env.CANBAN_CREATION_SHOTS);
    fs.mkdirSync(dir, { recursive: true });
    for (const view of ['board', 'timeline']) for (const theme of ['light', 'dark']) for (const mode of ['task', 'session']) {
      const capture = await cdp('Runtime.evaluate', { expression: `(async()=>{
        document.querySelector('.task-quick-dialog')?.close();
        document.querySelector('.exchange-popover .close')?.click();
        if(!document.querySelector('#paneLayer').hidden && !document.querySelector('#paneLayer').classList.contains('docked')) document.querySelector('.pane-close')?.click();
        if (!!document.querySelector('.inbox') !== ${view === 'timeline'}) document.dispatchEvent(new KeyboardEvent('keydown',{key:'i',bubbles:true}));
        await new Promise(r=>setTimeout(r,400));
        document.documentElement.dataset.theme=${JSON.stringify(theme)};
        document.querySelector('#quickTaskBtn').click();
        document.querySelector('[data-create-mode="${mode}"]').click();
        document.querySelector('.session-new-request:not([hidden])')?.click();
        for (const [selector,value] of ${JSON.stringify(mode === 'task' ? [['.task-title','リリース前の確認'],['.task-description','変更内容を確認して、公開前のチェック項目をまとめる。']] : [['.session-prompt','READMEの構成を確認して、改善点をまとめてください。'],['.session-cwd','/work/canban']])}) {
          const el=document.querySelector(selector); el.value=value; el.dispatchEvent(new Event('input',{bubbles:true}));
        }
        const dialog=document.querySelector('.task-quick-dialog'); dialog.scrollTop=0;
        const rect=dialog.getBoundingClientRect(), action=dialog.querySelector('.btn-primary').getBoundingClientRect();
        if(rect.top<(document.querySelector('.topbar')?.getBoundingClientRect().bottom || 40)-1 || rect.bottom>innerHeight || action.bottom>rect.bottom || dialog.scrollWidth>dialog.clientWidth+1) throw new Error('creation controls overflow at 1280x800: '+JSON.stringify({rect:rect.toJSON(),action:action.toJSON(),scrollWidth:dialog.scrollWidth,clientWidth:dialog.clientWidth}));
        if(!!document.querySelector('.inbox') !== ${view === 'timeline'}) throw new Error('wrong screenshot view');
      })()`, awaitPromise:true, returnByValue:true });
      const shot=await cdp('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(path.join(dir,`${view}-${theme}-${mode}.png`),Buffer.from(shot.result.data,'base64'));
      assert.equal(capture.result.exceptionDetails, undefined, JSON.stringify(capture.result.exceptionDetails));
    }
  }
  if (process.env.CANBAN_PROMPT_IMAGE_SHOTS) {
    const dir=path.resolve(process.env.CANBAN_PROMPT_IMAGE_SHOTS);fs.mkdirSync(dir,{recursive:true});
    const data=fs.readFileSync(path.join(root,'assets','canban.png')).toString('base64');
    for (const view of ['board','timeline']) for (const theme of ['light','dark']) {
      const capture=await cdp('Runtime.evaluate',{expression:`(async()=>{
        document.querySelector('.task-quick-dialog')?.close();document.querySelector('.exchange-popover .close')?.click();
        if(!document.querySelector('#paneLayer').hidden && !document.querySelector('#paneLayer').classList.contains('docked'))document.querySelector('.pane-close')?.click();
        if(!!document.querySelector('.inbox')!==${view==='timeline'})document.dispatchEvent(new KeyboardEvent('keydown',{key:'i',bubbles:true}));
        await new Promise(r=>setTimeout(r,400));document.documentElement.dataset.theme=${JSON.stringify(theme)};
        document.querySelector('#quickTaskBtn').click();document.querySelector('[data-create-mode="session"]').click();
        document.querySelector('.session-new-request:not([hidden])')?.click();
        let d=document.querySelector('.task-quick-dialog');for(const button of d.querySelectorAll('.prompt-image button'))button.click();
        const input=d.querySelector('.session-prompt');input.value='添付した画面を確認してください。';input.dispatchEvent(new Event('input',{bubbles:true}));
        const bytes=Uint8Array.from(atob(${JSON.stringify(data)}),c=>c.charCodeAt(0)),transfer=new DataTransfer();
        for(let i=0;i<8;i++)transfer.items.add(new File([bytes],'画面'+(i+1)+'.png',{type:'image/png'}));
        const file=d.querySelector('input[type="file"]');file.files=transfer.files;file.dispatchEvent(new Event('change',{bubbles:true}));
        for(let i=0;i<100;i++){d=document.querySelector('.task-quick-dialog');if(d.querySelectorAll('.prompt-image img').length===8 && !d.textContent.includes('添付中'))break;await new Promise(r=>setTimeout(r,100));}
        if(d.querySelectorAll('.prompt-image img').length!==8)throw new Error('8th image preview missing: '+JSON.stringify({count:d.querySelectorAll('.prompt-image img').length,notice:d.querySelector('.prompt-notice')?.textContent,readOnly:d.querySelector('.session-prompt').readOnly,fileDisabled:file.disabled}));
        d.querySelector('.creation-body').scrollTop=d.querySelector('.creation-body').scrollHeight;
        const action=d.querySelector('.task-quick-actions').getBoundingClientRect(),rect=d.getBoundingClientRect();
        if(action.bottom>rect.bottom+1)throw new Error('image composer actions overflow');
      })()`,awaitPromise:true,returnByValue:true});
      assert.equal(capture.result.exceptionDetails,undefined,JSON.stringify(capture.result.exceptionDetails));
      const shot=await cdp('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(dir,`${view}-${theme}-images.png`),Buffer.from(shot.result.data,'base64'));
    }
  }
  if (process.env.CANBAN_DESKTOP_ACCOUNT_SHOTS) {
    const dir = path.resolve(process.env.CANBAN_DESKTOP_ACCOUNT_SHOTS); fs.mkdirSync(dir, { recursive: true });
    const fixture = await cdp('Runtime.evaluate', { expression: `{
      const original = window.openai.callTool;
      window.openai.callTool = (name,args) => name === 'canban_desktop_accounts'
        ? Promise.resolve({result:{accountSwitch:true,profiles:[{account:'claude:account-a',active:true}],pending:{account:'claude:account-b',active:false}}})
        : original(name,args);
    }` });
    assert.equal(fixture.result?.exceptionDetails, undefined);
    for (const view of ['board','timeline']) for (const theme of ['light','dark']) {
      const capture = await cdp('Runtime.evaluate', { expression: `(async()=>{
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
        if(!!document.querySelector('.inbox') !== ${view === 'timeline'})document.dispatchEvent(new KeyboardEvent('keydown',{key:'i',bubbles:true}));
        document.documentElement.dataset.theme=${JSON.stringify(theme)};
        await new Promise(r=>setTimeout(r,300));
        document.querySelector('#accountsBtn').click();
        for(let i=0;i<40&&!document.querySelector('.acct-desktop-resume');i++)await new Promise(r=>setTimeout(r,100));
        const resume=[...document.querySelectorAll('.acct-desktop-actions button')].find(b=>b.textContent.includes('初回接続を再開'));
        if(!resume)throw new Error('cancelled Desktop connection cannot resume');
        const rect=resume.getBoundingClientRect();if(rect.top<0||rect.bottom>innerHeight)throw new Error('Desktop reconnect action clipped');
        const boundary=document.querySelector('.acct-desktop').getBoundingClientRect();
        for(const control of document.querySelectorAll('.acct-desktop-actions button,.acct-desktop-actions select'))if(control.getBoundingClientRect().right>boundary.right+1)throw new Error('Desktop connection action overflows its section');
      })()`, awaitPromise:true });
      assert.equal(capture.result?.exceptionDetails, undefined, JSON.stringify(capture.result?.exceptionDetails));
      const shot = await cdp('Page.captureScreenshot', { format:'png',captureBeyondViewport:false });
      fs.writeFileSync(path.join(dir,`${view}-${theme}-accounts.png`),Buffer.from(shot.result.data,'base64'));
      const pickerCapture = await cdp('Runtime.evaluate', { expression: `(async()=>{
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
        const card=document.querySelector('[data-card-id="claude:c2"]');if(!card)throw new Error('Claude card not found');card.click();
        for(let i=0;i<40&&!document.querySelector('.th-tool[data-side-tab="details"]');i++)await new Promise(r=>setTimeout(r,100));
        const details=document.querySelector('.th-tool[data-side-tab="details"]');if(details?.getAttribute('aria-pressed')!=='true')details?.click();
        const control=document.querySelector('.desktop-resume-control');if(!control)throw new Error('Desktop account picker absent');
        control.scrollIntoView({block:'nearest'});
        for(let i=0;i<40&&!control.textContent.includes('Claude を開く');i++)await new Promise(r=>setTimeout(r,100));
        const button=control.querySelector('[data-resume-desktop]');if(!button.textContent.includes('Claude を開く'))throw new Error('selected Desktop name absent');button.scrollIntoView({block:'nearest'});
      })()`, awaitPromise:true });
      assert.equal(pickerCapture.result?.exceptionDetails,undefined,JSON.stringify(pickerCapture.result?.exceptionDetails));
      const pickerShot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      fs.writeFileSync(path.join(dir,`${view}-${theme}-desktop-picker.png`),Buffer.from(pickerShot.result.data,'base64'));
    }
  }
  ws.close();
});

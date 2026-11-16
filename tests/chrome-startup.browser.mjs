// Run the built MV3 page in an isolated Chromium profile with controlled Native responses.
// No registered extension, user data or real Native Host participates in this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { makeFixtures, stopChild } from './helpers.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const chromium = process.env.CANBAN_BROWSER_EXECUTABLE;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(read, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function nativeFixture(board, sessions) {
  const requests = [], held = [];
  let receive;
  const reply = (request, result) => receive({ jsonrpc: '2.0', id: request.id, result: { structuredContent: result } });
  const port = {
    onMessage: { addListener(listener) { receive = listener; } },
    onDisconnect: { addListener() {} },
    postMessage(request) {
      requests.push(request);
      const name = request.params?.name;
      if (name === 'canban_get_board') { held.push(request); return; }
      if (name === 'canban_watch') return;
      const result = name === 'canban_get_session' ? sessions[request.params.arguments.cardId]
        : name === 'canban_get_ui_state' ? { result: { revision: 0, state: null } }
        : name === 'canban_save_ui_state' ? { result: { saved: true, revision: 1 } }
          : {};
      queueMicrotask(() => reply(request, result));
    },
  };
  Object.defineProperty(chrome.runtime, 'connectNative', { value: () => port, configurable: true });
  window.__startupNative = {
    requests, held, boardReplies: 0,
    release(value = board) { for (const request of held.splice(0)) { window.__startupNative.boardReplies++; reply(request, value); } },
    reject() { for (const request of held.splice(0)) receive({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: '架空の初回取得エラー' } }); },
  };
}

test('the built Chrome extension survives controls before data, failed load and retry', {
  timeout: 90000,
  skip: !chromium && !process.env.CI && 'CANBAN_BROWSER_EXECUTABLE must name Chromium or Chrome for Testing',
}, async t => {
  assert.ok(chromium && fs.existsSync(chromium), 'CANBAN_BROWSER_EXECUTABLE must name installed Chromium or Chrome for Testing');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-startup-artifact-'));
  const extension = path.join(directory, 'extension');
  const profile = path.join(directory, 'profile');
  const data = path.join(directory, 'data');
  const fixtures = makeFixtures();
  let chrome, host, socket;
  t.after(async () => {
    socket?.close();
    await Promise.all([chrome && stopChild(chrome), host && stopChild(host)]);
    fixtures.cleanup();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  if (process.env.CANBAN_STARTUP_ARTIFACT_DIR) fs.cpSync(path.resolve(process.env.CANBAN_STARTUP_ARTIFACT_DIR), extension, { recursive: true });
  else {
    const build = spawnSync(process.execPath, ['scripts/build-chrome.mjs', '--outdir', extension], { cwd: root, encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr);
  }
  // A test-only public key makes the isolated unpacked extension's origin deterministic.
  // Runtime assets remain byte-for-byte as produced by the Chrome build.
  const manifestPath = path.join(extension, 'manifest.json');
  const testManifest = JSON.parse(fs.readFileSync(manifestPath));
  testManifest.key = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC+W6DFhzKBXqBAT3uZtGX/FmZemWm9c/Eow2+coJhn3/ev4Wc5rx+eOlXCUJWf+gVK6EPZxqVoJVuBeZSXzQ6bZ9s+lanoyfJpcKvDEx6yuTgkNFVr5aGAij8MQznqU0eZ3OjE/88HJqNOV+/8h6nqbVgVvHSYVN0E79qM2LBuBQIDAQAB';
  fs.writeFileSync(manifestPath, JSON.stringify(testManifest));
  const port = 5200 + Math.floor(Math.random() * 500);
  host = spawn(process.execPath, ['tests/dev-host.mjs', String(port)], { cwd: root, stdio: 'ignore', env: {
    ...process.env, CANBAN_DATA_DIR: data, CANBAN_CODEX_HOME: fixtures.codexHome,
    CANBAN_CLAUDE_HOME: fixtures.claudeHome, CANBAN_CLAUDE_DESKTOP_DIR: fixtures.desktopDir,
    CANBAN_LAUNCH_DRYRUN: '1', CANBAN_SEARCH_INDEX: '0', CANBAN_BACKGROUND: '0',
  } });
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}`)).ok; } catch { return false; } }, 'fictional data host');
  const rpc = async (name, args) => {
    const response = await fetch(`http://127.0.0.1:${port}/rpc`, { method: 'POST', body: JSON.stringify({ name, arguments: args }) });
    const packet = await response.json();
    assert.equal(packet.error, undefined);
    assert.notEqual(packet.result?.isError, true);
    return packet.result.structuredContent;
  };
  await rpc('canban_create_directory', { name: '架空のカテゴリ', color: 'blue' });
  const board = await rpc('canban_get_board', { days: 0 });
  assert.ok(board.lists.some(list => list.cards.length));
  for (const list of board.lists) for (const card of list.cards) card.updatedAt = Date.now();
  const sessions = {};
  for (const list of board.lists) for (const card of list.cards) if (card.kind !== 'task') sessions[card.id] = await rpc('canban_get_session', { cardId: card.id });
  const debugPort = port + 1000;
  chrome = spawn(chromium, ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, ...(process.env.CI && process.platform === 'linux' ? ['--no-sandbox'] : []), '--no-first-run', 'about:blank'], { stdio: ['ignore','ignore','pipe'] });
  let chromeStderr = ''; chrome.stderr.on('data', bytes => { chromeStderr += bytes; });
  const targets = async () => {
    try { return await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json(); } catch { return []; }
  };
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json')));
  const extensionId = createHash('sha256').update(manifest.key ? Buffer.from(manifest.key, 'base64') : extension).digest('hex').slice(0,32).replace(/[0-9a-f]/g, value => String.fromCharCode(97 + parseInt(value,16)));
  const extensionOrigin = `chrome-extension://${extensionId}`;
  const page = await until(async () => (await targets()).find(target => target.type === 'page'), 'isolated Chrome page').catch(error => { throw new Error(error.message + '\nexit=' + chrome.exitCode + '\nchrome=' + chromeStderr.slice(-2000)); });
  assert.ok(page, 'isolated Chrome page exists');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const pending = new Map(), errors = [], consoleErrors = [];
  let messageId = 0;
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(message.params.args.map(arg => arg.description || arg.value).join(' '));
    if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  };
  const cdp = (method, params = {}) => new Promise(resolve => {
    const id = ++messageId;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  const run = async expression => {
    const response = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.equal(response.error, undefined);
    assert.equal(response.result.exceptionDetails, undefined, JSON.stringify(response.result.exceptionDetails));
    return response.result.result.value;
  };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(${nativeFixture.toString()})(${JSON.stringify(board)}, ${JSON.stringify(sessions)})` });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const evidenceDirectory = process.env.CANBAN_STARTUP_EVIDENCE_DIR || process.env.CANBAN_STARTUP_SHOTS;
  const capture = async name => {
    if (!evidenceDirectory) return;
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    const screenshot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(evidenceDirectory, name + '.png'), Buffer.from(screenshot.result.data, 'base64'));
  };
  const runtimeHashes = Object.fromEntries(['board.html','board.js','board.css'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(extension,file))).digest('hex')]));
  const observations = [];
  for (const theme of ['light', 'dark']) {
    await cdp('Page.navigate', { url: `${extensionOrigin}/board.html` });
    await until(() => run('!!window.__startupNative?.held.length'), 'pending initial board response').catch(async error => { throw new Error(error.message + '\nlocation=' + await run('location.href') + '\nerrors=' + JSON.stringify(errors) + '\nchrome=' + chromeStderr.slice(-1500)); });
    assert.equal(await run('location.protocol'), 'chrome-extension:', 'exercise the MV3 extension page');
    assert.equal(await run('typeof window.openai'), 'undefined', 'exercise Native Messaging rather than the dev-host shim');
    for (const [file, expectedHash] of Object.entries(runtimeHashes)) {
      const actualHash = await run(`(async()=>{const bytes=await(await fetch(${JSON.stringify(file)})).arrayBuffer();const digest=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');})()`);
      assert.equal(actualHash, expectedHash, `${file} loaded from the built artifact`);
    }

    assert.equal(await run('window.__startupNative.boardReplies === 0 && !document.querySelector(".card.face")'), true, 'exercise controls before the first board response');
    await run(`document.documentElement.dataset.theme='${theme}'; document.querySelector('#logo').click(); document.dispatchEvent(new KeyboardEvent('keydown',{key:'p',bubbles:true}));`);
    assert.deepEqual(errors, [], 'early clicks and keys must not throw before the first board response');
    assert.equal(await run('window.__startupNative.boardReplies === 0 && !document.querySelector(".card.face")'), true, 'early controls must not manufacture an empty board');
    assert.equal(await run('!!document.querySelector(".popover .picker")'), false, 'no picker may fabricate data before load');
    await capture(`pending-${theme}`);
    await run('window.__startupNative.reject()');
    await until(() => run('document.querySelector("#board").textContent.includes("架空の初回取得エラー")'), 'visible initial-load failure');
    await run(`document.querySelector('#logo').click(); document.dispatchEvent(new KeyboardEvent('keydown',{key:'p',bubbles:true}));`);
    assert.equal(await run('window.__startupNative.boardReplies === 0 && !document.querySelector(".card.face")'), true);
    await capture(`failed-${theme}`);
    await run('document.querySelector("#refresh").click()');
    await until(() => run('window.__startupNative.held.length > 0'), 'retry request');
    await run('window.__startupNative.release()');
    await until(() => run('!!document.querySelector(".card.face")'), 'recovered board');
    await capture(`recovered-board-${theme}`);
    await run('document.querySelector("#logo").click()');
    await until(() => run('!!document.querySelector(".picker-row")'), 'recovered filter picker');
    assert.equal(await run('document.querySelector(".popover").textContent.includes("架空のカテゴリ")'), true);
    await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); document.querySelector('#refresh').click();`);
    await until(() => run('window.__startupNative.held.length > 0'), 'refresh request');
    await run('document.querySelector("#logo").click()');
    assert.equal(await run('document.querySelector(".popover").textContent.includes("架空のカテゴリ")'), true, 'retained board stays usable during refresh');
    await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); window.__startupNative.release();`);
    await run(`document.querySelector('#q').value='保持する入力'; window.__startupRetainedCard=document.querySelector('.card.face'); document.querySelector('.toast')?.remove(); document.querySelector('#refresh').click();`);
    await until(() => run('window.__startupNative.held.length > 0'), 'failed refresh request');
    await run('window.__startupNative.reject()');
    await until(() => run('document.querySelector(".toast.error")?.textContent.includes("架空の初回取得エラー")'), 'visible refresh failure');
    assert.equal(await run('window.__startupRetainedCard === document.querySelector(".card.face") && window.__startupRetainedCard.isConnected'), true, 'failed refresh preserves the card DOM');
    assert.equal(await run('document.querySelector("#q").value'), '保持する入力', 'failed refresh preserves input');
    assert.equal(await run('document.querySelector(".toast")?.textContent.includes("最新の状態に更新しました")'), false, 'failed refresh cannot report success');
    await capture(`refresh-failed-${theme}`);
    await run(`document.querySelector('#q').value=''; document.querySelector('#refresh').click();`);
    await until(() => run('window.__startupNative.held.length > 0'), 'refresh recovery request');
    await run('window.__startupNative.release()');
    await until(() => run('document.querySelector(".toast")?.textContent.includes("最新の状態に更新しました")'), 'refresh recovery notice');
    await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'i',bubbles:true}));`);
    await until(() => run('!!document.querySelector(".inbox")'), 'recovered timeline');
    await capture(`recovered-timeline-${theme}`);
    await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'i',bubbles:true})); document.dispatchEvent(new KeyboardEvent('keydown',{key:'i',bubbles:true}));`);
    const empty = { ...board, lists: board.lists.map(list => ({ ...list, cards: [], count: 0 })), totals: { ...board.totals, shown: 0 }, statusCounts: {} };
    await run('document.querySelector("#refresh").click()');
    await until(() => run('window.__startupNative.held.length > 0'), 'empty-board request');
    await run(`window.__startupNative.release(${JSON.stringify(empty)})`);
    await until(() => run('!document.querySelector(".card.face") && document.querySelector("#logo").title.includes("表示 0")'), 'valid empty board');
    assert.equal(await run('document.querySelector("#board").textContent.includes("読み込みに失敗")'), false, 'valid empty data is distinct from failure');
    observations.push({ theme, initialBoardNull: true, failedLoadVisible: true, retryRecovered: true, refreshRetainedCategories: true, refreshFailureRetainedDomAndInput: true, validEmptyAccepted: true });
    await capture(`empty-${theme}`);
  }
  assert.deepEqual(errors, [], 'built extension has no uncaught startup/interaction errors');
  assert.deepEqual(consoleErrors, [], 'built extension has no console errors');
  if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, 'startup-metrics.json'), JSON.stringify({ generatedExtension: extensionOrigin, runtimeHashes, viewport: [1280, 800], nativeTransport: 'isolated controlled fake', observations }, null, 2));
});

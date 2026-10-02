import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { FrameDecoder, encodeNativeResponse } from '../server/native-messaging.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'ui/board.html'), 'utf8');
const bridgeSource = html.slice(html.indexOf('const bridge = (() => {'), html.indexOf('\n})();', html.indexOf('const bridge = (() => {')) + 6);
const liveSource = html.slice(html.indexOf('async function watchOnce('), html.indexOf('\nasync function liveLoop('));

function harness(native = true) {
  let now = 0;
  const requests = [], warnings = [], info = [];
  let receive;
  const port = {
    postMessage(message) { requests.push(message); },
    onMessage: { addListener(fn) { receive = fn; } },
    onDisconnect: { addListener() {} },
  };
  const window = { parent: { postMessage(message) { requests.push(message); } }, addEventListener(_name, fn) { if (!native) receive = (data) => fn({ source: window.parent, data }); } };
  const live = { mode: 'long', inflight: 0, lastWatchEnd: 0 };
  const context = vm.createContext({ window, live,
    location: { protocol: native ? 'chrome-extension:' : 'https:' },
    chrome: { runtime: { connectNative: () => port } },
    performance: { now: () => now },
    console: { warn: (...args) => warnings.push(args), info: (...args) => info.push(args), error: (...args) => warnings.push(args) },
    setTimeout: () => 0, clearTimeout() {},
    watchArgs: (timeoutMs) => ({ timeoutMs }), applyLive() {},
  });
  vm.runInContext(bridgeSource + '\n' + liveSource, context);
  return {
    live, requests, warnings, info,
    time(value) { now = value; },
    watch(timeoutMs) { return vm.runInContext(`watchOnce(${timeoutMs})`, context); },
    tool() { return vm.runInContext("bridge.callTool('canban_get_board')", context); },
    reply(index) { receive({ jsonrpc: '2.0', id: requests[index].id, result: { structuredContent: {} } }); },
  };
}

test('a delayed Native Messaging response near a watch completion keeps realtime enabled', async () => {
  const h = harness();
  const watch = h.watch(20000);
  const board = h.tool();
  h.time(1990); h.reply(0); await watch;
  h.time(2000); h.reply(1); await board;
  assert.equal(h.live.mode, 'long');
  assert.equal(h.warnings.length, 0);
});

test('a quick watch response does not downgrade Chrome while the long watch remains pending', async () => {
  const h = harness();
  const longWatch = h.watch(20000);
  const board = h.tool();
  h.time(1900); const quickWatch = h.watch(0);
  h.time(1990); h.reply(2); await quickWatch;
  assert.equal(h.live.inflight, 1);
  h.time(2000); h.reply(1); await board;
  assert.equal(h.live.mode, 'long');
  assert.equal(h.warnings.length, 0);
  h.reply(0); await longWatch;
});

test('hosts with unknown concurrency retain the responsive polling fallback', async () => {
  const h = harness(false);
  const watch = h.watch(20000), board = h.tool();
  h.time(1990); h.reply(0); await watch;
  h.time(2000); h.reply(1); await board;
  assert.equal(h.live.mode, 'short');
  assert.equal(h.warnings.length, 0);
  assert.equal(h.info.length, 1);
});

test('Native Host answers another tool while a long watch is pending', { timeout: 15000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-native-live-'));
  const dirs = Object.fromEntries(['data', 'codex', 'claude', 'desktop'].map((key) => {
    const dir = path.join(temp, key); fs.mkdirSync(dir); return [key, dir];
  }));
  const child = spawn(process.execPath, [path.join(root, 'scripts/chrome-native-host.mjs')], {
    env: { ...process.env, CANBAN_NODE: process.execPath, CANBAN_DATA_DIR: dirs.data,
      CANBAN_CODEX_HOME: dirs.codex, CANBAN_CLAUDE_HOME: dirs.claude, CANBAN_CLAUDE_DESKTOP_DIR: dirs.desktop,
      CANBAN_SEARCH_INDEX: '0', CANBAN_BACKGROUND: '0', CANBAN_LAUNCH_DRYRUN: '1' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const waiting = new Map(), decoder = new FrameDecoder();
  let id = 0;
  child.stdout.on('data', (bytes) => {
    for (const message of decoder.push(bytes)) {
      const pending = waiting.get(message.id);
      if (!pending) continue;
      waiting.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result.structuredContent);
    }
  });
  const call = (name, args = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { waiting.delete(requestId); reject(new Error('Native Host response timed out')); }, 10000);
    waiting.set(requestId, { resolve, reject, timer });
    child.stdin.write(encodeNativeResponse({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name, arguments: args } })[0]);
  });
  try {
    const initial = await call('canban_watch', { since: null });
    const quiet = await call('canban_watch', { since: initial.seq, timeoutMs: 200 });
    let watchEnded = false;
    const watch = call('canban_watch', { since: quiet.seq, timeoutMs: 2000 }).then(() => { watchEnded = true; });
    await call('canban_get_perf');
    const concurrent = !watchEnded;
    await watch;
    assert.equal(concurrent, true, 'the quick tool must return before the pending long watch');
  } finally {
    child.stdin.end();
    if (child.exitCode == null && child.signalCode == null) await new Promise((resolve) => child.once('exit', resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

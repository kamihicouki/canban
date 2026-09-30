import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FrameDecoder, encodeNativeResponse, NATIVE_MESSAGE_MAX_BYTES } from '../server/native-messaging.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('native messaging frames handle partial reads and multiple messages', async () => {
  const first = encodeNativeResponse({ id: 1, result: 'first' })[0];
  const second = encodeNativeResponse({ id: 2, result: 'second' })[0];
  const decoder = new FrameDecoder();
  const bytes = Buffer.concat([first, second]);
  assert.deepEqual(decoder.push(bytes.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(bytes.subarray(3, first.length + 2)), [{ id: 1, result: 'first' }]);
  assert.deepEqual(decoder.push(bytes.subarray(first.length + 2)), [{ id: 2, result: 'second' }]);
});

test('large MCP responses are split below Chrome limits and reconstruct exactly', async () => {
  const response = { jsonrpc: '2.0', id: 7, result: { content: '🍙'.repeat(350000) } };
  const frames = encodeNativeResponse(response);
  assert.ok(frames.length > 1);
  const decoder = new FrameDecoder();
  const chunks = frames.flatMap((frame) => decoder.push(frame));
  assert.ok(chunks.every((message) => Buffer.byteLength(JSON.stringify(message)) < NATIVE_MESSAGE_MAX_BYTES));
  assert.ok(chunks.every((message) => message.__canbanChunk === 1));
  const restored = Buffer.concat(chunks.sort((a, b) => a.index - b.index).map((message) => Buffer.from(message.data, 'base64')));
  assert.deepEqual(JSON.parse(restored.toString('utf8')), response);
});

test('native host starts the existing MCP server and serves the isolated UI-state API', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-native-'));
  const child = (await import('node:child_process')).spawn(process.execPath, [path.join(root, 'scripts', 'chrome-native-host.mjs')], {
    cwd: root,
    env: { ...process.env, CANBAN_DATA_DIR: dataDir, CANBAN_SEARCH_INDEX: '0', CANBAN_LIVE: '0' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const decoder = new FrameDecoder();
  const seen = [];
  const waiters = new Map();
  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      seen.push(message);
      waiters.get(message.id)?.(message);
    }
  });
  const request = { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'canban_get_ui_state', arguments: {} } };
  child.stdin.write(encodeNativeResponse(request)[0]);
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`native host timed out; received ${seen.length} messages`)), 10000);
    waiters.set(12, (message) => { clearTimeout(timer); resolve(message); });
    child.once('error', reject);
  });
  assert.deepEqual(result.result.structuredContent.result, { revision: 0, state: null });
  child.stdin.end();
  await new Promise((resolve) => child.once('exit', resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('native host reports startup failure for queued requests and disconnects', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-native-failure-'));
  fs.mkdirSync(path.join(fixture, 'scripts'));
  fs.mkdirSync(path.join(fixture, 'server'));
  fs.copyFileSync(path.join(root, 'scripts', 'chrome-native-host.mjs'), path.join(fixture, 'scripts', 'chrome-native-host.mjs'));
  fs.copyFileSync(path.join(root, 'server', 'native-messaging.mjs'), path.join(fixture, 'server', 'native-messaging.mjs'));
  fs.writeFileSync(path.join(fixture, 'scripts', 'launch.sh'), 'read request\nexit 7\n');
  const { spawn } = await import('node:child_process');
  const host = spawn(process.execPath, [path.join(fixture, 'scripts', 'chrome-native-host.mjs')]);
  const messages = [];
  const decoder = new FrameDecoder();
  host.stdout.on('data', (chunk) => messages.push(...decoder.push(chunk)));
  host.stderr.resume();
  const timer = setTimeout(() => host.kill('SIGKILL'), 5000);
  try {
    const exit = new Promise((resolve, reject) => { host.once('close', (code, signal) => resolve({ code, signal })); host.once('error', reject); });
    host.stdin.write(encodeNativeResponse({ jsonrpc: '2.0', id: 19, method: 'tools/call', params: {} })[0]);
    const result = await exit;
    assert.equal(result.signal, null);
    assert.equal(messages[0]?.id, 19);
    assert.match(messages[0]?.error.message, /server stopped/);
  } finally {
    clearTimeout(timer);
    host.kill();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('Chrome native host and a desktop MCP client share state concurrently', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-concurrent-clients-'));
  const { spawn } = await import('node:child_process');
  const { createInterface } = await import('node:readline');
  const env = { ...process.env, CANBAN_DATA_DIR: dir, CANBAN_SEARCH_INDEX: '0', CANBAN_LIVE: '0' };
  const native = spawn(process.execPath, [path.join(root, 'scripts', 'chrome-native-host.mjs')], { env });
  const desktop = spawn(process.execPath, [path.join(root, 'server', 'index.mjs')], { env });
  const pending = [new Map(), new Map()];
  const timers = new Set();
  const receive = (client, message) => pending[client].get(message.id)?.(message);
  const decoder = new FrameDecoder();
  native.stdout.on('data', (data) => decoder.push(data).forEach((message) => receive(0, message)));
  const lines = createInterface({ input: desktop.stdout });
  lines.on('line', (line) => receive(1, JSON.parse(line)));
  native.stderr.resume(); desktop.stderr.resume();
  let nextId = 1;
  const call = (client, method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending[client].delete(id); reject(new Error('client request timed out')); }, 10000);
    timers.add(timer);
    pending[client].set(id, (message) => { clearTimeout(timer); timers.delete(timer); pending[client].delete(id); resolve(message); });
    const request = { jsonrpc: '2.0', id, method, params };
    if (client === 0) native.stdin.write(encodeNativeResponse(request)[0]);
    else desktop.stdin.write(`${JSON.stringify(request)}\n`);
  });
  const tool = async (client, name, args = {}) => {
    const response = await call(client, 'tools/call', { name, arguments: args });
    assert.equal(response.error, undefined);
    return response.result.structuredContent.result;
  };
  try {
    const init = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex', version: '1' } });
    assert.equal(init.error, undefined);
    desktop.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const results = await Promise.all([0, 1].map((client) => tool(client, 'canban_save_ui_state', { expectedRevision: 0, state: { view: client ? 'analytics' : 'board' } })));
    assert.equal(results.filter((result) => result.saved).length, 1);
    assert.equal(results.filter((result) => result.conflict).length, 1);
    const states = await Promise.all([0, 1].map((client) => tool(client, 'canban_get_ui_state')));
    assert.deepEqual(states[0], states[1]);
    assert.equal(states[0].revision, 1);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    const exits = [native, desktop].map((child) => new Promise((resolve) => child.once('close', resolve)));
    native.stdin.end(); desktop.stdin.end(); native.kill(); desktop.kill();
    await Promise.all(exits);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

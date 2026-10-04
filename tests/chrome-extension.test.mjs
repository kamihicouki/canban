import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { FrameDecoder, encodeNativeResponse } from '../server/native-messaging.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Chrome build emits an MV3 toolbar extension with an external CSP-safe board', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-chrome-'));
  try {
    const build = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-chrome.mjs'), '--outdir', out], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr || build.stdout);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.permissions, ['nativeMessaging']);
    assert.equal(manifest.background.service_worker, 'service-worker.js');
    assert.equal(manifest.action.default_title, 'Canban');

    const html = fs.readFileSync(path.join(out, 'board.html'), 'utf8');
    assert.match(html, /<link[^>]+href="board\.css"/);
    assert.match(html, /<script[^>]+src="board\.js"/);
    assert.doesNotMatch(html, /<style\b/i);
    assert.doesNotMatch(html, /<script(?:\s[^>]*)?>\s*[^<]/i);
    assert.match(fs.readFileSync(path.join(out, 'board.js'), 'utf8'), /connectNative/);
    assert.match(fs.readFileSync(path.join(out, 'service-worker.js'), 'utf8'), /chrome\.tabs\.create/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('adopting shared view state refreshes the board and analytics toggle', () => {
  const html = fs.readFileSync(path.join(root, 'ui', 'board.html'), 'utf8');
  const adopt = html.match(/function adoptSharedUi\(record\) \{([\s\S]*?)\n\}\n\nasync function applySharedUi/);
  const toggle = html.match(/function syncViewButton\(\) \{[\s\S]*?\n\}/)[0];
  const analytics = { setAttribute(name, value) { this[name] = value; } };
  const boardView = { setAttribute(name, value) { this[name] = value; } };
  const state = { view: 'board' };
  const context = vm.createContext({ state, sharedUi: {}, SHARED_UI_KEYS: ['view'], workspacePage: (page,fallback) => page || fallback, workspace: { navigate() {} }, store: { cache() {} },
    $: (selector) => selector === '#analyticsBtn' ? analytics : selector === '#boardViewBtn' ? boardView : null });
  vm.runInContext(`${toggle}\nfunction adoptSharedUi(record) {${adopt[1]}\n}\nadoptSharedUi({revision: 1, state: {view: 'analytics'}});`, context);
  assert.equal(state.view, 'analytics');
  assert.equal(analytics['aria-pressed'], 'true');
  assert.equal(boardView['aria-pressed'], 'false');
});

test('Chrome bridge waits for every large-response chunk before decoding', () => {
  const html = fs.readFileSync(path.join(root, 'ui', 'board.html'), 'utf8');
  const source = html.slice(html.indexOf('  function settleNative('), html.indexOf('  function connectNative('));
  const response = { id: 7, result: { text: '🍙'.repeat(350000) } };
  const chunks = encodeNativeResponse(response).flatMap((frame) => new FrameDecoder().push(frame)).reverse();
  let result, error;
  const waiting = new Map([[7, { resolve(value) { result = value; }, reject(value) { error = value; } }]]);
  const context = vm.createContext({ waiting, nativeChunks: new Map(), clearTimeout, atob, TextDecoder, Uint8Array });
  vm.runInContext(source, context);
  for (let i = 0; i < chunks.length; i++) {
    context.message = chunks[i];
    vm.runInContext('consumeNativeMessage(message)', context);
    assert.equal(error, undefined);
    if (i < chunks.length - 1) assert.equal(result, undefined);
  }
  assert.equal(JSON.stringify(result), JSON.stringify(response.result));
});

test('repainting adopted settings does not create an unsaved local change', () => {
  const html = fs.readFileSync(path.join(root, 'ui', 'board.html'), 'utf8');
  const source = html.slice(html.indexOf('const SHARED_UI_KEYS ='), html.indexOf('const DEFAULT_FILTERS ='));
  const values = new Map();
  let saves = 0;
  const context = vm.createContext({ localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    scheduleSharedUiSave: () => saves++ });
  vm.runInContext(`${source}\nsharedUi.ready = true; store.cache('dashOpen', true); store.set('dashOpen', true);`, context);
  assert.equal(vm.runInContext('sharedUi.dirty', context), false);
  assert.equal(saves, 0);
  vm.runInContext("store.set('dashOpen', false)", context);
  assert.equal(vm.runInContext('sharedUi.dirty', context), true);
  assert.equal(saves, 1);
});

test('foreground synchronization preserves an unsent session prompt', async () => {
  const html = fs.readFileSync(path.join(root, 'ui', 'board.html'), 'utf8');
  const source = html.slice(html.indexOf('function hasUnsavedPaneInput()'), html.indexOf('function scheduleSharedUiCheck()'));
  let reads = 0;
  const context = vm.createContext({ taskDash: null, sharedUi: { ready: true }, workspace: { hasDrafts: () => false }, idle: () => true,
    document: { visibilityState: 'visible', querySelectorAll: () => [{ value: 'まだ送らない指示' }] },
    bridge: { callTool() { reads++; return Promise.resolve({ revision: 0 }); } },
    sharedUiRecord: (value) => value, applySharedUi() {}, console });
  await vm.runInContext(`${source}\ncheckSharedUiOnReturn();`, context);
  assert.equal(reads, 0);
});

test('Native Messaging installer targets only the supplied Chrome extension id', () => {
  const extensionId = 'a'.repeat(32);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'install-chrome-native-host.mjs'), '--dry-run', '--extension-id', extensionId], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const preview = JSON.parse(result.stdout);
  assert.equal(preview.action, 'install');
  assert.ok(preview.manifestPath.includes('NativeMessagingHosts'));
  assert.deepEqual(preview.manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
  assert.equal(path.isAbsolute(preview.manifest.path), true);
});

test('foreground synchronization preserves an edited card note', async () => {
  const html = fs.readFileSync(path.join(root, 'ui', 'board.html'), 'utf8');
  const source = html.slice(html.indexOf('function hasUnsavedPaneInput()'), html.indexOf('function scheduleSharedUiCheck()'));
  let reads = 0;
  const context = vm.createContext({ taskDash: null, sharedUi: { ready: true }, workspace: { hasDrafts: () => false }, idle: () => true,
    document: { visibilityState: 'visible', querySelectorAll: (selector) => selector === 'textarea.note' ? [{ value: '編集中', defaultValue: '保存済み' }] : [] },
    bridge: { callTool() { reads++; } }, console });
  await vm.runInContext(`${source}\ncheckSharedUiOnReturn();`, context);
  assert.equal(reads, 0);
});

test('startup preserves pending local settings after a revision conflict', async () => {
  const html = fs.readFileSync(path.join(root, 'ui', 'board.html'), 'utf8');
  const source = html.slice(html.indexOf('async function initializeSharedUi()'), html.indexOf('function hasUnsavedPaneInput()'));
  let adopted = false, conflict = false;
  const sharedUi = {};
  const context = vm.createContext({ sharedUi, store: { get: () => ({ revision: 4 }) },
    bridge: { callTool: async () => ({ revision: 5, state: { view: 'analytics' } }) },
    sharedUiRecord: (value) => value, adoptSharedUi: () => { adopted = true; },
    notifySharedUiConflict: () => { conflict = true; }, console });
  await vm.runInContext(`${source}\ninitializeSharedUi();`, context);
  assert.equal(adopted, false);
  assert.equal(conflict, true);
  assert.equal(sharedUi.revision, 4);
  assert.equal(sharedUi.dirty, true);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { channel } from 'node:diagnostics_channel';
import { retrySqliteBusy } from '../server/sqlite-retry.mjs';
import { runReadyProcesses } from './helpers/ready-processes.mjs';

const root = new URL('../', import.meta.url).pathname;
const prefix = 'CANBAN_SQLITE_DIAGNOSTIC ';

test('fixture diagnostics reach the real DB worker and exclude card data and paths', { timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-diagnostic-private-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const results = await runReadyProcesses({ cwd: root, diagnostics: true, signal: t.signal, inputs: [`
    import { Store } from './server/store.mjs';
    const store = new Store(${JSON.stringify(dir)}); await store.load();
    process.send('ready'); await new Promise(resolve => process.once('message', resolve));
    await store.moveCard({cardId:'codex:private-card-value',toListId:'doing',order:0});
    console.log('saved'); await store.close(); process.disconnect();
  `] });
  assert.equal(results[0].code, 0, results[0].err);
  assert.equal(results[0].out.trim(), 'saved');
  const lines = results[0].err.split('\n').filter(line => line.startsWith(prefix));
  assert.equal(lines.length, 1, 'one bounded worker report must be emitted before close');
  const report = JSON.parse(lines[0].slice(prefix.length));
  assert.equal(report.client, 0); assert.equal(report.operationCount, 1);
  assert.equal(report.operations[0].attempts, 1);
  assert.equal(report.operations[0].outcome, 'success');
  const native = report.operations[0].events.filter(event => event.phase === 'native');
  assert.ok(native.some(event => event.kind === 'begin'));
  assert.ok(native.some(event => event.kind === 'commit'));
  assert.ok(native.every(event => event.wallMs >= 0));
  assert.ok(!results[0].err.includes(dir));
  assert.ok(!results[0].err.includes('private-card-value'));
  assert.ok(!results[0].err.includes('BEGIN IMMEDIATE'));
});

test('fixture recorder bounds long retry traces and excludes private error text', async () => {
  const { createFixtureRecorder } = await import('./helpers/sqlite-fixture-diagnostics.mjs');
  const lines = [], recorder = createFixtureRecorder(0, text => lines.push(text));
  const trace = channel('canban.sqlite.fixture.retry');
  const observe = event => recorder.retry(event); trace.subscribe(observe);
  let clock = 0;
  try {
    await assert.rejects(retrySqliteBusy(() => {
      clock++; throw new Error('database is locked: private-secret-value');
    }, { now: () => clock, sleep: async () => { clock++; } }), { code: 'db_busy' });
  } finally { trace.unsubscribe(observe); }
  recorder.flush();
  const report = JSON.parse(lines[0].slice(prefix.length));
  assert.ok(report.operations[0].attempts > 64);
  assert.ok(report.operations[0].events.length <= 64);
  assert.ok(report.operations[0].droppedEvents > 0);
  assert.equal(report.operations[0].outcome, 'exhausted');
  assert.ok(!lines[0].includes('private-secret-value'));
});

test('diagnostic output failure does not replace a successful value or an original error', async () => {
  const { createFixtureRecorder } = await import('./helpers/sqlite-fixture-diagnostics.mjs');
  const recorder = createFixtureRecorder(0, () => { throw new Error('log sink unavailable'); });
  const trace = channel('canban.sqlite.fixture.retry');
  const observe = event => recorder.retry(event); trace.subscribe(observe);
  const value = {}, error = new Error('original fixture failure');
  try {
    assert.equal(await retrySqliteBusy(() => value), value);
    await assert.rejects(retrySqliteBusy(() => { throw error; }), actual => actual === error);
    assert.doesNotThrow(() => recorder.flush());
  } finally { trace.unsubscribe(observe); }
});

test('native diagnostic fields use fixed categories instead of SQL or error text', async () => {
  const { createFixtureRecorder } = await import('./helpers/sqlite-fixture-diagnostics.mjs');
  const lines = [], recorder = createFixtureRecorder(0, text => lines.push(text));
  recorder.retry({ phase: 'start', attempts: 0, elapsedMs: 0, remainingMs: 2000, secret: 'private-token' });
  recorder.native('SELECT private-user-data', 1, 0, 'private-error-message');
  recorder.retry({ phase: 'success', attempts: 1, elapsedMs: 1, remainingMs: 1999 });
  recorder.flush();
  assert.ok(!lines[0].includes('private-user-data'));
  assert.ok(!lines[0].includes('private-error-message'));
  assert.ok(!lines[0].includes('private-token'));
});

test('real blocked writes report native waits, timer wakeups, attempts and remaining budget', { timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-diagnostic-blocked-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const results = await runReadyProcesses({ cwd: root, diagnostics: true, signal: t.signal, inputs: [`
    import { Store } from './server/store.mjs';
    import { DatabaseSync } from 'node:sqlite';
    const store = new Store(${JSON.stringify(dir)}); await store.load();
    const blocker = new DatabaseSync(${JSON.stringify(path.join(dir, 'canban.sqlite'))});
    process.send('ready'); await new Promise(resolve => process.once('message', resolve));
    blocker.exec('BEGIN IMMEDIATE');
    try { await store.moveCard({cardId:'codex:blocked',toListId:'doing',order:0}); }
    catch(error) { console.log(JSON.stringify({code:error.code,busyElapsedMs:error.busyElapsedMs})); }
    finally { blocker.exec('ROLLBACK'); blocker.close(); }
    await store.close(); process.disconnect();
  `] });
  assert.equal(results[0].code, 0, results[0].err);
  assert.equal(JSON.parse(results[0].out).code, 'db_busy');
  const line = results[0].err.split('\n').find(line => line.startsWith(prefix));
  const operation = JSON.parse(line.slice(prefix.length)).operations[0];
  assert.equal(operation.outcome, 'exhausted');
  assert.ok(operation.attempts >= 1); assert.ok(operation.remainingMs <= 500);
  assert.equal(operation.events.filter(event => event.phase === 'attempt').length, operation.attempts);
  assert.ok(operation.events.some(event => event.phase === 'native' && event.kind === 'begin' && event.outcome === 'busy' && event.wallMs > 0));
  assert.ok(operation.events.some(event => event.phase === 'wake' && event.requestedMs >= 15 && event.waitMs >= 0));
});

test('diagnostic preload preserves requests queued before the worker installs its handler', { timeout: 10000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-diagnostic-startup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workerModule = new URL('../server/sqlite-worker.mjs', import.meta.url).href;
  const results = await runReadyProcesses({ cwd: root, diagnostics: true, signal: t.signal, inputs: [`
    import { Worker } from 'node:worker_threads';
    const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(
      'await new Promise(resolve => setTimeout(resolve, 50)); await import(' + ${JSON.stringify(JSON.stringify(workerModule))} + ');'
    )), { workerData: { dir: ${JSON.stringify(dir)} }, execArgv: ['--no-warnings'] });
    const response = new Promise((resolve, reject) => { worker.once('message',resolve); worker.once('error',reject); });
    worker.postMessage({id:1,target:'board',method:'load',args:[]});
    const result = await response; if (result.id !== 1 || result.error) throw new Error('queued startup request was not preserved');
    process.send('ready'); await new Promise(resolve => process.once('message', resolve));
    await worker.terminate(); console.log('startup request preserved'); process.disconnect();
  `] });
  assert.equal(results[0].code, 0, results[0].err);
  assert.equal(results[0].out.trim(), 'startup request preserved');
});

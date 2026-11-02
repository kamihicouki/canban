import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.mjs';
import { runReadyProcesses } from './helpers/ready-processes.mjs';

function fixture({ failure, exitReady, neverReady = false, deferAbortClose = false, holdClose = false, writeFailure, omitWritten } = {}) {
  const children = [];
  let initializing = 0, ready = 0;
  function spawnImpl(command, args, options) {
    const index = children.length, child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.exitCode = null; child.killed = false;
    const close = code => {
      if (child.exitCode !== null) return;
      child.exitCode = code; child.emit('close', code);
    };
    child.finish = close;
    child.kill = () => { child.killed = true; queueMicrotask(() => close(null)); };
    child.send = message => {
      if (message === 'close') {
        assert.ok(children.every(child => child.written), 'every writer must finish before any close');
        child.closedAfterWriting = true; queueMicrotask(() => close(0)); return;
      }
      assert.equal(message, 'start'); assert.equal(ready, 10, 'all connections must be ready before any write');
      child.started = true; queueMicrotask(() => {
        if (!holdClose) { close(0); return; }
        if (index === writeFailure) { child.stderr.emit('data', 'original writer failure'); close(1); return; }
        if (index !== omitWritten) { child.written = true; child.emit('message', 'written'); }
      });
    };
    child.stdin = { end() {
      initializing++;
      assert.equal(initializing, 1, 'startup must not contend with another startup');
      queueMicrotask(() => {
        initializing--;
        if (index === failure) { child.stderr.emit('data', 'original initialization failure'); close(1); return; }
        if (exitReady && index === 1) {
          children[0].stderr.emit('data', 'ready client stopped'); children[0].exitCode = 1;
          children[0].emit('close', 1); return;
        }
        if (!neverReady) { ready++; child.emit('message', 'ready'); }
      });
    } };
    options.signal?.addEventListener('abort', () => {
      child.emit('error', options.signal.reason); if (!deferAbortClose) close(1);
    }, { once: true });
    children.push(child); return child;
  }
  return { children, spawnImpl };
}

test('connections initialize without contention and all ten writers start together', async () => {
  const f = fixture();
  const results = await runReadyProcesses({ inputs: Array(10).fill('fixture'), spawnImpl: f.spawnImpl });
  assert.equal(results.length, 10); assert.ok(results.every(r => r.code === 0));
  assert.ok(f.children.every(child => child.started));
});

test('initialization failure keeps its cause and stops the waiting sibling', async () => {
  const f = fixture({ failure: 1 });
  await assert.rejects(runReadyProcesses({ inputs: Array(10).fill('fixture'), spawnImpl: f.spawnImpl }), /original initialization failure/);
  assert.equal(f.children.length, 2); assert.ok(f.children[0].killed);
  assert.ok(f.children.every(child => !child.started));
});

test('a ready client exiting during setup stops every remaining client', async () => {
  const f = fixture({ exitReady: true });
  await assert.rejects(runReadyProcesses({ inputs: Array(10).fill('fixture'), spawnImpl: f.spawnImpl }), /ready client stopped/);
  assert.ok(f.children[1].killed); assert.ok(f.children.every(child => !child.started));
});

test('cancelling an unfinished setup stops its child', async () => {
  const f = fixture({ neverReady: true }), controller = new AbortController();
  const error = new Error('fixture cancelled');
  const result = runReadyProcesses({ inputs: ['fixture'], signal: controller.signal, spawnImpl: f.spawnImpl });
  controller.abort(error);
  await assert.rejects(result, actual => actual === error);
  assert.equal(f.children[0].exitCode, 1); assert.ok(!f.children[0].started);
});

test('a real child startup error is reported without a sibling readiness timeout', { timeout: 60000 }, async t => {
  const start = performance.now();
  await assert.rejects(runReadyProcesses({ cwd: new URL('../', import.meta.url).pathname, signal: t.signal, inputs: [
    "process.send('ready'); await new Promise(resolve => process.once('message', resolve)); process.disconnect();",
    "throw new Error('fixture-startup-failure');",
  ] }), /fixture-startup-failure/);
  t.diagnostic(`original startup cause returned in ${performance.now() - start}ms; waiting sibling cleaned up`);
});

test('cancellation waits for child close before completing cleanup', async () => {
  const f = fixture({ neverReady: true, deferAbortClose: true }), controller = new AbortController();
  const error = new Error('fixture cancelled');
  const result = runReadyProcesses({ inputs: ['fixture'], signal: controller.signal, spawnImpl: f.spawnImpl });
  f.children[0].kill = () => { f.children[0].killed = true; };
  let settled = false;
  const observed = result.then(() => { settled = true; }, actual => { settled = true; return actual; });
  controller.abort(error);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'cleanup must wait for process close, not just its error');
  f.children[0].finish(1);
  assert.equal(await observed, error); assert.ok(f.children[0].killed);
});

test('cleanup is released only after every writer has finished', async () => {
  const f = fixture({ holdClose: true }), controller = new AbortController();
  const result = runReadyProcesses({ inputs: Array(10).fill('fixture'), spawnImpl: f.spawnImpl, signal: controller.signal, finishTogether: true });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.children.every(child => child.closedAfterWriting), 'the parent must release cleanup after all written signals');
    const results = await result; assert.ok(results.every(value => value.code === 0));
  } finally { controller.abort(new Error('test cleanup')); await result.catch(() => {}); }
});

test('a writer failure keeps its cause and closes peers waiting for cleanup', async () => {
  const f = fixture({ holdClose: true, writeFailure: 1 }), controller = new AbortController();
  const result = runReadyProcesses({ inputs: Array(10).fill('fixture'), spawnImpl: f.spawnImpl, signal: controller.signal, finishTogether: true });
  let error;
  const observed = result.catch(value => { error = value; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.match(error?.message || '', /original writer failure/);
    await observed; assert.ok(f.children.filter((_, i) => i !== 1).every(child => child.killed));
  } finally { controller.abort(new Error('test cleanup')); await observed; }
});

test('abort during the writer completion wait closes every child', async () => {
  const f = fixture({ holdClose: true, omitWritten: 9 }), controller = new AbortController();
  const error = new Error('abort while writers finish');
  const result = runReadyProcesses({ inputs: Array(10).fill('fixture'), spawnImpl: f.spawnImpl, signal: controller.signal, finishTogether: true });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(error);
  await assert.rejects(result, actual => actual === error);
  assert.ok(f.children.every(child => child.exitCode !== null));
  assert.ok(f.children.every(child => !child.closedAfterWriting));
});

test('a finished writer waits for a peer lock to end before DB close', { timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-finish-'));
  const store = new Store(dir); await store.load();
  t.after(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const written = path.join(dir, 'first-written');
  const inputs = [0, 1].map(client => `
    import {Store} from './server/store.mjs';
    import {DatabaseSync} from 'node:sqlite';
    import fs from 'node:fs';
    const store=new Store(${JSON.stringify(dir)});await store.load();
    const started=new Promise(resolve=>process.once('message',resolve));process.send('ready');await started;
    await store.moveCard({cardId:'codex:finish:${client}',toListId:'doing',order:${client}});
    if(${client}===0)fs.writeFileSync(${JSON.stringify(written)},'written');
    else{
      while(!fs.existsSync(${JSON.stringify(written)}))await new Promise(resolve=>setTimeout(resolve,5));
      const lock=new DatabaseSync(${JSON.stringify(path.join(dir, 'canban.sqlite'))});lock.exec('BEGIN IMMEDIATE');
      await new Promise(resolve=>setTimeout(resolve,2200));lock.exec('ROLLBACK');lock.close();
    }
    console.log(JSON.stringify({accepted:1}));
    const closing=new Promise(resolve=>process.once('message',resolve));process.send('written');await closing;
    try{await store.close();}finally{process.disconnect();}
  `);
  const results = await runReadyProcesses({ cwd: new URL('../', import.meta.url).pathname, inputs, signal: t.signal, finishTogether: true });
  assert.ok(results.every(result => result.code === 0), JSON.stringify(results));
  assert.ok(results.every(result => JSON.parse(result.out).accepted === 1));
  const cards = (await store.load()).cards; assert.equal(Object.keys(cards).length, 2);
  for (let client = 0; client < 2; client++) { assert.equal(cards['codex:finish:' + client].listId, 'doing'); assert.equal(cards['codex:finish:' + client].order, client); }
  const inspector = new DatabaseSync(path.join(dir, 'canban.sqlite'));
  try { assert.equal(inspector.prepare('SELECT COUNT(*) AS n FROM instances').get().n, 1, 'only the parent instance remains'); }
  finally { inspector.close(); }
});

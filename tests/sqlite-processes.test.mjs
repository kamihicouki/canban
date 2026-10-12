import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runReadyProcesses } from './helpers/ready-processes.mjs';

function fixture({ failure, exitReady, neverReady = false } = {}) {
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
    child.kill = () => { child.killed = true; queueMicrotask(() => close(null)); };
    child.send = message => {
      assert.equal(message, 'start'); assert.equal(ready, 10, 'all connections must be ready before any write');
      child.started = true; queueMicrotask(() => close(0));
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
      child.emit('error', options.signal.reason); close(1);
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

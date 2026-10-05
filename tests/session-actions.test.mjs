import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { codexLifecycle, sessionActions } from '../server/session-actions.mjs';

const session = { id: 'codex:sample', agent: 'codex', nativeId: 'sample', homeDir: '/isolated/codex', status: 'idle' };
function server({ error = false, silent = false, message = 'native failure' } = {}) {
  const requests = []; let options;
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new PassThrough(); child.kill = () => {};
  child.stdin.on('data', chunk => {
    const message = JSON.parse(chunk.toString()); requests.push(message);
    if (message.id && !silent) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, ...(error && message.method !== 'initialize' ? { error: { message: failureMessage } } : { result: {} }) }) + '\n'));
  });
  const failureMessage = message;
  return { requests, get options() { return options; }, spawnChild: (bin, args, opts) => { options = { bin, args, ...opts }; return child; } };
}
test('lifecycle uses vendor RPC and binds the selected home', async () => {
  for (const [action, method] of [['archive', 'thread/archive'], ['restore', 'thread/unarchive'], ['delete', 'thread/delete']]) {
    const rpc = server();
    assert.equal((await codexLifecycle(session, action, { bin: '/codex', spawnChild: rpc.spawnChild })).action, action);
    assert.equal(rpc.options.env.CODEX_HOME, '/isolated/codex');
    assert.deepEqual(rpc.options.args, ['app-server', '--listen', 'stdio://']);
    assert.deepEqual(rpc.requests.map(r => r.method), ['initialize', 'initialized', method]);
    assert.deepEqual(rpc.requests.at(-1).params, { threadId: 'sample' });
  }
});
test('vendor errors and timeouts are failures', async () => {
  for (const opts of [{ error: true }, { silent: true }]) {
    const rpc = server(opts);
    await assert.rejects(codexLifecycle(session, 'archive', { bin: '/codex', spawnChild: rpc.spawnChild, timeoutMs: 20 }), /native failure|タイムアウト/);
  }
});
test('unsupported agents, remote hosts and active sessions cannot change local card state', async () => {
  for (const s of [{ ...session, agent: 'claude' }, { ...session, host: { local: false } }, { ...session, status: 'running' }, { ...session, status: 'waiting' }]) {
    assert.equal(sessionActions(s).available, false);
    await assert.rejects(codexLifecycle(s, 'delete', { bin: '/codex', spawnChild: () => { throw Error('must not spawn'); } }), /Claude|リモート|実行中/);
  }
});
test('desktop archive and restore go through the owner without a competing server', async () => {
  const calls = [];
  for (const action of ['archive', 'restore']) {
    await codexLifecycle(session, action, { desktopArchive: async archived => calls.push(archived), spawnChild: () => { throw Error('must not spawn'); } });
  }
  assert.deepEqual(calls, [true, false]);
});
test('delete releases a retained writer through the desktop before retrying', async () => {
  const locked = server({ error: true, message: 'thread sample already has an active writer' }), unlocked = server();
  const sequence = [];
  const spawnChild = (...args) => { sequence.push('delete'); return (sequence.length === 1 ? locked : unlocked).spawnChild(...args); };
  await codexLifecycle(session, 'delete', { bin: '/codex', spawnChild, desktopArchive: async archived => sequence.push(archived) });
  assert.deepEqual(sequence, ['delete', true, 'delete']);
});
test('failed delete restores an originally unarchived session and preserves a pre-existing archive', async () => {
  for (const archived of [true, false]) {
    const calls = [], locked = server({ error: true, message: 'already has an active writer' }), failed = server({ error: true });
    let n = 0;
    await assert.rejects(codexLifecycle({ ...session, archived }, 'delete', { bin: '/codex', spawnChild: (...args) => (++n === 1 ? locked : failed).spawnChild(...args), desktopArchive: async value => calls.push(value) }), /native failure/);
    assert.deepEqual(calls, archived ? [true] : [true, false]);
  }
});

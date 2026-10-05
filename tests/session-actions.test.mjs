import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { codexLifecycle, sessionActions } from '../server/session-actions.mjs';

const session = { id: 'codex:sample', agent: 'codex', nativeId: 'sample', homeDir: '/isolated/codex', status: 'idle' };
function server({ error = false, silent = false } = {}) {
  const requests = []; let options;
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new PassThrough(); child.kill = () => {};
  child.stdin.on('data', chunk => {
    const message = JSON.parse(chunk.toString()); requests.push(message);
    if (message.id && !silent) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, ...(error && message.method !== 'initialize' ? { error: { message: 'native failure' } } : { result: {} }) }) + '\n'));
  });
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

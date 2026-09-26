// Remote collection: collect.py must produce the same sessions as the JS readers,
// stay read-only, and the pool must degrade gracefully on bad hosts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixtures } from './helpers.mjs';
import { RemotePool } from '../server/remote/pool.mjs';
import { listCodexSessions, codexSessionMessages } from '../server/sources/codex.mjs';
import { listClaudeSessions, claudeSessionMessages } from '../server/sources/claude.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = makeFixtures();
const before = fx.snapshot();
fx.lock();
after(() => fx.cleanup());

const host = { id: 'remote-ssh-discovered:fx', alias: 'fx', label: 'fx', local: false, sshArgs: [] };
const newPool = (opts = {}) =>
  new RemotePool({ ssh: path.join(here, 'fake-ssh.sh'), extraArgs: { codexHome: fx.codexHome, claudeHome: fx.claudeHome, desktopDir: fx.desktopDir }, ...opts });

const comparable = ({ id, host: _h, rawStatus, statusMtimeMs, ...rest }) => rest;
const byNative = (a, b) => (a.agent + a.nativeId < b.agent + b.nativeId ? -1 : 1);

test('collect.py matches the local readers (parity)', async () => {
  const pool = newPool();
  const remote = (await pool.sessions([host])).sort(byNative);
  const local = [
    ...(await listCodexSessions({ home: fx.codexHome })).sessions,
    ...(await listClaudeSessions({ home: fx.claudeHome, desktopDir: fx.desktopDir })).sessions,
  ].sort(byNative);
  assert.equal(pool.hostStatus(host.id).state, 'ok');
  assert.equal(remote.length, local.length);
  for (let i = 0; i < local.length; i++) {
    assert.deepEqual(comparable(remote[i]), comparable(local[i]), `${local[i].id} differs`);
    assert.equal(remote[i].id, local[i].id.replace(':', '@fx:'));
    assert.equal(remote[i].host.id, host.id);
  }
});

test('remote messages match local extraction; paths outside agent homes are refused', async () => {
  const pool = newPool();
  const sessions = await pool.sessions([host]);
  const t1 = sessions.find((s) => s.nativeId === 't1');
  assert.deepEqual(await pool.messages(host, t1), await codexSessionMessages(fx.rollout));
  const c1 = sessions.find((s) => s.nativeId === 'c1');
  assert.deepEqual(await pool.messages(host, c1), await claudeSessionMessages(c1.sourcePath));
  await assert.rejects(pool.messages(host, { ...t1, sourcePath: '/etc/hosts' }), /許可されていないパス/);
});

test('unchanged Claude transcripts are not re-sent', async () => {
  const pool = newPool({ ttlMs: 0 });
  const first = await pool.sessions([host]);
  let listed;
  const run = pool.run.bind(pool);
  pool.run = async (h, args) => {
    const res = await run(h, args);
    listed = res;
    return res;
  };
  const second = await pool.sessions([host], { force: true });
  assert.equal(listed.claude.summaries.length, 0);
  assert.equal(listed.claude.unchanged.length, 2);
  assert.deepEqual(second.map((s) => s.id).sort(), first.map((s) => s.id).sort());
});

test('unreachable and slow hosts report an error without throwing', async () => {
  const pool = newPool({ timeoutMs: 800 });
  const down = { ...host, id: 'h-down', alias: 'down-host' };
  const slow = { ...host, id: 'h-slow', alias: 'slow-host' };
  const sessions = await pool.sessions([down, slow]);
  assert.deepEqual(sessions, []);
  assert.match(pool.hostStatus('h-down').error, /Connection refused/);
  assert.match(pool.hostStatus('h-slow').error, /タイムアウト/);
});

test('fixtures stay byte-for-byte unchanged', () => {
  assert.deepEqual(fx.snapshot(), before);
});

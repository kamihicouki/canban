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

// `account` is resolved on this machine only (accounts.mjs).
const comparable = ({ id, host: _h, rawStatus, statusMtimeMs, account, ...rest }) => rest;
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

test('dispatch.py: inspect reads only agent logs; start / poll / stop run the CLI detached', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const { parseRunLog } = await import('../server/dispatch.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-rdispatch-'));
  const agentLog = path.join(tmp, 'agent.jsonl');
  const pool = newPool();
  pool.dispatchArgs = { runsDir: path.join(tmp, 'runs'), bin: path.join(here, 'fake-codex.sh') };
  const env = { FAKE_AGENT_LOG: process.env.FAKE_AGENT_LOG, CLAUDECODE: process.env.CLAUDECODE };
  process.env.FAKE_AGENT_LOG = agentLog;
  process.env.CLAUDECODE = '1';
  try {
    const insp = await pool.dispatch(host, { mode: 'inspect', path: fx.rollout });
    assert.ok(insp.records.length > 0 && insp.mtimeMs > 0);
    await assert.rejects(pool.dispatch(host, { mode: 'inspect', path: '/etc/hosts' }), /outside/);
    await assert.rejects(pool.dispatch(host, { mode: 'start', id: '../../x', binName: 'codex', args: [], cwd: tmp, prompt: 'x' }), /bad request id/);
    await assert.rejects(pool.dispatch(host, { mode: 'start', id: 'req-a-00', binName: 'sh', args: [], cwd: tmp, prompt: 'x' }), /unknown agent/);

    const id = 'req-abc-0123abcd';
    const started = await pool.dispatch(host, { mode: 'start', id, binName: 'codex', args: ['exec', 'resume', 'nid-1', '-'], cwd: tmp, prompt: 'リモートへ "送る"' });
    assert.ok(started.pid > 0);
    let st;
    for (let i = 0; i < 100; i++) {
      st = (await pool.dispatch(host, { mode: 'poll', runs: [{ id, pid: started.pid }] })).runs[id];
      if (!st.alive) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(st.alive, false);
    assert.equal(parseRunLog('codex', st.log).ok, true);
    const [run] = fs.readFileSync(agentLog, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(run.prompt, 'リモートへ "送る"');
    assert.equal(run.claudecode, null, 'agent env is scrubbed on the remote side too');

    process.env.FAKE_AGENT_SLEEP = '5';
    const long = await pool.dispatch(host, { mode: 'start', id: 'req-abc-0000ffff', binName: 'codex', args: ['exec', 'resume', 'nid-2', '-'], cwd: tmp, prompt: 'long' });
    delete process.env.FAKE_AGENT_SLEEP;
    await new Promise((r) => setTimeout(r, 200));
    await assert.rejects(pool.dispatch(host, { mode: 'stop', pid: long.pid, needle: 'nid-other' }), /Canban が起動したものではありません/);
    assert.equal((await pool.dispatch(host, { mode: 'stop', pid: long.pid, needle: 'nid-2' })).stopped, true);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await pool.dispatch(host, { mode: 'poll', runs: [{ id: 'req-abc-0000ffff', pid: long.pid }] })).runs['req-abc-0000ffff'].alive, false);
  } finally {
    for (const [k, v] of Object.entries(env)) (v == null ? delete process.env[k] : (process.env[k] = v));
    delete process.env.FAKE_AGENT_SLEEP;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fixtures stay byte-for-byte unchanged', () => {
  assert.deepEqual(fx.snapshot(), before);
});

// Remote collection: collect.py must produce the same sessions as the JS readers,
// stay read-only, and the pool must degrade gracefully on bad hosts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
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

test('remote Claude resume preserves the latest main worktree and branch like the local reader', async () => {
  const moved = makeFixtures();
  try {
    const file = path.join(moved.claudeHome, 'projects', '-r-web', 'c2.jsonl');
    fs.appendFileSync(file, [
      { type: 'assistant', cwd: '/r/web/prototypes/card-ux', gitBranch: 'main' },
      { type: 'assistant', cwd: '/r/web/.claude/worktrees/card-ux', gitBranch: 'worktree-card-ux' },
      { type: 'assistant', isSidechain: true, cwd: '/other-agent', gitBranch: 'other-agent' },
      { type: 'assistant', cwd: '  ', gitBranch: {} },
      { type: 'assistant', cwd: 42 },
    ].map(o => JSON.stringify(o) + '\n').join(''));
    const original = moved.snapshot();
    moved.lock();
    const pool = newPool({ extraArgs: { codexHome: moved.codexHome, claudeHome: moved.claudeHome, desktopDir: moved.desktopDir } });
    const remote = (await pool.sessions([host])).find(s => s.nativeId === 'c2');
    const local = (await listClaudeSessions({ home: moved.claudeHome, desktopDir: moved.desktopDir })).sessions.find(s => s.nativeId === 'c2');
    assert.equal(remote.cwd, '/r/web/.claude/worktrees/card-ux');
    assert.equal(remote.branch, 'worktree-card-ux');
    assert.deepEqual(comparable(remote), comparable(local));
    assert.deepEqual(moved.snapshot(), original);
  } finally { moved.cleanup(); }
});

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

test('remote Codex side chats attach to a parent and expose only bounded, side-only messages', async () => {
  const attached = makeFixtures();
  try {
    const timestamp = '2026-09-20T00:00:01Z';
    const meta = (id, attached_thread) => ({ type: 'session_meta', payload: { id, attached_thread } });
    const message = (role, text, phase) => ({ timestamp, type: 'response_item', payload: {
      type: 'message', role, phase, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
    } });
    const boundary = message('user', 'Side conversation boundary.\n\nEverything before this boundary is inherited history from the parent thread.');
    const jsonl = records => records.map(o => JSON.stringify(o) + '\n').join('');
    const packed = spawnSync('python3', ['-c', `import sys
try:
    from compression import zstd
except ImportError:
    sys.exit(77)
sys.stdout.buffer.write(zstd.compress(sys.stdin.buffer.read()))`], {
      input: jsonl([meta('packed', true), boundary, message('assistant', '保管済み', 'final')]),
    });
    assert.ok(packed.status === 0 || packed.status === 77, packed.stderr?.toString());
    const db = new DatabaseSync(path.join(attached.codexHome, 'state_5.sqlite'));
    try {
      db.exec("ALTER TABLE threads ADD COLUMN attached_thread_parent_id TEXT; CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT); INSERT INTO thread_spawn_edges VALUES ('t1', 'side');");
      const insert = db.prepare('INSERT INTO threads (id, title, rollout_path, attached_thread_parent_id) VALUES (?, ?, ?, ?)');
      const write = (id, parent, records) => {
        const file = path.join(attached.codexHome, 'sessions', `${id}.jsonl`);
        fs.writeFileSync(file, jsonl(records));
        insert.run(id, id, file, parent);
      };
      const followup = message('user', '  追記\n');
      followup.payload.content.unshift({ type: 'input_text', text: '<environment_context>secret</environment_context>' });
      write('side', 't1', [
        meta('side', true), message('user', 'inherited'), boundary, message('assistant', 'inherited side chat'), boundary,
        ...Array.from({ length: 39 }, (_, i) => message('user', `質問 ${i}`)),
        message('user', '<environment_context>secret</environment_context>'),
        message('user', '<realtime_delegation>secret</realtime_delegation>'),
        message('user', '<heartbeat>secret</heartbeat>'),
        message('assistant', 'draft', 'commentary'),
        { type: 'response_item', payload: { type: 'function_call_output', output: 'hidden' } },
        { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage' } } },
        followup, message('assistant', '𠮷'.repeat(8010), 'final_answer'),
      ]);
      write('missing-boundary', 't1', [meta('missing-boundary', true), message('user', 'inherited')]);
      write('missing-meta', 't1', [meta('missing-meta', false), boundary, message('user', 'inherited')]);
      write('orphan', 'absent', [meta('orphan', true), boundary]);
      const archived = path.join(attached.codexHome, 'archived_sessions');
      fs.mkdirSync(archived);
      const packedPath = path.join(archived, 'packed.jsonl');
      fs.writeFileSync(packedPath + '.zst', packed.stdout);
      insert.run('packed', 'packed', packedPath, 't1');
    } finally { db.close(); }
    const before = attached.snapshot();
    attached.lock();
    const pool = newPool({ extraArgs: { codexHome: attached.codexHome, claudeHome: attached.claudeHome, desktopDir: attached.desktopDir } });
    const sessions = await pool.sessions([host]);
    assert.deepEqual(sessions.filter(s => s.agent === 'codex').map(s => s.nativeId).sort(), ['t1', 't2', 't3']);
    const parent = sessions.find(s => s.nativeId === 't1');
    assert.deepEqual(parent.children ?? [], []);
    const side = parent.sideChats.find(s => s.nativeId === 'side');
    assert.equal(side.id, 'codex@fx:side');
    const { messages, truncated } = await pool.sideChatMessages(host, side);
    assert.equal(truncated, true);
    assert.deepEqual(messages.slice(0, -1), [
      ...Array.from({ length: 38 }, (_, i) => ({ role: 'user', text: `質問 ${i + 1}`, at: timestamp })),
      { role: 'user', text: '  追記\n', at: timestamp },
    ]);
    assert.equal(messages.at(-1).role, 'assistant');
    assert.equal(messages.at(-1).at, timestamp);
    assert.equal([...messages.at(-1).text].length, 8000);
    assert.match(messages.at(-1).text, /^𠮷{7999}…$/u);
    for (const id of ['missing-boundary', 'missing-meta']) {
      await assert.rejects(pool.sideChatMessages(host, parent.sideChats.find(s => s.nativeId === id)), /サイドチャット.*確認できません/);
    }
    await assert.rejects(pool.sideChatMessages(host, { ...side, nativeId: 'other' }), /サイドチャット.*確認できません/);
    const claudePath = sessions.find(s => s.agent === 'claude').sourcePath;
    await assert.rejects(pool.sideChatMessages(host, { ...side, sourcePath: claudePath }), /許可されていないパス/);
    const packedSide = parent.sideChats.find(s => s.nativeId === 'packed');
    if (packed.status === 0) {
      assert.deepEqual(await pool.sideChatMessages(host, packedSide), {
        messages: [{ role: 'assistant', text: '保管済み', at: timestamp }],
        truncated: false,
      });
    } else {
      await assert.rejects(pool.sideChatMessages(host, packedSide), /Python 3\.14 以降/);
    }
    assert.deepEqual(attached.snapshot(), before);
  } finally { attached.cleanup(); }
});

test('remote Codex search skips attached rollouts before applying the result limit', async () => {
  const listed = makeFixtures();
  try {
    const dir = path.join(listed.codexHome, 'sessions');
    const nested = path.join(dir, 'deeper');
    fs.mkdirSync(nested);
    const side = path.join(dir, 'side.jsonl');
    const ordinary = path.join(nested, 'ordinary.jsonl');
    for (const file of [side, ordinary]) {
      fs.writeFileSync(file, '{"type":"event_msg","payload":{"type":"task_started","text":"unique search term"}}\n');
    }
    const pool = newPool({ extraArgs: { codexHome: listed.codexHome, claudeHome: listed.claudeHome, desktopDir: listed.desktopDir } });
    const args = { mode: 'search', q: 'unique search term', limit: 1 };
    // Without the attachment column, preserve the previous search behavior.
    assert.deepEqual((await pool.run(host, args)).codex, [side]);
    const db = new DatabaseSync(path.join(listed.codexHome, 'state_5.sqlite'));
    try {
      db.exec('ALTER TABLE threads ADD COLUMN attached_thread_parent_id TEXT');
      const insert = db.prepare('INSERT INTO threads (id, rollout_path, attached_thread_parent_id, updated_at_ms) VALUES (?, ?, ?, ?)');
      insert.run('side', side, 't1', Date.now());
      insert.run('ordinary', ordinary, null, Date.now());
    } finally { db.close(); }
    listed.lock();
    assert.deepEqual(await pool.run(host, args), { ok: true, codex: [ordinary], claude: [] });
    const { codex: { rows } } = await pool.run(host, { mode: 'list' });
    assert.equal(rows.find(row => row.id === 'ordinary').rawStatus, 'running');
    assert.equal(rows.find(row => row.id === 'side').rawStatus ?? null, null);
  } finally { listed.cleanup(); }
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

test('a cold host that is slower than waitMs does not hold the listing; it reports late instead', async () => {
  const pool = newPool();
  let late = 0;
  pool.onLate = () => { late++; };
  pool.refresh = (h) => new Promise((resolve) => setTimeout(() => {
    pool.cache.set(h.id, { sessions: [{ id: 'x' }], summaries: new Map(), fetchedAt: Date.now(), errors: [] });
    resolve();
  }, 150));
  const t = Date.now();
  assert.deepEqual(await pool.sessions([host], { waitMs: 20 }), []);
  assert.ok(Date.now() - t < 120);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(late, 1);
  assert.deepEqual((await pool.sessions([host], { waitMs: 20 })).map((s) => s.id), ['x']);
});

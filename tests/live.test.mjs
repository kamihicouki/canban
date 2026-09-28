// Realtime: feed parsing, incremental reads, the watcher hub and canban_watch end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claudeItems, codexItems, foldResults, activityOf, readLines, readFeed, readFeedDelta } from '../server/feed.mjs';
import { LiveHub } from '../server/live.mjs';
import { makeFixtures } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const line = (o) => `${JSON.stringify(o)}\n`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'canban-live-'));

const claudeRecs = [
  { type: 'user', timestamp: 't0', message: { content: 'テストを直して' } },
  { type: 'assistant', timestamp: 't1', message: { content: [{ type: 'thinking', thinking: '原因を考える' }, { type: 'text', text: '見てみます' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test', description: 'テスト実行' } }] } },
  { type: 'user', timestamp: 't2', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '1 failing', is_error: true }] } },
  { type: 'assistant', timestamp: 't3', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Edit', input: { file_path: '/r/app/src/login.ts' } }] } },
  { type: 'assistant', isSidechain: true, timestamp: 't3', message: { content: [{ type: 'text', text: 'サブエージェント' }] } },
];

test('claude records become messages, tool calls with results, and turn ends', () => {
  const items = foldResults(claudeItems(claudeRecs));
  assert.deepEqual(items.map((i) => i.k), ['user', 'thinking', 'assistant', 'tool', 'tool']);
  const [bash, edit] = items.filter((i) => i.k === 'tool');
  assert.equal(bash.name, 'Bash');
  assert.match(bash.summary, /npm test/);
  assert.equal(bash.state, 'error');
  assert.equal(bash.out, '1 failing');
  assert.deepEqual([edit.summary, edit.state], ['login.ts', 'running']);
  assert.equal(activityOf(items), 'Edit: login.ts');
  const done = claudeItems([{ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '直しました' }] } }]);
  assert.deepEqual(done.map((i) => i.k), ['assistant', 'turn']);
  assert.equal(activityOf(done), null);
});

test('codex records: item_completed messages, shell / patch calls and their outputs', () => {
  const recs = [
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'event_msg', payload: { type: 'user_message', message: '重複しないはず' } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'ビルドを直して' }] } } },
    { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: '計画' }] } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', phase: 'commentary', content: [{ type: 'Text', text: '調べます' }] } } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm run build'] }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'ok', metadata: { exit_code: 0 } }) } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** End Patch' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'Exit code: 1\nfailed' } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', phase: 'final', content: [{ type: 'Text', text: '直しました' }] } } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ];
  const ctx = {};
  const items = foldResults(codexItems(recs, ctx));
  assert.equal(ctx.items, true);
  assert.deepEqual(items.map((i) => i.k), ['user', 'thinking', 'commentary', 'tool', 'tool', 'assistant', 'turn']);
  const [sh, patch] = items.filter((i) => i.k === 'tool');
  assert.deepEqual([sh.name, sh.summary, sh.state, sh.out], ['Shell', 'npm run build', 'ok', 'ok']);
  assert.deepEqual([patch.name, patch.summary, patch.state], ['Edit', 'a.ts', 'error']);
  // Older rollouts without item_completed fall back to user_message / agent_message.
  const old = codexItems([{ type: 'event_msg', payload: { type: 'user_message', message: 'やって' } }, { type: 'event_msg', payload: { type: 'agent_message', message: 'はい' } }], {});
  assert.deepEqual(old.map((i) => i.k), ['user', 'assistant']);
});

test('readLines continues from an offset and leaves a partial line for later', async () => {
  const dir = tmp();
  const f = path.join(dir, 's.jsonl');
  fs.writeFileSync(f, claudeRecs.slice(0, 2).map(line).join(''));
  const session = { agent: 'claude', sourcePath: f };
  const first = await readFeed(session);
  assert.equal(first.items.length, 4);
  assert.equal(first.offset, fs.statSync(f).size);
  const partial = line(claudeRecs[2]);
  fs.appendFileSync(f, partial.slice(0, 10));
  let d = await readFeedDelta(session, first.offset);
  assert.deepEqual([d.items.length, d.offset], [0, first.offset]);
  assert.equal(d.size, first.offset + 10);
  fs.appendFileSync(f, partial.slice(10) + line(claudeRecs[3]));
  d = await readFeedDelta(session, d.offset);
  assert.deepEqual(d.items.map((i) => i.k), ['result', 'tool']);
  assert.equal(d.offset, fs.statSync(f).size);
  // Truncated / rewritten: start over from the tail.
  fs.writeFileSync(f, line(claudeRecs[0]));
  d = await readFeedDelta(session, 99999);
  assert.equal(d.reset, true);
  assert.deepEqual(d.items.map((i) => i.k), ['user']);
  const tail = await readLines(f, { tailBytes: 5 });
  assert.equal(tail.records.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('LiveHub wakes a waiting call on a write, and watches nothing once idle', async () => {
  const dir = tmp();
  const projects = path.join(dir, 'claude', 'projects', '-r');
  fs.mkdirSync(projects, { recursive: true });
  const data = path.join(dir, 'data');
  const hub = new LiveHub({ dataDir: data, claudeProjects: path.dirname(projects), idleMs: 300 });
  const base = (await hub.wait(0, { timeoutMs: 0 })).seq;
  assert.equal(hub.active, true);
  const waiting = hub.wait(base, { timeoutMs: 5000 });
  setTimeout(() => fs.writeFileSync(path.join(projects, 'x.jsonl'), '{}\n'), 50);
  const { events } = await waiting;
  assert.ok(events.some((e) => e.kind === 'file' && e.path.endsWith('x.jsonl')));
  // A store write from another process is a 'store' event.
  const seq = hub.seq;
  const w2 = hub.wait(seq, { timeoutMs: 5000 });
  setTimeout(() => fs.writeFileSync(path.join(data, 'board.json'), '{}'), 50);
  assert.ok((await w2).events.some((e) => e.kind === 'store'));
  // Timeout with nothing new.
  const quiet = await hub.wait(hub.seq, { timeoutMs: 50 });
  assert.deepEqual(quiet.events, []);
  // Too old for the ring: the client must reload.
  hub.ring = hub.ring.slice(-1);
  assert.equal(hub.since(0), null);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(hub.active, false);
  assert.equal(hub.watchers.size, 0);
  hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('LiveHub falls back to stat polling when fs.watch is unavailable', async () => {
  const dir = tmp();
  const f = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(f, '{}\n');
  const hub = new LiveHub({ dataDir: path.join(dir, 'data'), idleMs: 10000, watch: () => { throw new Error('ENOSYS'); } });
  hub.touch();
  hub.focus(f);
  assert.ok(hub.polled.has(f));
  await hub.pollStep(); // records the current signature
  const w = hub.wait(hub.seq, { timeoutMs: 8000 });
  setTimeout(() => fs.appendFileSync(f, '{"a":1}\n'), 50);
  const { events } = await w;
  assert.ok(events.some((e) => e.path === f));
  hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('canban_watch over stdio: patches the card and streams the open session', async () => {
  const fx = makeFixtures();
  const dataDir = tmp();
  const child = spawn(process.execPath, ['--no-warnings', path.join(root, 'server', 'index.mjs')], {
    env: { ...process.env, CANBAN_DATA_DIR: dataDir, CANBAN_CODEX_HOME: fx.codexHome, CANBAN_CLAUDE_HOME: fx.claudeHome, CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir, CANBAN_LAUNCH_DRYRUN: '1', CANBAN_SEARCH_INDEX: '0', CANBAN_BACKGROUND: '0', CANBAN_GH: path.join(root, 'tests', 'fake-gh.sh'), CANBAN_GLAB: path.join(root, 'tests', 'fake-glab.sh'), FAKE_GH_DATA: '/dev/null' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let nextId = 1;
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m);
  });
  const rpc = (method, params) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve) => waiting.set(id, resolve));
  };
  const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result.structuredContent;
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const d = await call('canban_get_session', { cardId: 'claude:c2' });
    assert.ok(d.feed);
    assert.deepEqual(d.feed.items.map((i) => i.k), ['user']);
    const { seq } = await call('canban_watch', { since: null });
    const file = path.join(fx.claudeHome, 'projects', '-r-web', 'c2.jsonl');
    const pending = call('canban_watch', { since: seq, cardId: 'claude:c2', offset: d.feed.offset, size: d.feed.size, timeoutMs: 10000 });
    await new Promise((r) => setTimeout(r, 200));
    fs.appendFileSync(file, line({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id: 'x1', name: 'Read', input: { file_path: '/r/web/README.md' } }] } }));
    const r = await pending;
    assert.ok(r.seq > seq);
    assert.equal(r.reload, false);
    const p = r.patches.find((x) => x.id === 'claude:c2');
    assert.equal(p.status, 'running');
    assert.equal(p.activity, 'Read: README.md');
    assert.deepEqual(r.feed.items.map((i) => [i.k, i.summary]), [['tool', 'README.md']]);
    assert.equal(r.feed.offset, fs.statSync(file).size);
    // Nothing new: the call waits for its timeout and returns no changes.
    const quiet = await call('canban_watch', { since: r.seq, cardId: 'claude:c2', offset: r.feed.offset, size: r.feed.size, timeoutMs: 300 });
    assert.deepEqual([quiet.patches.length, quiet.feed, quiet.reload], [0, null, false]);
    // A board edit made by another server shows up as a reload.
    const w = call('canban_watch', { since: quiet.seq, timeoutMs: 10000 });
    await new Promise((r2) => setTimeout(r2, 100));
    const board = JSON.parse(fs.readFileSync(path.join(dataDir, 'board.json'), 'utf8'));
    fs.writeFileSync(path.join(dataDir, 'board.json'), JSON.stringify(board));
    assert.equal((await w).reload, true);
    const perfInfo = await call('canban_get_perf');
    assert.equal(perfInfo.live.active, true);
  } finally {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fx.cleanup();
  }
});

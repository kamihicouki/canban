// Live status detection: JS rules, and the Python collector agrees on every case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { codexRawStatus, claudeRawStatus, settle, refineClaude, summaryOutdated, localStatus, STALE_MS } from '../server/status.mjs';
import { desktopSummaryOf, normalizeClaudeSummary, newSummary } from '../server/sources/claude.mjs';
import { RemotePool } from '../server/remote/pool.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ev = (type, extra = {}) => ({ type: 'event_msg', payload: { type, ...extra } });
const fc = (name, call_id) => ({ type: 'response_item', payload: { type: 'function_call', name, call_id } });
const fco = (call_id) => ({ type: 'response_item', payload: { type: 'function_call_output', call_id } });
const asst = (stop, content = [{ type: 'text', text: 'x' }]) => ({ type: 'assistant', message: { stop_reason: stop, content } });
const user = (content) => ({ type: 'user', message: { content } });

const CODEX = [
  [[], 'idle'],
  [[ev('task_started')], 'running'],
  [[ev('task_started'), ev('task_complete')], 'completed'],
  [[ev('task_started'), ev('turn_aborted')], 'aborted'],
  [[ev('task_started'), fc('request_user_input', 'c1')], 'waiting'],
  [[ev('task_started'), fc('request_user_input', 'c1'), fco('c1')], 'running'],
  [[ev('task_started'), fc('shell', 'c2')], 'running'],
];
const CLAUDE = [
  [[], 'idle'],
  [[user('hi'), asst('end_turn')], 'completed'],
  [[user('hi'), asst('tool_use', [{ type: 'tool_use', id: 't1', name: 'Bash' }])], 'running'],
  [[user('hi')], 'running'],
  [[user('hi'), asst('tool_use'), user([{ type: 'text', text: '[Request interrupted by user]' }])], 'aborted'],
  [[user('hi'), asst('tool_use', [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion' }])], 'waiting'],
  [[user('hi'), asst('tool_use', [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion' }]), user([{ type: 'tool_result', tool_use_id: 'q1' }])], 'running'],
  [[user('hi'), { ...asst('end_turn'), isSidechain: true }], 'running'],
];

test('codex status rules', () => {
  for (const [records, want] of CODEX) assert.equal(codexRawStatus(records), want, JSON.stringify(records));
});

test('claude status rules', () => {
  for (const [records, want] of CLAUDE) assert.equal(claudeRawStatus(records), want, JSON.stringify(records));
  assert.equal(refineClaude('completed', 'needs_input'), 'waiting');
  assert.equal(refineClaude('completed', 'completed'), 'completed');
  assert.equal(refineClaude('running', 'needs_input'), 'running');
});

test('a post-turn summary only counts for the turn it describes', () => {
  const said = { ...asst('end_turn'), uuid: 'a1' };
  const next = { ...asst('end_turn'), uuid: 'a2' };
  // Fresh, or with nothing to compare against: the app's word stands.
  assert.equal(claudeRawStatus([user('hi'), said], 'blocked', 'a1'), 'waiting');
  assert.equal(claudeRawStatus([user('hi'), said], 'blocked'), 'waiting');
  // A newer turn, or a message that fell out of the tail: an older turn's summary says nothing.
  assert.equal(claudeRawStatus([user('hi'), said, user('more'), next], 'blocked', 'a1'), 'completed');
  assert.equal(claudeRawStatus([user('more'), next], 'blocked', 'gone'), 'completed');
  // Bookkeeping lines and sidechains after the message do not make it older.
  assert.equal(summaryOutdated([said, { type: 'system' }, { ...user('note'), isMeta: true }, { ...next, isSidechain: true }], 'a1'), false);
  assert.equal(summaryOutdated([said, user('more')], 'a1'), true);
  assert.equal(summaryOutdated([], null), false);
});

test('desktopSummaryOf reads the post-turn summary defensively', () => {
  assert.deepEqual(desktopSummaryOf({ postTurnSummary: { status_category: 'blocked', summarizes_uuid: 'a1', needs_action: '  マージする  ' } }), { status: 'blocked', summaryFor: 'a1', needsAction: 'マージする' });
  assert.deepEqual(desktopSummaryOf({ statusCategory: 'needs_input' }), { status: 'needs_input', summaryFor: null, needsAction: null });
  assert.deepEqual(desktopSummaryOf({ postTurnSummary: { status_category: 'completed', needs_action: '', summarizes_uuid: 3 } }), { status: 'completed', summaryFor: null, needsAction: null });
  assert.deepEqual(desktopSummaryOf(undefined), { status: null, summaryFor: null, needsAction: null });
  assert.ok(desktopSummaryOf({ postTurnSummary: { needs_action: 'あ'.repeat(500) } }).needsAction.length <= 201);
  const s = normalizeClaudeSummary({ ...newSummary('x'), turns: 1 }, { postTurnSummary: { status_category: 'blocked', summarizes_uuid: 'a1', needs_action: '承認する' } });
  assert.deepEqual([s.desktopStatus, s.desktopSummaryFor, s.desktopNeedsAction], ['blocked', 'a1', '承認する']);
});

test('localStatus tells what the desktop app asks of the user, past the 15 minutes of waiting', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-ask-'));
  const file = path.join(dir, 'x.jsonl');
  try {
    const write = (...lines) => fs.writeFileSync(file, `${lines.map((o) => JSON.stringify(o)).join('\n')}\n`);
    const first = { ...asst('end_turn'), uuid: 'a1', timestamp: new Date().toISOString() };
    write(user('hi'), first);
    const now = Date.now();
    const session = (summaryFor, needs = '承認する') => ({ agent: 'claude', sourcePath: file, updatedAt: now, desktopStatus: 'blocked', desktopSummaryFor: summaryFor, desktopNeedsAction: needs });
    let s = session('a1');
    assert.equal(await localStatus(s, now), 'waiting');
    assert.equal(s.ask, '承認する');
    // The same answer read later: no longer "waiting", still what the user owes.
    s = session('a1');
    assert.equal(await localStatus(s, now + STALE_MS + 1000), 'idle');
    assert.equal(s.ask, '承認する');
    // A summary that changes without the log growing is picked up.
    s = session('a1', '別の承認');
    await localStatus(s, now);
    assert.equal(s.ask, '別の承認');
    // A newer turn leaves the summary behind.
    write(user('hi'), first, user('more'), { ...asst('end_turn'), uuid: 'a2' });
    s = session('a1');
    assert.equal(await localStatus(s, Date.now()), 'completed');
    assert.equal(s.ask, null);
    // No summary, no ask; a session idle for over a day says nothing.
    s = { agent: 'claude', sourcePath: file, updatedAt: now, desktopStatus: 'completed', desktopSummaryFor: null, desktopNeedsAction: null };
    assert.equal(await localStatus(s, Date.now()), 'completed');
    assert.equal(s.ask, null);
    s = session('a2');
    await localStatus(s, now + 25 * 3600e3);
    assert.equal(s.ask, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stale running/waiting becomes idle', () => {
  const now = 1_800_000_000_000;
  assert.equal(settle('running', now - STALE_MS - 1, now), 'idle');
  assert.equal(settle('waiting', now - 1000, now), 'waiting');
  assert.equal(settle('completed', now - STALE_MS * 10, now), 'completed');
});

test('python collector agrees on every case', async () => {
  const pool = new RemotePool({ ssh: path.join(here, 'fake-ssh.sh') });
  const host = { id: 'h', alias: 'fx', label: 'fx', sshArgs: [] };
  for (const [agent, cases] of [['codex', CODEX], ['claude', CLAUDE]]) {
    for (const [records, want] of cases) {
      const res = await pool.run(host, { mode: 'status', agent, records });
      assert.equal(res.raw, want, `${agent} ${JSON.stringify(records)}`);
    }
  }
});

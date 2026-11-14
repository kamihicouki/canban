// Live status detection: JS rules, and the Python collector agrees on every case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexRawStatus, claudeRawStatus, codexStatusFromRecords, claudeStatusFromRecords, localStatus, annotateStatus, settle, refineClaude, STALE_MS, RECENT_MS } from '../server/status.mjs';
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
  [[ev('task_started'), fc('request_user_input_async', 'c1')], 'waiting'],
  [[ev('task_started'), fc('functions.request_user_input', 'c1')], 'waiting'],
  [[ev('task_started'), fc('functions.request_user_input_async', 'c1')], 'waiting'],
  [[ev('task_started'), fc('mcp__functions__request_user_input_async', 'c1')], 'waiting'],
  [[ev('task_started'), fc('functions.request_user_input_async', 'c1'), fco('c1')], 'running'],
  [[ev('task_started'), fc('functions.request_user_input_async', 'c1'), ev('task_started')], 'running'],
  [[ev('task_started'), fc('send_user_message_question_reply', 'c1')], 'running'],
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
  [[user('hi'), asst('tool_use', [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion' }]), user('新しい依頼')], 'running'],
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

test('running expires after inactivity, but unanswered waiting lasts through the recent-session boundary', () => {
  const now = 1_800_000_000_000;
  assert.equal(settle('running', now - STALE_MS, now), 'running');
  assert.equal(settle('running', now - STALE_MS - 1, now), 'idle');
  assert.equal(settle('waiting', now - 1000, now), 'waiting');
  assert.equal(settle('waiting', now - STALE_MS - 1, now), 'waiting');
  assert.equal(settle('waiting', now - RECENT_MS, now), 'waiting');
  assert.equal(settle('waiting', now - RECENT_MS - 1, now), 'idle');
  assert.equal(settle('completed', now - STALE_MS * 10, now), 'completed');
});

test('local unanswered questions remain readable after 15 minutes, while answers, new turns and 24 hours clear the wait', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-wait-age-'));
  const now = 1_800_000_000_000;
  const codexAsk = { ...fc('functions.request_user_input', 'q'), payload: { ...fc('functions.request_user_input', 'q').payload, arguments: JSON.stringify({ questions: [{ question: '続けてよいですか？' }] }) } };
  const claudeAsk = asst('tool_use', [{ type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: { questions: [{ question: '続けてよいですか？' }] } }]);
  try {
    for (const [agent, waiting, answer, next] of [
      ['codex', [ev('task_started'), codexAsk], fco('q'), ev('task_started')],
      ['claude', [user('依頼'), claudeAsk], user([{ type: 'tool_result', tool_use_id: 'q' }]), user('次の依頼')],
    ]) {
      for (const [label, records, age, expected, question] of [
        ['unanswered', waiting, STALE_MS + 60_000, 'waiting', '続けてよいですか？'],
        ['answered', [...waiting, answer], STALE_MS + 60_000, 'idle', null],
        ['new-turn', [...waiting, next], STALE_MS + 60_000, 'idle', null],
        ['24h-boundary', waiting, RECENT_MS, 'waiting', '続けてよいですか？'],
        ['past-24h', waiting, RECENT_MS + 1, 'idle', null],
      ]) {
        const file = path.join(dir, `${agent}-${label}.jsonl`);
        fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
        fs.utimesSync(file, new Date(now - age), new Date(now - age));
        const session = { agent, sourcePath: file, updatedAt: now - age };
        assert.equal(await localStatus(session, now), expected, `${agent} ${label}`);
        assert.equal(session.signals?.waitText ?? null, question, `${agent} ${label} question`);
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Python raw status and remote settlement retain unanswered waits with the same age boundaries as local status', async () => {
  const pool = new RemotePool({ ssh: path.join(here, 'fake-ssh.sh') });
  const host = { id: 'h-wait-age', alias: 'fx', label: 'fx', local: false, sshArgs: [] };
  const now = 1_800_000_000_000;
  for (const [agent, records, fromRecords] of [
    ['codex', [ev('task_started'), fc('functions.request_user_input_async', 'q')], codexStatusFromRecords],
    ['claude', [user('依頼'), asst('tool_use', [{ type: 'tool_use', id: 'q', name: 'AskUserQuestion' }])], claudeStatusFromRecords],
  ]) {
    const res = await pool.run(host, { mode: 'status', agent, records });
    assert.equal(res.raw, 'waiting');
    for (const age of [STALE_MS + 1, RECENT_MS, RECENT_MS + 1]) {
      const session = { agent, host, updatedAt: now - age, statusMtimeMs: now - age, rawStatus: res.raw };
      await annotateStatus([session], now);
      assert.equal(session.status, age > RECENT_MS ? 'idle' : 'waiting', `${agent} ${age}`);
      assert.equal(session.status, fromRecords(records, now - age, now));
    }
  }
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

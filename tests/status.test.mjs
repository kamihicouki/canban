// Live status detection: JS rules, and the Python collector agrees on every case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexRawStatus, claudeRawStatus, settle, refineClaude, STALE_MS } from '../server/status.mjs';
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

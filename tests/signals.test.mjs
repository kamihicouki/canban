// Live signals: context, plan, edited files, sub-agents, what a session waits for,
// model / mode, and Codex rate limits — all from log records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeSignals, codexSignals, limitsFrom, noteLimits, currentLimits, resetLimitsForTest, cardSignals } from '../server/signals.mjs';

test('claude: context, to-do list, files of the current turn, sub-agents, waiting kind, model and mode', () => {
  const recs = [
    { type: 'user', permissionMode: 'acceptEdits', message: { content: '前のターン' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'e0', name: 'Edit', input: { file_path: '/r/old.ts' } }] } },
    { type: 'user', permissionMode: 'auto', message: { content: 'ログインを直して' } },
    { type: 'assistant', effort: 'high', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 150000, cache_creation_input_tokens: 2000, output_tokens: 500 }, content: [
      { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: '原因調査', status: 'completed' }, { content: '修正', activeForm: '修正しています', status: 'in_progress' }, { content: 'テスト', status: 'pending' }] } },
      { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/r/src/login.ts' } },
      { type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/r/src/login.test.ts' } },
      { type: 'tool_use', id: 's1', name: 'Task', input: { description: '調査' } },
      { type: 'tool_use', id: 's2', name: 'Agent', input: { description: 'レビュー' } },
    ] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: 'done' }] } },
    { type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-4-5', usage: { input_tokens: 999999 } } },
    { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: {} }] } },
  ];
  const s = claudeSignals(recs);
  assert.deepEqual(s.ctx, { used: 152510, window: null });
  assert.deepEqual([s.plan.done, s.plan.total, s.plan.current], [1, 3, '修正しています']);
  assert.deepEqual(s.plan.steps.map((x) => x.s), ['done', 'doing', 'todo']);
  assert.deepEqual(s.files.names, ['login.ts', 'login.test.ts']); // old.ts belonged to the previous turn
  assert.equal(s.subRunning, 1);
  assert.equal(s.wait, 'question');
  assert.deepEqual([s.model, s.effort, s.mode], ['claude-opus-5-5', 'high', 'auto']);
  // Over 200k tokens the context must be the 1M window.
  const big = claudeSignals([{ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 300000 } } }]);
  assert.deepEqual(big.ctx, { used: 300000, window: 1000000 });
  // Answered questions and a new prompt clear the turn state.
  const next = claudeSignals([...recs, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'q1', content: 'A' }] } }, { type: 'user', message: { content: '次へ' } }]);
  assert.deepEqual([next.wait, next.files, next.subRunning], [null, null, 0]);
  assert.equal(next.plan.total, 3); // the list stays until the agent rewrites it
});

test('codex: token_count context, update_plan, FileChange / apply_patch files, turn_context and rate limits', () => {
  const recs = [
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', changes: { '/r/old.ts': { type: 'update' } } } } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
    { type: 'turn_context', payload: { model: 'gpt-6-luna', effort: 'high', sandbox_policy: { type: 'workspace-write' } } },
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'update_plan', call_id: 'p1', arguments: JSON.stringify({ plan: [{ step: '調べる', status: 'completed' }, { step: '直す', status: 'in_progress' }] }) } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', changes: { '/r/src/a.ts': { type: 'update' }, '/r/src/b.ts': { type: 'add' } } } } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch\n*** Update File: src/c.ts\n@@\n*** End Patch' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', call_id: 'q1', arguments: '{}' } },
    { timestamp: '2026-09-29T00:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 129200 }, model_context_window: 258400 }, rate_limits: { primary: { used_percent: 12.5, window_minutes: 300, resets_at: 4102444800 }, secondary: { used_percent: 57, window_minutes: 10080, resets_at: 4102444800 }, plan_type: 'plus' } } },
  ];
  const s = codexSignals(recs);
  assert.deepEqual(s.ctx, { used: 129200, window: 258400 });
  assert.deepEqual([s.plan.done, s.plan.total, s.plan.current], [1, 2, '直す']);
  assert.deepEqual(s.files.names, ['a.ts', 'b.ts', 'c.ts']);
  assert.equal(s.wait, 'question');
  assert.deepEqual([s.model, s.effort, s.mode], ['gpt-6-luna', 'high', 'workspace-write']);
  const l = limitsFrom(recs);
  assert.deepEqual([l.primary.usedPercent, l.primary.windowMinutes, l.secondary.usedPercent, l.plan], [12.5, 300, 57, 'plus']);
  assert.equal(limitsFrom([{ type: 'event_msg', payload: { type: 'token_count', rate_limits: null } }]), null);
});

test('rate limits: the newest snapshot wins, and a window past its reset reads as unused', () => {
  resetLimitsForTest();
  const win = (p, reset) => ({ usedPercent: p, windowMinutes: 300, resetsAt: reset });
  noteLimits({ at: 2, primary: win(40, Date.now() + 3600e3), secondary: null });
  noteLimits({ at: 1, primary: win(90, Date.now() + 3600e3), secondary: null }); // older: ignored
  assert.equal(currentLimits().primary.usedPercent, 40);
  noteLimits({ at: 3, primary: win(100, Date.now() - 1000), secondary: null });
  assert.deepEqual([currentLimits().primary.usedPercent, currentLimits().primary.stale], [0, true]);
  resetLimitsForTest();
  assert.equal(currentLimits(), null);
});

test('cards carry a compact copy of the signals', () => {
  const full = claudeSignals([
    { type: 'user', message: { content: 'x' } },
    { type: 'assistant', message: { content: [...Array(8)].map((_, i) => ({ type: 'tool_use', id: `e${i}`, name: 'Edit', input: { file_path: `/r/f${i}.ts` } })) } },
  ]);
  const c = cardSignals(full);
  assert.equal(c.files.count, 8);
  assert.equal(c.files.names.length, 5);
  assert.equal(c.files.paths, undefined);
  assert.equal(cardSignals(null), null);
});

test('localStatus keeps signals across appends that push the turn out of the tail', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { localStatus, TAIL_BYTES } = await import('../server/status.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-sig-'));
  const file = path.join(dir, 's.jsonl');
  const line = (o) => `${JSON.stringify({ timestamp: new Date().toISOString(), ...o })}\n`;
  try {
    fs.writeFileSync(file, line({ type: 'user', message: { content: '直して' } }) +
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/r/a.ts' } }] } }));
    const s = { agent: 'claude', sourcePath: file, updatedAt: Date.now() };
    assert.equal(await localStatus(s), 'running');
    assert.deepEqual(s.signals.files.names, ['a.ts']);
    const filler = line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'x'.repeat(TAIL_BYTES) }] } });
    fs.appendFileSync(file, filler + line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'e2', name: 'Write', input: { file_path: '/r/b.ts' } }] } }));
    const s2 = { agent: 'claude', sourcePath: file, updatedAt: Date.now() };
    await localStatus(s2);
    assert.deepEqual(s2.signals.files.names, ['a.ts', 'b.ts']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Live signals: context, plan, edited files, sub-agents, what a session waits for,
// model / mode, and Codex rate limits — all from log records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeSignals, codexSignals, limitsFrom, noteLimits, currentLimits, resetLimitsForTest, cardSignals, newAcc, foldSignals, signalsView } from '../server/signals.mjs';

test('waiting questions expose bounded text and labels, restore older outstanding asks, and clear on answers', () => {
  const ask = (id, input, name = 'AskUserQuestion') => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  const answer = id => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'answered' }] } });
  const acc = newAcc('claude');
  foldSignals(acc, [ask('first', { questions: [{ question: '  最初の\n質問ですか？ ', options: [{ label: 'はい' }, { label: 'いいえ' }] }] }),
    ask('last', { questions: [{ question: 'x'.repeat(150), options: Array.from({ length: 8 }, (_, i) => ({ label: `${i}${'y'.repeat(50)}`, description: 'private metadata' })) }] })]);
  const last = signalsView(acc);
  assert.equal(last.waitText, 'x'.repeat(120));
  assert.equal(last.waitOptions.length, 6);
  assert.ok(last.waitOptions.every(x => x.length === 40));
  assert.ok(!JSON.stringify(last).includes('private metadata'));
  foldSignals(acc, [answer('last')]);
  assert.equal(signalsView(acc).waitText, '最初の 質問ですか？');
  assert.deepEqual(signalsView(acc).waitOptions, ['はい', 'いいえ']);
  assert.equal(acc.asks.get('first'), 'question', 'existing accumulator wait kinds remain compatible');
  foldSignals(acc, [ask('plan', { plan: 'not a question' }, 'ExitPlanMode')]);
  assert.deepEqual([signalsView(acc).wait, signalsView(acc).waitText, signalsView(acc).waitOptions], ['plan', null, null]);
  foldSignals(acc, [answer('plan'), answer('first')]);
  assert.deepEqual([signalsView(acc).wait, signalsView(acc).waitText, signalsView(acc).waitOptions], [null, null, null]);
  foldSignals(acc, [ask('next', { questions: [{ question: '次の質問' }] }), { type: 'user', message: { content: '新しい依頼' } }]);
  assert.equal(signalsView(acc).waitText, null);
});

test('Codex question shapes and namespaced async tools carry only actual question fields', () => {
  const call = (id, name, args) => ({ type: 'response_item', payload: { type: 'function_call', name, call_id: id, arguments: JSON.stringify(args) } });
  const a = call('q', 'functions.request_user_input_async', { questions: [{ title: 'どの方法を使いますか？', options: ['方法A', '方法B'] }] });
  const s = codexSignals([a]);
  assert.deepEqual([s.wait, s.waitText, s.waitOptions], ['question', 'どの方法を使いますか？', ['方法A', '方法B']]);
  assert.deepEqual(cardSignals(s).waitOptions, ['方法A', '方法B']);
  assert.equal(cardSignals(s).waitText, s.waitText);
  const b = call('q2', 'mcp__functions__request_user_input', { questions: [{ question: '同期の問い', options: [{ label: '選択肢' }] }] });
  assert.equal(codexSignals([b]).waitText, '同期の問い');
  assert.equal(codexSignals([a, { type: 'response_item', payload: { type: 'function_call_output', call_id: 'q' } }]).waitText, null);
  assert.equal(codexSignals([a, { type: 'event_msg', payload: { type: 'task_started' } }]).waitText, null);
  const malformed = codexSignals([call('bad', 'request_user_input', { questions: [{ question: { raw: 'JSON' }, options: [{ description: 'not a label' }] }] })]);
  assert.deepEqual([malformed.waitText, malformed.waitOptions], [null, null]);
});

test('malformed question argument shapes cannot stop signal collection or invent question text', () => {
  const call = args => ({ type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', call_id: 'q', arguments: JSON.stringify(args) } });
  for (const args of [null, true, 42, 'not a question object', [], [{ question: 'not a top-level question' }], { questions: [null] }, { questions: [[]] }]) {
    const acc = newAcc('codex');
    assert.doesNotThrow(() => foldSignals(acc, [call(args)]), JSON.stringify(args));
    assert.deepEqual([signalsView(acc).wait, signalsView(acc).waitText, signalsView(acc).waitOptions], ['question', null, null]);
    foldSignals(acc, [{ type: 'response_item', payload: { type: 'function_call_output', call_id: 'q' } }, call({ questions: [{ question: '次の問いは読めますか？' }] })]);
    assert.equal(signalsView(acc).waitText, '次の問いは読めますか？', 'a later valid question is still collected');
  }
});

test('Antigravity questions expose explicit text and clear at the next user input', () => {
  const acc = newAcc('antigravity');
  foldSignals(acc, [{ type: 'PLANNER_RESPONSE', step_index: 4, tool_calls: [{ id: 'q', name: 'ask_question', arguments: JSON.stringify({ question: '  実行して\nよいですか？ ', options: [{ label: '続行' }, '中止'] }) }] }]);
  assert.deepEqual([signalsView(acc).waitText, signalsView(acc).waitOptions], ['実行して よいですか？', ['続行', '中止']]);
  foldSignals(acc, [{ type: 'USER_INPUT', content: '続行' }]);
  assert.deepEqual([signalsView(acc).wait, signalsView(acc).waitText, signalsView(acc).waitOptions], [null, null, null]);
});

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

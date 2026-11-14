// Goal contract: the delegation level, readiness, wish-word warnings, atomic creation with the loop, and the start gates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store } from '../server/store.mjs';
import { loopPrompt } from '../server/loop.mjs';
import { contractReadiness, criterionWarning, normalizeContract, contractMissingText } from '../server/task-contract.mjs';

const setup = async t => {
  const base = path.resolve('.local/contract-tests'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'run-')), store = new Store(dir);
  t.after(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
};
const plain = v => JSON.parse(JSON.stringify(v)); // the model runs in its own vm realm
const L2 = { level: 2, goal: 'リリースできる状態にする', maxRounds: 4,
  criteria: [{ text: '試験が通る', verify: { kind: 'command', value: 'npm test' } }, { text: '画像が揃う', verify: { kind: 'human', value: '審査用の画像を人が見る' } }] };

test('readiness grows with the level; L0 and cards without a contract need nothing', () => {
  assert.deepEqual(plain(contractReadiness(null)), { level: 0, required: 0, filled: 0, missing: [], ready: true, warnings: [] });
  const l1 = contractReadiness({ level: 1 });
  assert.equal(l1.ready, false); assert.deepEqual([...l1.missing], ['goal']);
  assert.equal(contractReadiness({ level: 1, goal: '直す' }).ready, true);
  const bare = contractReadiness({ level: 2, goal: '直す' });
  assert.deepEqual([...bare.missing], ['criteria', 'verify', 'maxRounds']);
  const partial = contractReadiness({ level: 2 }, { goal: '直す', maxRounds: 5, criteria: [{ id: 'c1', text: '`npm test` が 0 で終わる', verify: { kind: 'command', value: 'npm test' } }, { id: 'c2', text: '文言をきれいに' }] });
  assert.deepEqual([...partial.missing], ['verify:c2']);
  assert.equal(`${partial.filled}/${partial.required}`, '4/5');
  assert.equal(contractMissingText(partial, [{ id: 'c1' }, { id: 'c2' }]), '条件2の確かめ方');
  assert.equal(partial.warnings.length, 1); assert.equal(partial.warnings[0].id, 'c2');
});

test('wish words warn unless the text or its check is concrete', () => {
  assert.equal(criterionWarning('画面をきれいにする').term, 'きれい');
  assert.match(criterionWarning('速くする').example, /200ms/);
  assert.equal(criterionWarning('初回表示が 200ms 以内で速く'), null);
  assert.equal(criterionWarning('`npm run lint` が通る、きれいに'), null);
  assert.equal(criterionWarning('きれいにする', { kind: 'human', value: '人が読む' }), null);
  assert.equal(criterionWarning('ログイン画面にエラー文を出す'), null);
});

test('contract terms are validated', () => {
  assert.deepEqual(plain(normalizeContract({ level: 2, goal: ' 目標 ', timeLimitMin: 30, gates: ['merge', 'merge', { text: 'DB変更の前' }] })),
    { level: 2, goal: '目標', timeLimitMin: 30, gates: ['merge', { text: 'DB変更の前' }] });
  assert.equal(normalizeContract({}).level, 1);
  assert.throws(() => normalizeContract({ level: 3 }), /任せる度合い/);
  assert.throws(() => normalizeContract({ timeLimitMin: 2 }), /5〜1440/);
  assert.throws(() => normalizeContract({ gates: ['deploy'] }), /関門/);
  assert.throws(() => normalizeContract({ gates: [{ text: 'a' }, { text: 'b' }] }), /1件/);
});

test('creating with criteria configures the loop in the same write; a bad criterion leaves no card', async t => {
  const store = await setup(t);
  const created = await store.createTask({ title: '0.30 のリリース', contract: { ...L2, gates: ['merge'], timeLimitMin: 90 } });
  assert.deepEqual(created.contract, { level: 2, goal: 'リリースできる状態にする', timeLimitMin: 90, gates: ['merge'] });
  const loop = await store.getLoop({ taskId: created.cardId });
  assert.equal(loop.revision, 1);
  const [cycle] = loop.cycles;
  assert.equal(cycle.goal, 'リリースできる状態にする'); assert.equal(cycle.maxRounds, 4); assert.equal(cycle.status, 'ready');
  assert.deepEqual(cycle.criteria[0], { id: 'c1', text: '試験が通る', verify: { kind: 'command', value: 'npm test' } });
  assert.equal(contractReadiness(created.contract, cycle).ready, true);

  const before = Object.keys((await store.load()).cards).length;
  await assert.rejects(store.createTask({ title: '壊れた条件', contract: { level: 2, goal: '目標', criteria: [{ text: '通る', verify: { kind: 'shell', value: 'x' } }] } }), /確かめ方の種類/);
  await assert.rejects(store.createTask({ title: '空の条件', contract: { level: 2, goal: '目標', criteria: [''] } }), /完了の条件/);
  await assert.rejects(store.createTask({ title: '目標なし', contract: { level: 2, criteria: ['通る'] } }), /目標が必要/);
  assert.equal(Object.keys((await store.load()).cards).length, before);
});

test('a repeated create request returns the first card and does not configure twice', async t => {
  const store = await setup(t);
  const a = await store.createTask({ title: 'x', clientRequestId: 'req-1', contract: L2 });
  const b = await store.createTask({ title: 'x', clientRequestId: 'req-1', contract: L2 });
  assert.equal(a.cardId, b.cardId);
  const loop = await store.getLoop({ taskId: a.cardId });
  assert.equal(loop.cycles.length, 1); assert.equal(loop.revision, 1);
});

test('an L1 contract keeps its goal on the card without a loop; plain string criteria still work', async t => {
  const store = await setup(t);
  const l1 = await store.createTask({ title: '調べる', contract: { level: 1, goal: '原因を特定する' } });
  assert.equal((await store.getLoop({ taskId: l1.cardId })).cycles.length, 0);
  assert.equal(contractReadiness(l1.contract).ready, true);
  const plain = await store.createTask({ title: '旧形式', contract: { level: 1, goal: '直す', criteria: ['テストが通る'] } });
  assert.deepEqual((await store.getLoop({ taskId: plain.cardId })).cycles[0].criteria, [{ id: 'c1', text: 'テストが通る' }]);
});

test('the prompt carries how to check each criterion, the gates and the time limit', () => {
  const cycle = { id: 'loop-1', version: 1, goal: '直す', principles: '', rounds: [], criteria: [{ id: 'c1', text: '通る', verify: { kind: 'command', value: 'npm test' } }, { id: 'c2', text: '読める' }] };
  const prompt = loopPrompt('task:1', cycle, { level: 2, gates: ['merge', { text: 'DB変更の前' }], timeLimitMin: 45 });
  assert.match(prompt, /c1: 通る — 確かめ方（コマンド）: npm test/);
  assert.match(prompt, /c2: 読める\n/);
  assert.match(prompt, /次の前には止まって人に確認する: マージの前、DB変更の前/);
  assert.match(prompt, /時間の上限: 45分/);
  assert.doesNotMatch(loopPrompt('task:1', cycle), /止まって人に確認/);
});

test('an L2 loop cannot start while a criterion has no check', async t => {
  const store = await setup(t);
  const task = await store.createTask({ title: 'L2', contract: { level: 2, goal: '直す', criteria: [{ text: 'a', verify: { kind: 'ci', value: 'test' } }, 'b'] } });
  const loop = await store.getLoop({ taskId: task.cardId });
  const start = () => store.loopCommand({ taskId: task.cardId, expectedRevision: loop.revision, commandId: crypto.randomUUID(), source: 'human', command: { type: 'start', cycleId: loop.cycles[0].id, nextAction: '直す' } });
  await assert.rejects(start(), /ゴールの契約が足りません: 条件2の確かめ方/);
  // An L1 task with the same loop starts: the gate is the level's, not the loop's.
  await store.updateTask({ cardId: task.cardId, contract: { level: 1 } });
  assert.equal((await start()).saved, true);
});

test('moving into a list that requires a contract stops a short task; the UI override records it', async t => {
  const store = await setup(t);
  // Off by default until the board offers the override (PR3); a list opts in.
  assert.equal((await store.load()).lists.find(l => l.id === 'doing').requiresContract, undefined);
  await store.updateList({ listId: 'doing', requiresContract: true });
  const short = await store.createTask({ title: '目標なし', contract: { level: 1 } });
  await assert.rejects(store.moveCard({ cardId: short.cardId, toListId: 'doing' }), e => e.code === 'contract_missing' && /「進行中」へ移す前に.*目標/.test(e.message));
  await store.moveCard({ cardId: short.cardId, toListId: 'review' });
  const moved = await store.moveCard({ cardId: short.cardId, toListId: 'doing', override: true });
  assert.equal(moved.listId, 'doing');
  assert.deepEqual(moved.contract.overrides.map(o => [o.by, o.to, o.missing]), [['human', 'doing', ['goal']]]);

  const note = await store.createTask({ title: 'メモ' });
  assert.equal((await store.moveCard({ cardId: note.cardId, toListId: 'doing' })).listId, 'doing');
  const ready = await store.createTask({ title: '準備済み', contract: L2 });
  assert.equal((await store.moveCard({ cardId: ready.cardId, toListId: 'doing' })).listId, 'doing');

  await store.updateList({ listId: 'doing', requiresContract: false });
  const other = await store.createTask({ title: '関門なし', contract: { level: 1 } });
  assert.equal((await store.moveCard({ cardId: other.cardId, toListId: 'doing' })).listId, 'doing');
});

test('updating the level keeps overrides and refuses criteria outside the loop', async t => {
  const store = await setup(t);
  await store.updateList({ listId: 'doing', requiresContract: true });
  const task = await store.createTask({ title: 't', contract: { level: 1 } });
  await store.moveCard({ cardId: task.cardId, toListId: 'doing', override: true });
  const up = await store.updateTask({ cardId: task.cardId, contract: { level: 2, goal: '直す', gates: ['production'] } });
  assert.equal(up.contract.level, 2); assert.equal(up.contract.goal, '直す'); assert.equal(up.contract.overrides.length, 1);
  await assert.rejects(store.updateTask({ cardId: task.cardId, contract: { criteria: ['x'] } }), /改善ループ/);
  assert.equal((await store.updateTask({ cardId: task.cardId, contract: null })).contract, undefined);
});

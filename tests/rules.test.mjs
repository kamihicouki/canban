import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { RuleEngine, replayRule } from '../server/rules.mjs';
import { runRules } from '../server/board.mjs';
import { leaderFor } from '../server/leader.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'canban-rules-'));
const rule = (trigger, fromListId, toListId) => ({ id: `r-${trigger}`, enabled: true, trigger, fromListId, toListId });

async function setup(rules) {
  const store = new Store(tmp());
  for (const r of rules) await store.setRule(r);
  const engine = new RuleEngine(store);
  const lists = {};
  const run = async (sessions, now) => {
    const moves = await engine.evaluate({
      rules: (await store.load()).settings.rules,
      sessions,
      listOf: (id) => lists[id] || 'inbox',
      topOrder: () => -1,
      now,
    });
    for (const m of moves) lists[m.cardId] = m.toListId;
    return moves;
  };
  return { store, run, lists };
}

test('rules fire only on transitions', async () => {
  const { run } = await setup([rule('status:completed', 'any', 'review')]);
  const t0 = 1_800_000_000_000;
  const s = { id: 'codex:a', createdAt: t0 - 1e6, updatedAt: t0, status: 'running' };
  assert.deepEqual(await run([s], t0), []); // first sighting of an existing session: baseline only
  const m = await run([{ ...s, status: 'completed', updatedAt: t0 + 1 }], t0 + 1000);
  assert.deepEqual(m.map((x) => [x.cardId, x.toListId]), [['codex:a', 'review']]);
  assert.deepEqual(await run([{ ...s, status: 'completed', updatedAt: t0 + 1 }], t0 + 2000), []); // no repeat
});

test('new sessions count as a transition; from-list and default rules respected', async () => {
  const { store, run } = await setup([rule('status:running', 'inbox', 'doing')]);
  const t0 = 1_800_000_000_000;
  await run([], t0); // start tracking
  const fresh = { id: 'claude:new', createdAt: t0 + 10, updatedAt: t0 + 10, status: 'running' };
  const moves = await run([fresh], t0 + 20);
  assert.deepEqual(moves.map((x) => x.toListId), ['doing']);
  assert.equal((await store.load()).settings.rules.filter((r) => r.id.startsWith('rule-')).every((r) => !r.enabled), true);
});

test('auto moves are recorded and can be undone', async () => {
  const store = new Store(tmp());
  await store.moveCard({ cardId: 'codex:a', toListId: 'doing', order: 5 });
  await store.applyAutoMoves([{ cardId: 'codex:a', toListId: 'review', order: -1, ruleId: 'r1' }]);
  let c = (await store.load()).cards['codex:a'];
  assert.equal(c.listId, 'review');
  assert.equal(c.movedBy.ruleId, 'r1');
  assert.deepEqual(c.history.map((h) => h.listId), ['doing', 'review']);
  await store.undoAutoMove({ cardId: 'codex:a' });
  c = (await store.load()).cards['codex:a'];
  assert.equal(c.listId, 'doing');
  assert.equal(c.order, 5);
  assert.equal(c.movedBy, undefined);
  await assert.rejects(store.undoAutoMove({ cardId: 'codex:a' }), /元に戻せる/);
});

test('invalid rules are rejected; launch settings keep rules', async () => {
  const store = new Store(tmp());
  await assert.rejects(store.setRule({ trigger: 'status:bogus', toListId: 'doing' }), /自動化/);
  await assert.rejects(store.setRule({ trigger: 'activity', toListId: 'nope' }), /移動先/);
  await store.setRule({ id: 'x', enabled: true, trigger: 'activity', fromListId: 'any', toListId: 'doing' });
  await store.updateLaunchSettings({ route: 'terminal' });
  assert.ok((await store.load()).settings.rules.some((r) => r.id === 'x'));
});

test('Codex section moves fire section:<id> rules, also for long-idle threads', async () => {
  const { store, run } = await setup([rule('section:sec-done', 'any', 'done')]);
  await assert.rejects(store.setRule({ trigger: 'section:../x', toListId: 'done' }), /自動化/);
  const t0 = 1_800_000_000_000;
  const old = { id: 'codex:old', createdAt: t0 - 9e9, updatedAt: t0 - 9e9, status: 'idle' }; // untouched for months
  assert.deepEqual(await run([{ ...old, codexSection: { id: 'sec-doing', name: 'doing' } }], t0), []); // baseline
  assert.deepEqual(await run([{ ...old, codexSection: { id: 'sec-doing', name: 'doing' } }], t0 + 1000), []);
  const m = await run([{ ...old, codexSection: { id: 'sec-done', name: 'done' } }], t0 + 2000);
  assert.deepEqual(m.map((x) => [x.cardId, x.toListId]), [['codex:old', 'done']]);
  assert.deepEqual(await run([{ ...old, codexSection: { id: 'sec-done', name: 'done' } }], t0 + 3000), []); // no repeat
});

test('archive transitions work for old idle sessions without a timestamp change, and can fire again after unarchiving', async () => {
  const { run, lists } = await setup([rule('archived', 'any', 'done')]);
  const t0 = 1_800_000_000_000;
  const old = { id: 'codex:old', createdAt: t0 - 9e9, updatedAt: t0 - 9e9, status: 'idle', archived: false };
  assert.deepEqual(await run([old], t0), []);
  // Regular scans retain the archive baseline even after more than 48 hours.
  assert.deepEqual(await run([old], t0 + 3 * 86400e3), []);
  const archived = { ...old, archived: true };
  assert.equal((await run([archived], t0 + 3 * 86400e3 + 1)).length, 1);
  lists[old.id] = 'inbox'; // an undo must not retrigger a stable archive state
  assert.deepEqual(await run([archived], t0 + 3 * 86400e3 + 2), []);
  assert.deepEqual(await run([old], t0 + 3 * 86400e3 + 3), []);
  assert.equal((await run([archived], t0 + 3 * 86400e3 + 4)).length, 1);
});

test('archive rules take precedence over activity observed at the same time', async () => {
  const { run } = await setup([rule('activity', 'any', 'doing'), rule('archived', 'any', 'done')]);
  const t0 = 1_800_000_000_000;
  const s = { id: 'codex:a', createdAt: t0 - 100, updatedAt: t0, archived: false };
  await run([s], t0);
  assert.equal((await run([{ ...s, archived: true, updatedAt: t0 + 1 }], t0 + 1))[0].toListId, 'done');
});

test('existing archives and unknown Claude archive states establish a baseline without false transitions', async () => {
  const { store, run } = await setup([rule('archived', 'any', 'done')]);
  const t0 = 1_800_000_000_000;
  const s = { id: 'claude:old', agent: 'claude', createdAt: t0 - 100, updatedAt: t0, desktopKnown: false, archived: false };
  // Old caches do not have the archive field.
  await store.database.call('system', 'auxiliaryPut', ['rules', { startedAt: t0, sessions: { [s.id]: { status: 'idle', updatedAt: t0, seen: t0 } } }]);
  assert.deepEqual(await run([s], t0), []);
  assert.deepEqual(await run([{ ...s, desktopKnown: true, archived: true }], t0 + 1), []);
  assert.deepEqual(await run([s], t0 + 2), []); // unknown is not an unarchive
  assert.deepEqual(await run([{ ...s, desktopKnown: true, archived: true }], t0 + 3), []);
  assert.deepEqual(await run([{ ...s, desktopKnown: true, archived: false }], t0 + 4), []);
  assert.equal((await run([{ ...s, desktopKnown: true, archived: true }], t0 + 5)).length, 1);
});

test('manual replay matches current status, archive, PR, CI and section conditions', () => {
  const sessions = [
    { id: 'complete', status: 'completed', archived: true, pr: { state: 'MERGED', checks: 'passing' }, codexSection: { id: 'sec-done' } },
    { id: 'running', status: 'running', archived: false, pr: { state: 'OPEN', checks: 'failing' } },
    { id: 'waiting', status: 'waiting', pr: { state: 'CLOSED', checks: 'pending' } },
    { id: 'aborted', status: 'aborted' },
    { id: 'unknown', agent: 'claude', desktopKnown: false, archived: true },
  ];
  const cases = [
    ['status:completed', ['complete']], ['status:running', ['running']], ['status:waiting', ['waiting']], ['status:aborted', ['aborted']],
    ['archived', ['complete']], ['pr:opened', ['running']], ['pr:merged', ['complete']], ['pr:closed', ['waiting']],
    ['ci:passed', ['complete']], ['ci:failed', ['running']], ['section:sec-done', ['complete']], ['activity', sessions.map((s) => s.id)],
  ];
  for (const [trigger, expected] of cases) {
    const moves = replayRule({ rule: { ...rule(trigger, 'inbox', 'done'), enabled: false }, sessions, listOf: () => 'inbox', topOrder: () => -1 });
    assert.deepEqual(moves.map((m) => m.cardId), expected, trigger);
  }
  assert.deepEqual(replayRule({ rule: rule('activity', 'doing', 'done'), sessions, listOf: () => 'inbox', topOrder: () => -1 }), []);
  assert.deepEqual(replayRule({ rule: rule('activity', 'any', 'done'), sessions, listOf: () => 'done', topOrder: () => -1 }), []);
});

test('manual replay works on a follower, deduplicates linked tasks, preserves the cache and supports undo', async () => {
  const store = new Store(tmp());
  const savedRule = await store.setRule({ ...rule('archived', 'inbox', 'done'), enabled: false });
  leaderFor(store.dir, { mode: 'never' }); // another client owns background evaluation
  const task = await store.createTask({ title: 'Archived work' });
  await store.linkSession({ taskId: task.cardId, sessionId: 'codex:a' });
  await store.linkSession({ taskId: task.cardId, sessionId: 'claude:b' });
  await store.moveCard({ cardId: 'codex:elsewhere', toListId: 'review' });
  await store.moveCard({ cardId: 'codex:done', toListId: 'done' });
  const cache = { startedAt: 123, sessions: {} };
  await store.database.call('system', 'auxiliaryPut', ['rules', cache]);
  const sessions = ['codex:a', 'claude:b', 'codex:elsewhere', 'codex:done', 'codex:old'].map((id) => ({ id, archived: true, updatedAt: 1 }));
  const run = () => runRules(store, null, sessions, Date.now(), { ruleId: savedRule.id });
  const moves = await run();
  assert.deepEqual(moves.map((m) => m.cardId).sort(), ['codex:old', task.cardId].sort());
  assert.deepEqual(await run(), []); // no new history or overwritten undo
  let state = await store.load();
  assert.equal(state.settings.rules.find((r) => r.id === savedRule.id).enabled, false);
  assert.equal(state.cards[task.cardId].history.length, 2);
  assert.equal(state.cards['codex:a'], undefined);
  assert.deepEqual(await store.database.call('system', 'auxiliaryRead', ['rules']), cache);
  await store.undoAutoMove({ cardId: task.cardId });
  await store.undoAutoMove({ cardId: 'codex:old' });
  state = await store.load();
  assert.equal(state.cards[task.cardId].listId, 'inbox');
  assert.equal(state.cards['codex:old'].listId, undefined);
  assert.equal((await run()).length, 2); // explicit replay reapplies even after undo
  await assert.rejects(runRules(store, null, sessions, Date.now(), { ruleId: 'missing' }), /自動化が見つかりません/);
  await store.deleteList({ listId: 'done' });
  await assert.rejects(run(), /移動先/);
});

test('rule moves do not override an intervening placement or overwrite undo on repeated execution', async () => {
  const store = new Store(tmp());
  const r = await store.setRule(rule('archived', 'any', 'done'));
  const moves = [{ cardId: 'codex:a', fromListId: 'inbox', toListId: 'done', order: -1, ruleId: r.id }];
  await store.moveCard({ cardId: 'codex:a', toListId: 'review' });
  assert.deepEqual(await store.applyAutoMoves(moves, { rule: r }), []);
  await store.moveCard({ cardId: 'codex:a', toListId: 'inbox' });
  assert.equal((await store.applyAutoMoves(moves, { rule: r })).length, 1);
  assert.deepEqual(await store.applyAutoMoves(moves, { rule: r }), []);
  await store.undoAutoMove({ cardId: 'codex:a' });
  assert.equal((await store.load()).cards['codex:a'].listId, 'inbox');
  await store.setRule({ ...r, toListId: 'review' });
  await assert.rejects(store.applyAutoMoves(moves, { rule: r }), /変更または削除/);
});

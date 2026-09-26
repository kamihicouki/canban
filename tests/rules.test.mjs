import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { RuleEngine } from '../server/rules.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'canban-rules-'));
const rule = (trigger, fromListId, toListId) => ({ id: `r-${trigger}`, enabled: true, trigger, fromListId, toListId });

async function setup(rules) {
  const store = new Store(tmp());
  for (const r of rules) await store.setRule(r);
  const engine = new RuleEngine(store);
  const lists = {};
  const run = async (sessions, now) => {
    const moves = await engine.evaluate({
      rules: store.load().settings.rules,
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
  assert.equal(store.load().settings.rules.filter((r) => r.id.startsWith('rule-')).every((r) => !r.enabled), true);
});

test('auto moves are recorded and can be undone', async () => {
  const store = new Store(tmp());
  await store.moveCard({ cardId: 'codex:a', toListId: 'doing', order: 5 });
  await store.applyAutoMoves([{ cardId: 'codex:a', toListId: 'review', order: -1, ruleId: 'r1' }]);
  let c = store.load().cards['codex:a'];
  assert.equal(c.listId, 'review');
  assert.equal(c.movedBy.ruleId, 'r1');
  assert.deepEqual(c.history.map((h) => h.listId), ['doing', 'review']);
  await store.undoAutoMove({ cardId: 'codex:a' });
  c = store.load().cards['codex:a'];
  assert.equal(c.listId, 'doing');
  assert.equal(c.order, 5);
  assert.equal(c.movedBy, undefined);
  await assert.rejects(store.undoAutoMove({ cardId: 'codex:a' }), /元に戻せる/);
});

test('invalid rules are rejected; launch settings keep rules', async () => {
  const store = new Store(tmp());
  await assert.rejects(store.setRule({ trigger: 'status:bogus', toListId: 'doing' }), /ルール/);
  await assert.rejects(store.setRule({ trigger: 'activity', toListId: 'nope' }), /移動先/);
  await store.setRule({ id: 'x', enabled: true, trigger: 'activity', fromListId: 'any', toListId: 'doing' });
  await store.updateLaunchSettings({ route: 'terminal' });
  assert.ok(store.load().settings.rules.some((r) => r.id === 'x'));
});

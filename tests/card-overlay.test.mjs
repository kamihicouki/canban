import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const workspaceModel = fs.readFileSync(new URL('../ui/workspace-model.js', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../ui/card-overlay-model.js', import.meta.url), 'utf8');
const model = vm.runInNewContext(`${workspaceModel}\n${source}\n({cardKind, normalizeCardWidths, taskOverlayIds, taskRequestText, neighborCardId, CARD_WIDTH_DEF, TASK_SESSIONS_MAX});`);
const plain = (v) => JSON.parse(JSON.stringify(v));

test('a card is a task or a session by its id', () => {
  assert.equal(model.cardKind('task:abc'), 'task');
  assert.equal(model.cardKind('codex:abc'), 'session');
  assert.equal(model.cardKind('claude:abc'), 'session');
});
test('width is kept per kind, clamped, and falls back to the default', () => {
  assert.deepEqual(plain(model.normalizeCardWidths(null)), { session: 1000, task: 760 });
  assert.deepEqual(plain(model.normalizeCardWidths({ session: 100, task: 99999 })), { session: 560, task: 1600 });
  assert.deepEqual(plain(model.normalizeCardWidths({ session: 800.4, task: 'wide' })), { session: 800, task: 760 });
});
test('a task lists itself first, then its linked sessions without sub-agents, in link order', () => {
  const links = [{ id: 'codex:a' }, { id: 'codex:sub', subagent: true }, { id: 'claude:b' }];
  const view = model.taskOverlayIds('task:t', links);
  assert.deepEqual(plain(view), { ids: ['task:t', 'codex:a', 'claude:b'], total: 2 });
});
test('sessions already on the layer keep their place; new links go last and removed ones drop out', () => {
  const links = [{ id: 'codex:a' }, { id: 'codex:b' }, { id: 'codex:c' }];
  const view = model.taskOverlayIds('task:t', links, ['task:t', 'codex:c', 'codex:gone', 'codex:a']);
  assert.deepEqual(plain(view.ids), ['task:t', 'codex:c', 'codex:a', 'codex:b']);
});
test('at most eight sessions sit beside a task, but all of them are counted', () => {
  const links = Array.from({ length: 19 }, (_, i) => ({ id: `codex:${i}` }));
  const view = model.taskOverlayIds('task:t', links);
  assert.equal(view.ids.length, 1 + model.TASK_SESSIONS_MAX);
  assert.equal(view.total, 19);
  assert.deepEqual(plain(view.ids.slice(1)), links.slice(0, 8).map((l) => l.id));
});
test('request composition includes the editable task title, description and memo without sending', () => {
  assert.equal(model.taskRequestText('  依頼  ', '目的', '完了条件'), '依頼\n\n目的\n\n完了条件');
});
test('j / k step through the cards in the order shown and stop at the ends', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(model.neighborCardId(ids, 'b', 1), 'c');
  assert.equal(model.neighborCardId(ids, 'b', -1), 'a');
  assert.equal(model.neighborCardId(ids, 'c', 1), null);
  assert.equal(model.neighborCardId(ids, 'a', -1), null);
  assert.equal(model.neighborCardId(ids, 'zzz', 1), null); // a card that is not on the board
});

test('card height is shared per kind and rejects invalid dimensions', () => {
  const normalize = vm.runInNewContext(`${workspaceModel}\n${source}\nnormalizeCardHeights`);
  assert.deepEqual(plain(normalize(null)), { session: 860, task: 860 });
  assert.deepEqual(plain(normalize({ session: 1, task: 9999 })), { session: 320, task: 1600 });
  assert.deepEqual(plain(normalize({ session: NaN, task: Infinity })), { session: 860, task: 860 });
  assert.deepEqual(plain(normalize({ session: 612.6, task: '700' })), { session: 613, task: 860 });
});


import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const workspaceModel = fs.readFileSync(new URL('../ui/workspace-model.js', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../ui/card-overlay-model.js', import.meta.url), 'utf8');
const model = vm.runInNewContext(`${workspaceModel}\n${source}\n({cardKind, normalizeCardWidths, normalizeCardLayouts, taskOverlayIds, taskRequestText, taskCardLayoutDefaults, neighborCardId, CARD_WIDTH_DEF, TASK_SESSIONS_MAX});`);
const plain = (v) => JSON.parse(JSON.stringify(v));
const defaults = { main: ['conv', 'memo', 'related', 'send'], side: ['resume', 'add'], collapsed: [] };
const heights = { conv: 180, memo: 150, related: 180, send: 360, resume: 290, add: 130 };

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
test('layouts are kept per kind: the task starts with its own order, and one kind does not move the other', () => {
  const layouts = plain(model.normalizeCardLayouts({ session: { main: ['send', 'conv'], side: [], heights: { conv: 220 } } }, defaults, heights));
  assert.deepEqual(layouts.session.main.slice(0, 2), ['send', 'conv']);
  assert.equal(layouts.session.heights.conv, 220);
  assert.deepEqual(layouts.task.main, ['conv', 'send', 'memo', 'related']);
  assert.equal(layouts.task.heights.conv, 160); // the task's description is shorter than a conversation
  const again = plain(model.normalizeCardLayouts(layouts, defaults, heights));
  assert.deepEqual(again, layouts); // saved layouts survive a round trip
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

test('untouched legacy layout migrates while custom placement and heights remain intact', () => {
  const old = { main: ['conv', 'progress', 'send', 'labels', 'memo', 'detail', 'pr', 'related', 'first'],
    side: ['resume', 'task', 'add', 'prio', 'other'], collapsed: [], ratio: 2 / 3,
    heights: { conv: 180, send: 360 } };
  const def = { main: ['conv', 'send'], side: ['breadcrumb', 'title', 'status', 'labels', 'related', 'detail', 'resume', 'progress', 'task', 'memo', 'first', 'add', 'prio', 'other', 'pr'], collapsed: ['memo'] };
  const layout = plain(model.normalizeCardLayouts({ session: old }, def, { conv: 440, send: 230 }));
  assert.deepEqual(layout.session.main, ['conv', 'send']);
  assert.deepEqual(layout.session.side.slice(0, 3), ['breadcrumb', 'title', 'status']);
  assert.equal(layout.session.heights.conv, 440);
  const custom = { ...old, main: ['send', ...old.main.filter(id => id !== 'send')], heights: { conv: 222 }, collapsed: ['memo'], ratio: .6 };
  const next = plain(model.normalizeCardLayouts({ session: custom }, def, { conv: 440 }));
  assert.equal(next.session.main[0], 'send');
  assert.equal(next.session.heights.conv, 222);
  assert.equal(next.session.ratio, .6);
  assert.deepEqual(next.session.collapsed, ['memo']);
  assert.deepEqual(next.session.side.slice(0, 3), ['breadcrumb', 'title', 'status']);
  assert.deepEqual(plain(model.normalizeCardLayouts(next, def, { conv: 440 })), next);
});

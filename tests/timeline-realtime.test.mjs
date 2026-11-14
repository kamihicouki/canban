import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture(cards, timeline = true) {
  const source = fs.readFileSync(new URL('../ui/realtime.js', import.meta.url), 'utf8');
  const patch = source.slice(source.indexOf('function findCard('), source.indexOf('async function refreshDispatch('));
  const counters = { listPaint: 0, boardPaint: 0, reload: 0 };
  const state = { board: { lists: [{ id: 'work', cards }] }, drag: false };
  const model = vm.runInNewContext(patch + '\n({ applyPatches, findCard });', {
    state, live: { feeds: new Map() }, CSS: { escape: x => x },
    inboxOn: () => timeline, refreshInboxList: () => counters.listPaint++,
    scheduleLoad: () => counters.reload++,
    renderCard: () => { counters.boardPaint++; return { focus() {} }; },
    document: { activeElement: null, querySelector: () => ({ querySelector: () => null, contains: () => false, replaceWith() {} }) },
  });
  return { model, state, counters };
}

test('a same-status linked patch updates question content and the timeline list without replacing a board card', () => {
  const child = { id: 'claude:a', status: 'waiting', updatedAt: 10, signals: { wait: 'question', waitText: 'old' } };
  const task = { id: 'task:a', kind: 'task', status: 'waiting', updatedAt: 10, links: [child] };
  const f = fixture([task]);
  f.model.applyPatches([{ id: child.id, status: 'waiting', updatedAt: 20, activity: '質問中', signals: { wait: 'question', waitText: 'new' } }]);
  assert.equal(child.signals.waitText, 'new');
  assert.equal(child.activity, '質問中');
  assert.equal(child.updatedAt, 20);
  assert.equal(task.updatedAt, 20);
  assert.equal(f.counters.listPaint, 1);
  assert.equal(f.counters.boardPaint, 0);
});

test('a standalone timeline patch retains timeline rows and handles status changes locally and by reload', () => {
  const card = { id: 'codex:a', status: 'running', updatedAt: 10 };
  const f = fixture([card]);
  f.model.applyPatches([{ id: card.id, status: 'completed', updatedAt: 30, signals: null }]);
  assert.equal(card.status, 'completed');
  assert.equal(card.signals, null);
  assert.equal(f.counters.listPaint, 1);
  assert.equal(f.counters.boardPaint, 0);
  assert.equal(f.counters.reload, 1);
});

test('board patches still render board cards and linked parent summaries', () => {
  const card = { id: 'codex:a', status: 'running', updatedAt: 10 };
  const child = { id: 'claude:a', status: 'waiting', updatedAt: 10 };
  const task = { id: 'task:a', kind: 'task', links: [child], updatedAt: 10 };
  const f = fixture([card, task], false);
  f.model.applyPatches([
    { id: card.id, status: 'running', updatedAt: 20, activity: '作業中' },
    { id: child.id, status: 'waiting', updatedAt: 20, signals: { waitText: '質問' } },
  ]);
  assert.equal(f.counters.listPaint, 0);
  assert.equal(f.counters.boardPaint, 2);
  assert.equal(child.signals.waitText, '質問');
});

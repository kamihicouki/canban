import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { taskTools } from '../server/tools/tasks.mjs';

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-handoff-'));
  const store = new Store(dir);
  t.after(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const task = await store.createTask({ title: '引継ぎ', description: '目的の原文' });
  await store.linkSession({ taskId: task.cardId, sessionId: 'codex:reporter' });
  return { store, dir, taskId: task.cardId };
}
const getTool = store => taskTools({ store }).find(t => t.name === 'canban_get_task');

test('read task is model-visible, reads once and preserves saved fields without enumerating sessions', async () => {
  let reads = 0;
  const state = { lists: [{ id: 'a', title: '仕事' }], cards: { 'task:a': { kind: 'task', title: '原題', description: '原文', note: '個人メモ', listId: 'a', links: ['codex:a'], context: { directory: '/example' } } } };
  const before = structuredClone(state);
  const tool = getTool({ load: async () => { reads++; return state; } });
  assert.ok(tool);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(new Set(tool._meta['ui']?.visibility), new Set(['app', 'model']));
  const { structured: { task, list } } = await tool.handler({ taskId: 'task:a' });
  assert.equal(reads, 1);
  assert.equal(task.description, '原文');
  assert.equal(task.note, '個人メモ');
  assert.deepEqual(task.linkedSessionIds, ['codex:a']);
  assert.equal(list.title, '仕事');
  assert.deepEqual(state, before);
  await assert.rejects(tool.handler({ taskId: 'codex:a' }), /タスク/);
  await assert.rejects(tool.handler({ taskId: 'task:missing' }), /見つかりません/);
  await assert.rejects(tool.handler({ taskId: 'task:a', limit: 21 }), /取得件数/);
});

test('append retains original text, server provenance and unrelated task data; pagination exposes no request hash', async t => {
  const { store, taskId } = await setup(t);
  const before = await store.load();
  const result = await store.appendTaskNote({ taskId, text: '  調査結果\n原文  ', sourceSessionId: 'codex:reporter', nextAction: '比較する', expectedRevision: 0, clientRequestId: 'first' });
  assert.equal(result.saved, true);
  assert.equal(result.note.source, 'reported');
  assert.equal(result.note.text, '  調査結果\n原文  ');
  assert.ok(Number.isFinite(Date.parse(result.note.at)));
  await store.appendTaskNote({ taskId, text: '追記', clientRequestId: 'second' });
  const readBefore = await store.load();
  const { structured: read } = await getTool(store).handler({ taskId, limit: 1 });
  assert.deepEqual(await store.load(), readBefore);
  assert.equal(read.task.totalNotes, 2);
  assert.equal(read.task.nextAction, '比較する');
  assert.equal(read.task.notes[0].requestHash, undefined);
  assert.equal(read.task.latestNoteSummary.text, '追記');
  const { structured: page } = await getTool(store).handler({ taskId, after: read.task.nextCursor });
  assert.equal(page.task.notes[0].text, '追記');
  await assert.rejects(getTool(store).handler({ taskId, after: 'missing' }), /カーソル/);
  const after = await store.load();
  const { handoff, updatedAt, ...rest } = after.cards[taskId];
  const { updatedAt: previousUpdatedAt, ...prior } = before.cards[taskId];
  assert.deepEqual(rest, prior);
  assert.deepEqual({ ...after, cards: before.cards }, before);
});

test('CAS, idempotency and concurrent append are atomic and failures do not change stored state', async t => {
  const { store, dir, taskId } = await setup(t);
  const args = { taskId, text: '一回', nextAction: '次へ', expectedRevision: 0, clientRequestId: 'same' };
  const first = await store.appendTaskNote(args);
  const before = await store.load();
  const duplicate = await store.appendTaskNote(args);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.note.id, first.note.id);
  const conflict = await store.appendTaskNote({ ...args, clientRequestId: 'stale' });
  assert.equal(conflict.conflict, true);
  await assert.rejects(store.appendTaskNote({ ...args, text: '別の本文' }), /リクエスト/);
  await assert.rejects(store.appendTaskNote({ ...args, clientRequestId: 'bad', sourceSessionId: 'claude:unrelated' }), /紐付/);
  await assert.rejects(store.appendTaskNote({ taskId, text: ' ', clientRequestId: 'blank' }), /本文/);
  await assert.rejects(store.appendTaskNote({ taskId, text: '報告', nextAction: null, clientRequestId: 'unguarded' }), /リビジョン/);
  assert.deepEqual(await store.load(), before);
  const other = new Store(dir);
  await Promise.all([store, other].map((client, i) => client.appendTaskNote({ taskId, text: `並行${i}`, clientRequestId: `parallel${i}` })));
  assert.equal((await getTool(store).handler({ taskId })).structured.task.totalNotes, 3);
  const revision = 3;
  const race = await Promise.all([store, other].map((client, i) => client.appendTaskNote({ taskId, text: `提案${i}`, nextAction: `次${i}`, expectedRevision: revision, clientRequestId: `race${i}` })));
  assert.equal(race.filter(result => result.saved).length, 1);
  assert.equal(race.filter(result => result.conflict).length, 1);
});

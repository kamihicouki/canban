import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';

const snapshot = (id, preset = 'A') => ({ preset, activeSessionId: id, paneGlobal: { arrange: 'row' }, paneLayout: { main: ['conv', 'send'], side: ['memo'], ratio: .6, heights: { conv: 300 } }, panes: [{ id, space: 'free', size: 'M', free: { x: 120, y: 80 } }] });
async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-task-dashboards-'));
  const store = new Store(dir);
  t.after(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}

test('each task retains its dashboard after the current dashboard is closed, independently of links and work information', async t => {
  const store = await setup(t);
  const a = await store.createTask({ title: '調査', description: '目的を確認' });
  const b = await store.createTask({ title: '実装' });
  await store.linkSession({ taskId: a.cardId, sessionId: 'codex:research' });
  await store.linkSession({ taskId: b.cardId, sessionId: 'claude:implementation' });
  assert.equal((await store.getTaskDashboard({ taskId: a.cardId })).state, null);
  await store.saveTaskDashboard({ taskId: a.cardId, expectedRevision: 0, state: snapshot('codex:research', 'free') });
  await store.saveTaskDashboard({ taskId: b.cardId, expectedRevision: 0, state: snapshot('claude:implementation', 'B') });
  await store.saveUiState({ expectedRevision: 0, state: { panes: [], dashOpen: false } });
  const read = await store.getTaskDashboard({ taskId: a.cardId });
  assert.equal(read.state.preset, 'free');
  assert.deepEqual(read.state.panes[0].free, { x: 120, y: 80 });
  assert.equal((await store.getTaskDashboard({ taskId: b.cardId })).state.preset, 'B');
  const task = (await store.load()).cards[a.cardId];
  assert.equal(task.description, '目的を確認');
  assert.deepEqual(task.links, ['codex:research']);
});

test('a stale screen cannot overwrite a task dashboard or another task', async t => {
  const store = await setup(t);
  const task = await store.createTask({ title: '競合' });
  await store.saveTaskDashboard({ taskId: task.cardId, expectedRevision: 0, state: snapshot(null, 'C') });
  const stale = await store.saveTaskDashboard({ taskId: task.cardId, expectedRevision: 0, state: snapshot(null, 'B') });
  assert.equal(stale.saved, false);
  assert.equal(stale.conflict, true);
  assert.equal(stale.revision, 1);
  assert.equal(stale.state.preset, 'C');
  await assert.rejects(store.saveTaskDashboard({ taskId: task.cardId, expectedRevision: -1, state: {} }), /リビジョン/);
  await assert.rejects(store.getTaskDashboard({ taskId: 'codex:unknown' }), /タスクカード/);
});

test('restoration reflects explicit link changes and strips unrelated panes and conversation contents', async t => {
  const store = await setup(t);
  const task = await store.createTask({ title: '復元' });
  for (const id of ['codex:a', 'codex:b']) await store.linkSession({ taskId: task.cardId, sessionId: id });
  const state = snapshot('codex:a');
  state.messages = ['保存してはいけない'];
  state.panes.push({ id: 'codex:b' }, { id: 'codex:unrelated', prompt: '別の仕事' });
  await store.saveTaskDashboard({ taskId: task.cardId, expectedRevision: 0, state });
  await store.unlinkSession({ taskId: task.cardId, sessionId: 'codex:a' });
  const read = await store.getTaskDashboard({ taskId: task.cardId });
  assert.deepEqual(read.links, ['codex:b']);
  assert.equal(read.state.activeSessionId, 'codex:b');
  assert.deepEqual(read.state.panes.map(p => p.id), ['codex:b']);
  assert.equal(read.state.messages, undefined);
});

test('task membership and layout preferences are retained for more than eight sessions', async t => {
  const store = await setup(t);
  const task = await store.createTask({ title: '多数の関連会話' });
  const ids = Array.from({ length: 12 }, (_, i) => `codex:session${i}`);
  for (const id of ids) await store.linkSession({ taskId: task.cardId, sessionId: id });
  await store.saveTaskDashboard({ taskId: task.cardId, expectedRevision: 0, state: { preset: 'C', panes: ids.map(id => ({ id, size: 'S' })) } });
  const read = await store.getTaskDashboard({ taskId: task.cardId });
  assert.equal(read.links.length, 12);
  assert.deepEqual(read.state.panes.map(p => p.id), ids);
});

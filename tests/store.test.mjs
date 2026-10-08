import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sk-store-'));

test('default board has four lists and inbox as default', async () => {
  const s = (await new Store(tmp()).load());
  assert.deepEqual(s.lists.map((l) => l.id), ['inbox', 'doing', 'review', 'done']);
  assert.equal(s.defaultListId, 'inbox');
});

test('create / rename / reorder / delete lists', async () => {
  const store = new Store(tmp());
  const list = await store.createList({ title: '保留' });
  assert.equal((await store.load()).lists.at(-1).title, '保留');
  await store.updateList({ listId: list.id, title: '保留中', wipLimit: 3, color: 'red' });
  const updated = (await store.load()).lists.find((l) => l.id === list.id);
  assert.equal(updated.title, '保留中');
  assert.equal(updated.wipLimit, 3);
  assert.equal(updated.color, 'red');
  await store.reorderLists({ listIds: [list.id, 'inbox'] });
  assert.deepEqual((await store.load()).lists.map((l) => l.id).slice(0, 2), [list.id, 'inbox']);

  await store.moveCard({ cardId: 'codex:a', toListId: list.id, order: 5 });
  const res = await store.deleteList({ listId: list.id, moveCardsTo: 'review' });
  assert.equal(res.moved, 1);
  const st = (await store.load());
  assert.ok(!st.lists.some((l) => l.id === list.id));
  assert.equal(st.cards['codex:a'].listId, 'review');
  assert.equal(st.cards['codex:a'].order, undefined);
});

test('deleting the default list moves default to first remaining list', async () => {
  const store = new Store(tmp());
  await store.deleteList({ listId: 'inbox' });
  assert.equal((await store.load()).defaultListId, 'doing');
});

test('cannot delete the last list; empty titles rejected', async () => {
  const store = new Store(tmp());
  for (const id of ['inbox', 'doing', 'review']) await store.deleteList({ listId: id });
  await assert.rejects(store.deleteList({ listId: 'done' }), /最後のリスト/);
  await assert.rejects(store.createList({ title: '  ' }), /リスト名/);
});

test('card attributes and labels', async () => {
  const store = new Store(tmp());
  await store.updateCard({ cardId: 'claude:x', labels: ['lbl-bug', 'nope'], note: 'memo', priority: 'high', due: '2026-10-01' });
  let c = (await store.load()).cards['claude:x'];
  assert.deepEqual(c.labels, ['lbl-bug']);
  assert.equal(c.note, 'memo');
  assert.equal(c.priority, 'high');
  await store.deleteLabel({ labelId: 'lbl-bug' });
  c = (await store.load()).cards['claude:x'];
  assert.deepEqual(c.labels, []);
  const l = await store.createLabel({ name: '急ぎ', color: 'orange' });
  assert.ok((await store.load()).labels.some((x) => x.id === l.id));
});

test('existing JSON requires explicit migration', async () => {
  const dir=tmp(); fs.writeFileSync(path.join(dir,'board.json'),'{broken');
  await assert.rejects(new Store(dir).load(), /移行が必要/);
  assert.equal(fs.readFileSync(path.join(dir,'board.json'),'utf8'),'{broken');
});

test('launch settings are validated and persisted', async () => {
  const store = new Store(tmp());
  assert.deepEqual((await store.load()).settings.launch, { route: 'desktop', terminal: 'terminal', target: 'new-window' });
  await store.updateLaunchSettings({ route: 'terminal', terminal: 'ghostty', target: 'split' });
  assert.deepEqual((await store.load()).settings.launch, { route: 'terminal', terminal: 'ghostty', target: 'split' });
  await store.updateLaunchSettings({ target: 'bogus' });
  assert.equal((await store.load()).settings.launch.target, 'new-window');
});

test('remote hosts are opt-in', async () => {
  const store = new Store(tmp());
  assert.deepEqual((await store.load()).remoteHosts, {});
  await store.setRemoteHost({ hostId: 'remote-ssh-discovered:box', enabled: true });
  assert.equal((await store.load()).remoteHosts['remote-ssh-discovered:box'].enabled, true);
  await assert.rejects(store.setRemoteHost({ hostId: 'local', enabled: true }), /ホスト/);
});

test('concurrent mutations are serialized and none are lost', async () => {
  const store = new Store(tmp());
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.moveCard({ cardId: `codex:${i}`, toListId: 'doing', order: i })));
  const cards = (await store.load()).cards;
  assert.equal(Object.keys(cards).length, 20);
});

test('shared view state uses compare-and-save revisions without changing the board', async () => {
  const store = new Store(tmp());
  await store.createList({ title: '作業中' });
  assert.deepEqual((await store.getUiState()), { revision: 0, state: null });

  const firstState = { filters: { agent: 'claude' }, panes: [{ id: 'codex:one', mode: 'preview' }] };
  const saved = await store.saveUiState({ expectedRevision: 0, state: firstState });
  assert.deepEqual(saved, { saved: true, revision: 1, state: firstState });

  const beforeConflict = fs.statSync(store.file, { bigint: true });
  const rejected = await store.saveUiState({ expectedRevision: 0, state: { filters: { agent: 'codex' } } });
  assert.deepEqual(rejected, { saved: false, conflict: true, revision: 1, state: firstState });
  assert.equal(fs.statSync(store.file, { bigint: true }).ino, beforeConflict.ino);
  assert.deepEqual((await store.getUiState()), { revision: 1, state: firstState });
  assert.deepEqual((await store.load()).lists.map((list) => list.title), ['受信箱', '進行中', 'レビュー', '完了', '作業中']);
});

test('simultaneous shared view state writes accept only one writer for a revision', async () => {
  const store = new Store(tmp());
  const outcomes = await Promise.all([
    store.saveUiState({ expectedRevision: 0, state: { view: 'board' } }),
    store.saveUiState({ expectedRevision: 0, state: { view: 'analytics' } }),
  ]);
  assert.equal(outcomes.filter((result) => result.saved).length, 1);
  assert.equal(outcomes.filter((result) => result.conflict).length, 1);
  assert.equal((await store.getUiState()).revision, 1);
  assert.ok(['board', 'analytics'].includes((await store.getUiState()).state.view));
});


test('native deletion removes Canban metadata and links only for the target session', async () => {
  const store = new Store(tmp());
  await store.updateCard({ cardId: 'codex:one', note: 'one' });
  await store.updateCard({ cardId: 'codex@remote:one', note: 'remote' });
  const task = await store.createTask({ title: 'owner' });
  await store.linkSession({ taskId: task.cardId, sessionId: 'codex:one' });
  await store.removeSessionMetadata('codex:one');
  const state = await store.load();
  assert.equal(state.cards['codex:one'], undefined);
  assert.equal(state.cards['codex@remote:one'].note, 'remote');
  assert.deepEqual(state.cards[task.cardId].links, []);
});

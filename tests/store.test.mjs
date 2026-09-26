import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sk-store-'));

test('default board has four lists and inbox as default', () => {
  const s = new Store(tmp()).load();
  assert.deepEqual(s.lists.map((l) => l.id), ['inbox', 'doing', 'review', 'done']);
  assert.equal(s.defaultListId, 'inbox');
});

test('create / rename / reorder / delete lists', async () => {
  const store = new Store(tmp());
  const list = await store.createList({ title: '保留' });
  assert.equal(store.load().lists.at(-1).title, '保留');
  await store.updateList({ listId: list.id, title: '保留中', wipLimit: 3, color: 'red' });
  const updated = store.load().lists.find((l) => l.id === list.id);
  assert.equal(updated.title, '保留中');
  assert.equal(updated.wipLimit, 3);
  assert.equal(updated.color, 'red');
  await store.reorderLists({ listIds: [list.id, 'inbox'] });
  assert.deepEqual(store.load().lists.map((l) => l.id).slice(0, 2), [list.id, 'inbox']);

  await store.moveCard({ cardId: 'codex:a', toListId: list.id, order: 5 });
  const res = await store.deleteList({ listId: list.id, moveCardsTo: 'review' });
  assert.equal(res.moved, 1);
  const st = store.load();
  assert.ok(!st.lists.some((l) => l.id === list.id));
  assert.equal(st.cards['codex:a'].listId, 'review');
  assert.equal(st.cards['codex:a'].order, undefined);
});

test('deleting the default list moves default to first remaining list', async () => {
  const store = new Store(tmp());
  await store.deleteList({ listId: 'inbox' });
  assert.equal(store.load().defaultListId, 'doing');
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
  let c = store.load().cards['claude:x'];
  assert.deepEqual(c.labels, ['lbl-bug']);
  assert.equal(c.note, 'memo');
  assert.equal(c.priority, 'high');
  await store.deleteLabel({ labelId: 'lbl-bug' });
  c = store.load().cards['claude:x'];
  assert.deepEqual(c.labels, []);
  const l = await store.createLabel({ name: '急ぎ', color: 'orange' });
  assert.ok(store.load().labels.some((x) => x.id === l.id));
});

test('corrupt store is backed up and replaced by defaults', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'board.json'), '{broken');
  const s = new Store(dir).load();
  assert.equal(s.lists.length, 4);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('board.json.corrupt-')));
});

test('launch settings are validated and persisted', async () => {
  const store = new Store(tmp());
  assert.deepEqual(store.load().settings.launch, { route: 'desktop', terminal: 'terminal', target: 'new-window' });
  await store.updateLaunchSettings({ route: 'terminal', terminal: 'ghostty', target: 'split' });
  assert.deepEqual(store.load().settings.launch, { route: 'terminal', terminal: 'ghostty', target: 'split' });
  await store.updateLaunchSettings({ target: 'bogus' });
  assert.equal(store.load().settings.launch.target, 'new-window');
});

test('remote hosts are opt-in', async () => {
  const store = new Store(tmp());
  assert.deepEqual(store.load().remoteHosts, {});
  await store.setRemoteHost({ hostId: 'remote-ssh-discovered:box', enabled: true });
  assert.equal(store.load().remoteHosts['remote-ssh-discovered:box'].enabled, true);
  await assert.rejects(store.setRemoteHost({ hostId: 'local', enabled: true }), /ホスト/);
});

test('concurrent mutations are serialized and none are lost', async () => {
  const store = new Store(tmp());
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.moveCard({ cardId: `codex:${i}`, toListId: 'doing', order: i })));
  const cards = store.load().cards;
  assert.equal(Object.keys(cards).length, 20);
});

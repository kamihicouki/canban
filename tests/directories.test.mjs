import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, resolveDirectory } from '../server/store.mjs';
import { computeStats } from '../server/stats.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sk-dir-'));

test('directories: create / rename / paths / delete clears assignments', async () => {
  const store = new Store(tmp());
  const web = await store.createDirectory({ name: 'Web', color: 'blue', paths: ['/r/web/', 'relative', '/r/web'] });
  assert.deepEqual(web.paths, ['/r/web']);
  await assert.rejects(store.createDirectory({ name: 'Web' }), /既にあります/);
  await assert.rejects(store.createDirectory({ name: '  ' }), /カテゴリ名/);
  await store.updateDirectory({ directoryId: web.id, name: 'Frontend', color: 'nope' });
  let d = store.load().directories[0];
  assert.equal(d.name, 'Frontend');
  assert.equal(d.color, null);

  await store.updateCard({ cardId: 'codex:a', directory: web.id });
  await store.updateCard({ cardId: 'codex:b', directory: 'dir-missing' });
  await store.updateCard({ cardId: 'codex:c', directory: '__none' });
  let s = store.load();
  assert.equal(s.cards['codex:a'].directoryId, web.id);
  assert.equal(s.cards['codex:b'].directoryId, undefined);
  assert.equal(s.cards['codex:c'].directoryId, '__none');
  await store.updateCard({ cardId: 'codex:a', directory: null });
  assert.equal(store.load().cards['codex:a'].directoryId, undefined);

  await store.updateCard({ cardId: 'codex:a', directory: web.id });
  await store.deleteDirectory({ directoryId: web.id });
  s = store.load();
  assert.equal(s.directories.length, 0);
  assert.equal(s.cards['codex:a'].directoryId, undefined);
});

test('resolveDirectory: explicit wins, then the longest path prefix; __none opts out', () => {
  const state = {
    directories: [
      { id: 'd1', name: 'Repo', paths: ['/r'] },
      { id: 'd2', name: 'Web', paths: ['/r/web'] },
      { id: 'd3', name: 'Other', paths: [] },
    ],
  };
  assert.equal(resolveDirectory(state, null, '/r/web/src')?.id, 'd2');
  assert.equal(resolveDirectory(state, null, '/r/api')?.id, 'd1');
  assert.equal(resolveDirectory(state, null, '/rx'), null);
  assert.equal(resolveDirectory(state, { directoryId: 'd3' }, '/r/web')?.id, 'd3');
  assert.equal(resolveDirectory(state, { directoryId: '__none' }, '/r/web'), null);
  assert.equal(resolveDirectory(state, { directoryId: 'gone' }, '/r/web')?.id, 'd2');
});

test('stats: directory breakdown and filter', () => {
  const now = Date.parse('2026-09-27T00:00:00Z');
  const state = { lists: [], cards: { 'claude:x': { directoryId: 'd1' } }, directories: [{ id: 'd1', name: 'Mine', paths: [] }] };
  const sessions = [
    { id: 'claude:x', agent: 'claude', cwd: '/a', createdAt: now - 1000, tokens: 5 },
    { id: 'codex:y', agent: 'codex', cwd: '/b', createdAt: now - 1000, tokens: 7 },
  ];
  const st = computeStats(state, sessions, { days: 7, now });
  assert.deepEqual(st.directories.map((r) => [r.name, r.sessions]).sort(), [['Mine', 1], ['（なし）', 1]]);
  assert.equal(computeStats(state, sessions, { days: 7, now, directory: 'd1' }).totals.sessions, 1);
  assert.equal(computeStats(state, sessions, { days: 7, now, directory: '__none' }).totals.tokens, 7);
});

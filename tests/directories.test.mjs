import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, resolveDirectory } from '../server/store.mjs';
import { normalizeClaudeSummary } from '../server/sources/claude.mjs';
import { computeStats } from '../server/stats.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sk-dir-'));

test('directories: create / rename / paths / delete clears assignments', async () => {
  const store = new Store(tmp());
  const web = await store.createDirectory({ name: 'Web', color: 'blue', paths: ['/r/web/', 'relative', '/r/web'] });
  assert.deepEqual(web.paths, ['/r/web']);
  await assert.rejects(store.createDirectory({ name: 'Web' }), /既にあります/);
  await assert.rejects(store.createDirectory({ name: '  ' }), /カテゴリ名/);
  await store.updateDirectory({ directoryId: web.id, name: 'Frontend', color: 'nope' });
  let d = (await store.load()).directories[0];
  assert.equal(d.name, 'Frontend');
  assert.equal(d.color, null);

  await store.updateCard({ cardId: 'codex:a', directory: web.id });
  await store.updateCard({ cardId: 'codex:b', directory: 'dir-missing' });
  await store.updateCard({ cardId: 'codex:c', directory: '__none' });
  let s = (await store.load());
  assert.equal(s.cards['codex:a'].directoryId, web.id);
  assert.equal(s.cards['codex:b'].directoryId, undefined);
  assert.equal(s.cards['codex:c'].directoryId, '__none');
  await store.updateCard({ cardId: 'codex:a', directory: null });
  assert.equal((await store.load()).cards['codex:a'].directoryId, undefined);

  await store.updateCard({ cardId: 'codex:a', directory: web.id });
  await store.deleteDirectory({ directoryId: web.id });
  s = (await store.load());
  assert.equal(s.directories.length, 0);
  assert.equal(s.cards['codex:a'].directoryId, undefined);
});

test('resolveDirectory: explicit wins, then the longest path prefix; __none opts out', async () => {
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

test('stats: directory breakdown and filter', async () => {
  const now = Date.parse('2026-09-27T00:00:00Z');
  const state = { lists: [], cards: { 'claude:x': { directoryId: 'd1' } }, directories: [{ id: 'd1', name: 'Mine', paths: [] }] };
  const sessions = [
    { id: 'claude:x', agent: 'claude', cwd: '/a', createdAt: now - 1000, tokens: 5 },
    { id: 'codex:y', agent: 'codex', cwd: '/b', createdAt: now - 1000, tokens: 7 },
  ];
  const st = computeStats(state, sessions, { days: 7, now });
  assert.deepEqual(st.directories.map((r) => [r.name, r.sessions]).sort(), [['Mine', 1], ['カテゴリ無し', 1]]);
  assert.equal(computeStats(state, sessions, { days: 7, now, directory: 'd1' }).totals.sessions, 1);
  assert.equal(computeStats(state, sessions, { days: 7, now, directory: '__none' }).totals.tokens, 7);
});

test('source categories persist, keep manual names, and respect explicit category-less overrides', async () => {
  const root = tmp(), store = new Store(root);
  try {
    const sources = [
      {id:'codex:1',agent:'codex',cwd:'/r/web',codexProject:{id:'p1',name:'Product'}},
      {id:'codex:2',agent:'codex',cwd:'/r/web',project:'web',codexProject:null},
      {id:'claude:1',agent:'claude',cwd:'/r/api',claudeGroup:{id:'g1',name:'Team'}},
      {id:'claude:2',agent:'claude',cwd:'/r/api'},
    ];
    await store.createDirectory({name:'Legacy',paths:['/r']});
    assert.equal(await store.syncSessionCategories(sources),true);
    assert.equal(await store.syncSessionCategories(sources),false);
    let state = await store.load();
    const resolve = (session, card = null) => resolveDirectory(state,card,session.cwd,session);
    assert.equal(resolve(sources[0]).name,'Product');
    assert.equal(resolve(sources[1]),null); // Codex folder/path does not substitute for project.
    assert.equal(resolve(sources[2]).name,'Team'); assert.equal(resolve(sources[3]).name,'api');
    const id = resolve(sources[0]).id;
    await store.updateDirectory({directoryId:id,name:'Renamed'});
    await store.syncSessionCategories(sources);
    state = await store.load(); assert.equal(resolve(sources[0]).name,'Renamed');
    await store.updateCard({cardId:sources[0].id,directory:'__none'});
    state = await store.load(); assert.equal(resolve(sources[0],state.cards[sources[0].id]),null);
    await store.updateCard({cardId:sources[1].id,directory:id});
    state = await store.load(); assert.equal(resolve(sources[1],state.cards[sources[1].id]).id,id);
    assert.equal(state.directories.length,4); assert.ok(state.directories.find(d=>d.id===id).sourceKeys.length);
    await store.deleteDirectory({directoryId:id});
    assert.equal(await store.syncSessionCategories(sources),false, 'deleted source category does not immediately reappear');
    state = await store.load(); assert.equal(resolve(sources[0]),null);
  } finally { await store.close(); fs.rmSync(root,{recursive:true,force:true}); }
});
test('Claude group metadata is normalized while absent groups use the cwd category', () => {
  const summary = {sessionId:'test',cwd:'/r/api',turns:1,prompts:['hello']};
  assert.deepEqual(normalizeClaudeSummary(summary,{group:{id:'g1',name:'Team'}}).claudeGroup,{id:'g1',name:'Team'});
  assert.equal(normalizeClaudeSummary(summary,{groupName:'Team',groupId:'g1'}).claudeGroup.name,'Team');
  assert.equal(normalizeClaudeSummary(summary,{chromeTabGroupId:'tabs'}).claudeGroup,null);
});

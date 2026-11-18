import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../ui/lanes.js', import.meta.url), 'utf8');
function lanesFor(cards, directories = [], mode = 'directory', extra = {}) {
  const board = { lists: [{ id: 'inbox', cards: cards.map(card => ({ labels: [], ...card })) }], labels: [], directories, hosts: [], projects: [], ...extra };
  const api = vm.runInNewContext(`${source}\n({ buildLanes, laneIdForCard, laneKey })`, {
    T: { category: 'カテゴリ', taskCard: 'タスクカード' }, state: { board }, store: { get: (_key, fallback) => fallback },
    STATUS_LABELS: { running: '実行中', waiting: '入力待ち', aborted: '中断', completed: '応答済み', idle: '待機中' },
    SOURCE_AXES: {},
    SOURCE_LEGACY_AXES: {},
    isSourceAxis: () => false,
  });
  return { ...api, board, lanes: api.buildLanes(board, mode) };
}

function checkLane(result, key, name, ids, directory) {
  const lane = result.lanes.find(item => item.key === key);
  assert.ok(lane);
  assert.equal(lane.name, name);
  assert.equal(lane.count, ids.length);
  assert.equal(lane.creation.directory, directory);
  assert.deepEqual(Array.from(lane.lists[0].cards, card => card.id), ids);
  for (const card of lane.lists[0].cards) {
    assert.equal(result.laneIdForCard(card, 'directory', result.board), key);
    assert.equal(result.laneKey(card, 'directory'), name);
  }
}

test('手動カテゴリは元リポジトリ名による自動分類より優先する', () => {
  const manual = { id: 'manual', name: '手動' };
  const result = lanesFor([{ id: 'a', directory: manual, repoName: 'pair-match' }], [manual, { id: 'pair', name: 'pair-match' }]);
  checkLane(result, '["directory","manual"]', '手動', ['a'], 'manual');
});

test('__none を明示したカードと元リポジトリ不明のカードはカテゴリ無しに集まる', () => {
  const result = lanesFor([
    { id: 'a', directoryId: '__none', repoName: 'pair-match' },
    { id: 'b', project: 'outside-of-project' }, { id: 'c' },
  ], [{ id: 'pair', name: 'pair-match' }]);
  checkLane(result, '["directory","__none"]', 'カテゴリ無し', ['a', 'b', 'c'], '__none');
  assert.equal(result.lanes.filter(lane => lane.count).length, 1);
});

test('未設定カードは空白と大文字小文字を無視して同名既存カテゴリへ合流し重複しない', () => {
  const directory = { id: 'pair', name: ' pair-match ', color: 'blue' };
  const result = lanesFor([
    { id: 'manual', directory }, { id: 'auto', repoName: 'PAIR-MATCH', project: '別名' },
    { id: 'legacy', project: ' pair-match ' },
  ], [directory]);
  checkLane(result, '["directory","pair"]', ' pair-match ', ['manual', 'auto', 'legacy'], 'pair');
  assert.equal(result.lanes.length, 2);
  assert.equal(result.lanes.find(lane => lane.key === '["directory","pair"]').color, 'blue');
});

const plain = (value) => JSON.parse(JSON.stringify(value));

test('未登録リポジトリはエージェントやworktreeにかかわらず同じ未分類レーンに集まる', () => {
  const result = lanesFor([
    { id: 'codex', agent: 'codex', repoName: 'new-repo', worktreeName: 'feature-a' },
    { id: 'claude', agent: 'claude', repoName: 'new-repo', worktreeName: 'feature-b' },
    { id: 'gemini', agent: 'gemini', project: 'new-repo' },
  ]);
  const lane = result.lanes.find(item => item.key === '["directory","auto:new-repo"]');
  assert.ok(lane);
  assert.equal(lane.name, '未分類（new-repo）');
  assert.deepEqual(plain(lane.creation), { directory: null, context: { repo: 'new-repo' } });
  assert.deepEqual(Array.from(lane.lists[0].cards, card => card.id), ['codex', 'claude', 'gemini']);
  assert.equal(result.lanes.filter(item => item.count).length, 1);
});

test('横断軸 worktree / dirName / host(クラウド含む) / status が全エージェントを正しくレーン分けする', () => {
  const cards = [
    { id: 'wt1', agent: 'codex', repoName: 'canban', worktreeName: 'feat-a', cwd: '/tmp/wt/feat-a', status: 'running' },
    { id: 'main1', agent: 'antigravity', repoName: 'canban', worktreeName: null, cwd: '/Users/d/repo/canban', status: 'waiting' },
    { id: 'cloud1', agent: 'codex', environmentKey: 'cloud', surface: 'cloud', status: 'idle', statusKnown: false },
    { id: 'ssh1', agent: 'claude', host: { id: 'gpu1', label: 'GPU Server' }, cwd: '/srv/app/worker', status: 'completed' },
  ];

  const wtLanes = lanesFor(cards, [], 'worktree').lanes;
  assert.deepEqual(plain(wtLanes.filter(l => l.count).map(l => l.name)), ['canban / feat-a', 'canban（メイン）', 'worker（メイン）', '（ワークツリーなし）']);
  assert.deepEqual(plain(wtLanes[0].lists[0].cards.map(c => c.id)), ['wt1']);
  assert.deepEqual(plain(wtLanes[1].lists[0].cards.map(c => c.id)), ['main1']);

  const dnLanes = lanesFor(cards, [], 'dirName').lanes;
  assert.ok(dnLanes.some(l => l.name === 'feat-a' && l.count === 1));
  assert.ok(dnLanes.some(l => l.name === 'canban' && l.count === 1));
  assert.ok(dnLanes.some(l => l.name === 'worker' && l.count === 1));

  const envLanes = lanesFor(cards, [], 'host', {
    cloudCount: 1,
    hosts: [
      { id: 'local', local: true },
      { id: 'gpu1', label: 'GPU Server' },
      { id: 'cloud-host-1', label: 'Codex Cloud', cloud: true },
    ],
  }).lanes;
  assert.deepEqual(plain(envLanes.map(l => l.name)), ['このマシン', 'クラウド', 'GPU Server']);
  assert.deepEqual(plain(envLanes.find(l => l.name === 'クラウド').lists[0].cards.map(c => c.id)), ['cloud1']);
  assert.deepEqual(plain(envLanes.find(l => l.name === 'GPU Server').lists[0].cards.map(c => c.id)), ['ssh1']);
  assert.deepEqual(plain(envLanes.find(l => l.name === 'このマシン').lists[0].cards.map(c => c.id)), ['wt1', 'main1']);

  const stLanes = lanesFor(cards, [], 'status').lanes;
  assert.deepEqual(plain(stLanes.map(l => l.name)), ['実行中', '入力待ち', '中断', '応答済み', '待機中', '状態未取得']);
  assert.deepEqual(plain(stLanes[0].lists[0].cards.map(c => c.id)), ['wt1']);
  assert.deepEqual(plain(stLanes[5].lists[0].cards.map(c => c.id)), ['cloud1']);
});

test('保存済み antigravityBrain レーンは別々の Brain ごとにレーン分けを維持する', () => {
  const facetsSource = fs.readFileSync(new URL('../ui/source-facets.js', import.meta.url), 'utf8');
  const lanesSource = fs.readFileSync(new URL('../ui/lanes.js', import.meta.url), 'utf8');
  const makeObs = (nativeId, name) => ({
    status: 'known',
    ref: { provider: 'antigravity', identityDomain: 'app-storage', scopeId: '/tmp/brain', kind: 'brain', nativeId },
    name,
    observedAt: 1000,
    source: 'antigravity-brain',
  });
  const cards = [
    { id: 'antigravity:b1', agent: 'antigravity', project: 'same-proj', labels: [], sourceView: { compact: false, relations: [{ type: 'memberOf', ref: makeObs('brain-1', 'Alpha Brain').ref, observation: { value: makeObs('brain-1', 'Alpha Brain') } }] } },
    { id: 'antigravity:b2', agent: 'antigravity', project: 'same-proj', labels: [], sourceView: { compact: false, relations: [{ type: 'memberOf', ref: makeObs('brain-2', 'Beta Brain').ref, observation: { value: makeObs('brain-2', 'Beta Brain') } }] } },
  ];
  const board = { lists: [{ id: 'inbox', cards }], labels: [], directories: [], hosts: [], projects: [], sourceFacets: [] };
  const api = vm.runInNewContext(`${facetsSource}\n${lanesSource}\n({ buildLanes, laneIdForCard })`, {
    T: { category: 'カテゴリ', taskCard: 'タスクカード' },
    state: { board },
    store: { get: (_k, d) => d },
    STATUS_LABELS: { running: '実行中', waiting: '入力待ち', aborted: '中断', completed: '応答済み', idle: '待機中' },
  });
  const lanes = api.buildLanes(board, 'antigravityBrain').filter(l => l.count);
  assert.equal(lanes.length, 2);
  assert.deepEqual(plain(lanes.map(l => l.name)).sort(), ['Alpha Brain', 'Beta Brain']);
  assert.notEqual(api.laneIdForCard(cards[0], 'antigravityBrain', board), api.laneIdForCard(cards[1], 'antigravityBrain', board));
});

test('明示した repo:null / dirName:null は旧 project やディレクトリで補完せず不明/なしレーンへ分ける', () => {
  const card = { id: 'explicit-no-repo', kind: 'task', project: 'Named App Project', context: { project: 'Named App Project', repo: null, dirName: null } };
  assert.equal(lanesFor([card], [{ id: 'named', name: 'Named App Project' }], 'repo').lanes.find(l => l.count)?.name, '（リポジトリ不明）');
  assert.equal(lanesFor([card], [], 'worktree').lanes.find(l => l.count)?.name, '（ワークツリーなし）');
  assert.equal(lanesFor([card], [], 'dirName').lanes.find(l => l.count)?.name, '（ディレクトリなし）');
  assert.equal(lanesFor([card], [{ id: 'named', name: 'Named App Project' }], 'directory').lanes.find(l => l.count)?.name, 'カテゴリ無し');
});

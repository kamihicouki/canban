import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../ui/lanes.js', import.meta.url), 'utf8');
function lanesFor(cards, directories = []) {
  const board = { lists: [{ id: 'inbox', cards: cards.map(card => ({ labels: [], ...card })) }], labels: [], directories };
  const api = vm.runInNewContext(`${source}\n({ buildLanes, laneIdForCard, laneKey })`, {
    T: { category: 'カテゴリ' }, state: { board }, store: { get: (_key, fallback) => fallback },
  });
  return { ...api, board, lanes: api.buildLanes(board, 'directory') };
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

test('未登録リポジトリはエージェントやworktreeにかかわらず同じ未分類レーンに集まる', () => {
  const result = lanesFor([
    { id: 'codex', agent: 'codex', repoName: 'new-repo', worktreeName: 'feature-a' },
    { id: 'claude', agent: 'claude', repoName: 'new-repo', worktreeName: 'feature-b' },
    { id: 'gemini', agent: 'gemini', project: 'new-repo' },
  ]);
  checkLane(result, '["directory","auto:new-repo"]', '未分類（new-repo）', ['codex', 'claude', 'gemini'], 'auto:new-repo');
  assert.equal(result.lanes.filter(lane => lane.count).length, 1);
});

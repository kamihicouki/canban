import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../ui/sidebar-categories.js', import.meta.url), 'utf8');
const model = vm.runInNewContext(`${source}\n({ categoryNavigation, toggleCategoryPin, openCategoryPicker });`, { state: { board: {} }, laneHides: () => true, document: { querySelector: () => { throw new Error('category filter must not open for its own lane axis'); } } });
const plain = value => JSON.parse(JSON.stringify(value));
const dirs = Array.from({ length: 30 }, (_, i) => ({ id: `d${i}`, name: `カテゴリ${i}`, count: i }));
test('defaults show five categories and keep an unpinned selection visible', () => {
  assert.deepEqual(plain(model.categoryNavigation(dirs, null, 'd29')).map(d => d.id), ['d0','d1','d2','d3','d4','d29']);
});
test('explicit pins preserve order and permit an empty set', () => {
  assert.deepEqual(plain(model.categoryNavigation(dirs, ['d8','missing','d2','d8'], '')).map(d => d.id), ['d8','d2']);
  assert.equal(model.categoryNavigation(dirs, [], '').length, 0);
});
test('pinning defaults and removing a pin do not change the source categories', () => {
  const pins = model.toggleCategoryPin(dirs, null, 'd29');
  assert.deepEqual(plain(pins), ['d0','d1','d2','d3','d4','d29']);
  assert.deepEqual(plain(model.toggleCategoryPin(dirs, pins, 'd2')), ['d0','d1','d3','d4','d29']);
  assert.equal(dirs.length, 30);
});
test('zero-count and uncategorized entries remain selectable and pinnable', () => {
  const list = [...dirs, { id: '__none', name: 'カテゴリ無し', count: 0 }];
  assert.deepEqual(plain(model.toggleCategoryPin(list, [], '__none')), ['__none']);
  assert.equal(model.categoryNavigation(list, ['d0'], '')[0].count, 0);
});

test('a category lane cannot open a hidden category filter', () => {
  assert.equal(model.openCategoryPicker({}), undefined);
});

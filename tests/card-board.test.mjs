import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../ui/card-overlay-model.js', import.meta.url), 'utf8');
const model = vm.runInNewContext(`${source}\n({ normalizeCardBoard, cardBoardGeometry, fitShortcutMap });`);
const plain = value => JSON.parse(JSON.stringify(value));

test('card board saves 1:8:1 by default and shows the key legend in a gutter of at least 216px on the right', () => {
  const state = plain(model.normalizeCardBoard(null));
  assert.deepEqual(state, { left: .1, right: .1, shortcut: { side: 'right', x: 0, y: .1 } });
  assert.deepEqual(plain(model.cardBoardGeometry(state, 1280)), { left: 128, right: 216, width: 936 }); // the legend's gutter never goes below 216px
  assert.deepEqual(plain(model.normalizeCardBoard(state)), state);
});
test('saved ratios and shortcut coordinates are bounded, with usable space left for cards', () => {
  const invalid = plain(model.normalizeCardBoard({ left: NaN, right: 'wide', shortcut: { side: 'other', x: Infinity, y: -20 } }));
  assert.deepEqual(invalid, { left: .1, right: .1, shortcut: { side: 'right', x: 0, y: 0 } });
  const large = model.normalizeCardBoard({ left: 100, right: 100 });
  assert.ok(large.left + large.right <= .65);
  for (const side of ['left', 'right']) for (const width of [390, 800, 1280]) {
    const state = plain(model.normalizeCardBoard({ left: .4, right: .4, shortcut: { side } }));
    const before = structuredClone(state), geometry = model.cardBoardGeometry(state, width);
    assert.ok(geometry.width >= Math.min(360, width * .55) - 1e-8);
    assert.ok(geometry[side] >= Math.min(216, width * .32) - 1e-8, 'the map keeps readable space');
    assert.equal(geometry.left + geometry.width + geometry.right, width);
    assert.deepEqual(state, before, 'window resize must not replace saved proportions');
  }
});
test('changing either margin keeps the other boundary in place while space permits', () => {
  assert.deepEqual(plain(model.cardBoardGeometry({ left: .2, right: .2 }, 1280)), { left: 256, right: 256, width: 768 });
  assert.deepEqual(plain(model.cardBoardGeometry({ left: .1, right: .25 }, 1280)), { left: 128, right: 320, width: 832 });
  // The gutter that holds the key legend is at least 216px wide; the other one keeps its ratio.
  assert.deepEqual(plain(model.cardBoardGeometry({ left: .2, right: .1 }, 1280)), { left: 256, right: 216, width: 808 });
  assert.deepEqual(plain(model.cardBoardGeometry({ left: .1, right: .1, shortcut: { side: 'left' } }, 1280)), { left: 216, right: 128, width: 936 });
});
test('the shortcut map can occupy any position in either gutter and never overlap the cards', () => {
  for (const left of [0, 1000]) {
    const gutter = { left, width: 280, height: 680 }, size = { width: 112, height: 300 };
    for (const x of [-2, 0, .3, 1, 8]) for (const y of [-2, 0, .6, 1, 8]) {
      const point = model.fitShortcutMap(gutter, size, { x, y });
      assert.ok(point.x >= left + 8 && point.x + size.width <= left + gutter.width - 8);
      assert.ok(point.y >= 8 && point.y + size.height <= gutter.height - 8);
    }
    assert.deepEqual(plain(model.fitShortcutMap(gutter, size, { x: .5, y: .5 })), { x: left + 140, y: 340 });
  }
});
test('changing the number of context hints does not move the shortcut map anchor', () => {
  const gutter = { left: 1152, width: 128, height: 704 }, position = { x: 0, y: .1 };
  assert.deepEqual(plain(model.fitShortcutMap(gutter, { width: 92, height: 312 }, position)),
    plain(model.fitShortcutMap(gutter, { width: 100, height: 100 }, position)));
});

// The card board's margins follow the window: nothing to drag, nothing saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { boardHtml } from '../server/ui.mjs';
const source = fs.readFileSync(new URL('../ui/card-overlay-model.js', import.meta.url), 'utf8');
const model = vm.runInNewContext(`${source}\n({ cardBoardGeometry });`);
const plain = value => JSON.parse(JSON.stringify(value));

test('the key guide keeps a readable right margin and the cards keep the middle', () => {
  assert.deepEqual(plain(model.cardBoardGeometry(1280)), { left: 77, right: 216, width: 987 });
  for (const width of [390, 800, 1280, 2560]) {
    const g = model.cardBoardGeometry(width);
    assert.ok(g.width >= Math.min(360, width * .55) - 1e-8, `cards keep room at ${width}`);
    assert.ok(g.right <= 216 && g.left <= width * .08);
    assert.equal(g.left + g.width + g.right, width);
    assert.ok(Number.isInteger(g.left) && Number.isInteger(g.right), 'whole pixels: a fraction would read as overflow');
  }
});

test('no margin handles, no movable key guide, no saved card board', () => {
  const html = boardHtml();
  assert.doesNotMatch(html, /card-board-margin|shortcut-map-grip|cardBoardState|resetCardBoard/);
  assert.doesNotMatch(html, /SHARED_UI_KEYS = \[[^\]]*'cardBoard'/);
  assert.match(html, /class: 'shortcut-map-title', text: 'キーの案内'/);
});

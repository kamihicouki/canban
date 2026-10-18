// The card board's margins follow the window and make room for the key guide where it is docked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { boardHtml } from '../server/ui.mjs';
const source = fs.readFileSync(new URL('../ui/card-overlay-model.js', import.meta.url), 'utf8');
const model = vm.runInNewContext(`${source}\n({ cardBoardGeometry, normalizeKeyGuide, keyGuideDockAt, keyGuideStep, KEY_GUIDE_DOCKS });`);
const plain = value => JSON.parse(JSON.stringify(value));

test('the key guide keeps a readable right margin and the cards keep the middle', () => {
  assert.deepEqual(plain(model.cardBoardGeometry(1280)), { left: 77, right: 216, width: 987 });
  for (const width of [390, 800, 1280, 2560]) {
    for (const reserve of [undefined, { right: 0 }, { left: 480, right: 0 }]) {
      const g = model.cardBoardGeometry(width, reserve);
      assert.ok(g.width >= Math.min(360, width * .55) - 1e-8, `cards keep room at ${width}`);
      assert.ok(g.right <= 216 && g.left <= Math.ceil(width * .32));
      assert.equal(g.left + g.width + g.right, width);
      assert.ok(Number.isInteger(g.left) && Number.isInteger(g.right), 'whole pixels: a fraction would read as overflow');
    }
  }
  const strip = model.cardBoardGeometry(1280, { right: 0 });
  assert.equal(strip.left, strip.right, 'docked along the foot (or folded), the card sits in the middle');
  assert.ok(model.cardBoardGeometry(1280, { left: 300, right: 0 }).left >= 300, 'docked bottom left, the cards stay clear of it');
});

test('the key guide docks where it is dropped and walks the docks with the arrows', () => {
  assert.deepEqual(plain(model.normalizeKeyGuide(null)), { dock: 'bottom', min: false });
  assert.deepEqual(plain(model.normalizeKeyGuide({ dock: 'tl', min: 'yes' })), { dock: 'bottom', min: false });
  assert.deepEqual(plain(model.normalizeKeyGuide({ dock: 'bl', min: true })), { dock: 'bl', min: true });
  assert.equal(model.keyGuideDockAt(.5, .95), 'bottom');
  assert.equal(model.keyGuideDockAt(.1, .1), 'tr', 'the top left is the navigation’s: the top is the right');
  assert.equal(model.keyGuideDockAt(.9, .2), 'tr');
  assert.equal(model.keyGuideDockAt(.9, .7), 'br');
  assert.equal(model.keyGuideDockAt(.1, .9), 'bl');
  let dock = 'tr';
  const seen = [];
  for (const _ of model.KEY_GUIDE_DOCKS) seen.push(dock = model.keyGuideStep(dock, 1));
  assert.deepEqual(seen, ['br', 'bottom', 'bl', 'tr']);
  assert.equal(model.keyGuideStep('tr', -1), 'bl');
});

test('one key guide for the board, the timeline and the card; its place is shared UI state', () => {
  const html = boardHtml();
  assert.doesNotMatch(html, /card-board-margin|cardBoardState|resetCardBoard|board-shortcuts|shortcut-map/);
  assert.doesNotMatch(html, /SHARED_UI_KEYS = \[[^\]]*'cardBoard'/);
  assert.match(html, /SHARED_UI_KEYS = \[[^\]]*'keyGuide'/);
  assert.match(html, /class: 'kg-title', text: 'キーの案内'/);
  assert.equal(html.match(/class: 'key-guide'/g)?.length, 1);
});

test('the timeline docks the card itself on its right instead of a preview of its own', () => {
  const html = boardHtml();
  const inbox = html.slice(html.indexOf('// 時間軸: the board by time'), html.indexOf('function inboxExpand'));
  assert.doesNotMatch(inbox, /peekContent|canban_get_session/, 'the card loads itself, as in the overlay');
  assert.match(inbox, /openCard\(state\.inbox\.sel, \{ dock: true \}\)/);
  assert.match(html, /const paneDocked = \(\) =>/);
  assert.match(html, /\.pane-layer\.docked \{/);
});

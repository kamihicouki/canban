import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture({ timeline = true, docked = true, visible = true } = {}) {
  const source = fs.readFileSync(new URL('../ui/inbox.js', import.meta.url), 'utf8');
  const feed = { scrollTop: 100 };
  const calls = [];
  const context = {
    state: { inbox: { sel: 'a' } }, panes: [{ id: 'a', feed }], paneLayer: { hidden: !visible },
    inboxOn: () => timeline, paneDocked: () => docked, inboxRows: () => [],
    $: selector => selector === '#board .inbox-main' ? {} : null, CSS: { escape: value => value },
    findCard: () => ({}), paneMetrics: () => calls.push('metrics'),
    closeCards: () => calls.push('close'), openCard: () => calls.push('open'),
  };
  vm.runInNewContext(source.slice(source.indexOf('function syncDockedCard()')), context);
  return { ...context, feed, calls };
}

test('timeline redraw keeps the existing docked conversation and its reading position', () => {
  const f = fixture(); f.syncDockedCard();
  assert.equal(f.panes[0].feed, f.feed);
  assert.equal(f.feed.scrollTop, 100);
  assert.deepEqual(f.calls, ['metrics']);
});
test('selecting the same timeline row does not recreate the conversation', () => {
  const f = fixture(); f.inboxSelect('a');
  assert.equal(f.panes[0].feed, f.feed);
  assert.equal(f.feed.scrollTop, 100);
  assert.deepEqual(f.calls, []);
});
test('returning to the board closes the docked card but keeps a large overlay open', () => {
  for (const docked of [true, false]) {
    const f = fixture({ timeline: false, docked }); f.syncDockedCard();
    assert.deepEqual(f.calls, docked ? ['close'] : []);
  }
});
test('a redraw does not replace a card opened large while the timeline is visible', () => {
  const f = fixture({ docked: false }); f.syncDockedCard();
  assert.equal(f.panes[0].feed, f.feed);
  assert.deepEqual(f.calls, []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { boardHtml } from '../server/ui.mjs';
const source = fs.readFileSync(new URL('../ui/card-board.js', import.meta.url), 'utf8');
const router = source.slice(source.indexOf('function handleCardBoardKey'), source.indexOf("document.addEventListener('keydown', handleCardBoardKey)"));
function fixture({ overlay = true, typing = false, upper = false } = {}) {
  const calls = [];
  const context = vm.createContext({ paneLayer: { hidden: !overlay }, typingIn: () => typing,
    document: { querySelector: () => upper }, cardBoardHandles: {
      left: { focus: () => calls.push('left') }, right: { focus: () => calls.push('right') } },
    shortcutMapGrip: { focus: () => calls.push('map') }, resetCardBoard: () => calls.push('reset') });
  vm.runInContext(router, context);
  return { calls, press(key, extra = {}) {
    const e = { key, target: {}, preventDefault() { this.defaultPrevented = true; }, ...extra };
    context.handleCardBoardKey(e); return e;
  } };
}
test('card board adjustments preserve the established pane and card action keys', () => {
  const f = fixture();
  for (const key of ['[', ']', 'm']) assert.equal(f.press(key).defaultPrevented, undefined);
  f.press('[', { altKey: true }); f.press(']', { altKey: true }); f.press('m', { altKey: true }); f.press('0');
  assert.deepEqual(f.calls, ['left', 'right', 'map', 'reset']);
});
test('Option character translation on macOS still resolves physical shortcut keys', () => {
  const f = fixture();
  f.press('“', { altKey: true, code: 'BracketLeft' });
  f.press('‘', { altKey: true, code: 'BracketRight' });
  f.press('µ', { altKey: true, code: 'KeyM' });
  assert.deepEqual(f.calls, ['left', 'right', 'map']);
});
test('card board keys respect input, IME, higher layers and handled events', () => {
  for (const options of [{ overlay: false }, { typing: true }, { upper: true }]) {
    const f = fixture(options); f.press('m', { altKey: true }); f.press('0'); assert.deepEqual(f.calls, []);
  }
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
    const f = fixture(); f.press('m', { altKey: true, ...extra }); f.press('0', extra); assert.deepEqual(f.calls, []);
  }
});

const boardSource = boardHtml();
const stepSource = boardSource.slice(boardSource.indexOf('async function stepOpenCard'), boardSource.indexOf('const focusedPane ='));
test('browsing a linked session makes it the root instead of only refreshing its pane', async () => {
  const calls = [], cards = ['codex:a', 'task:b', 'codex:c'].map(id => ({ dataset: { cardId: id }, scrollIntoView() {} }));
  const context = vm.createContext({ panes: [{ id: 'task:b', kind: 'task' }, { id: 'codex:a' }],
    displayedListCards: () => cards, neighborCardId: (ids, id, step) => ids[ids.indexOf(id) + step],
    toast: text => calls.push(['toast', text]), cardReturn: null, paneStage: { scrollLeft: 900 },
    showCards: ids => { calls.push(['show', ...ids]); context.panes = ids.map(id => ({ id, el: { focus() {} } })); },
    openCard: async id => calls.push(['open', id]) });
  vm.runInContext(stepSource, context);
  await context.stepOpenCard(-1);
  assert.deepEqual(calls, [['show', 'codex:a'], ['open', 'codex:a']]);
  assert.equal(context.cardReturn, cards[0]);
  assert.equal(context.paneStage.scrollLeft, 0);
  calls.length = 0; await context.stepOpenCard(-1);
  assert.equal(calls[0][0], 'toast');
  assert.equal(context.panes[0].id, 'codex:a', 'the list boundary does not cross to another list');
});

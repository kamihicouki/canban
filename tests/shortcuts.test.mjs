import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
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

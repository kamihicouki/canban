import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('a reused terminal returns keyboard focus to the current card', () => {
  const src = fs.readFileSync(new URL('../ui/card-terminal.js', import.meta.url), 'utf8');
  let handler, focused = '';
  class Terminal {
    loadAddon() {} attachCustomKeyEventHandler(fn) { handler = fn; }
    onData() {} onResize() {} blur() {}
  }
  const panel = vm.runInNewContext(src + '\nterminalPanel', {
    Terminal, FitAddon: { FitAddon: class {} },
    h: (tag, attrs) => ({ ...attrs, isConnected: false, append() {} }),
    ResizeObserver: class { observe() {} }, MutationObserver: class { observe() {} },
    document: { addEventListener() {}, documentElement: {} },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    queueMicrotask() {}, picon: () => '', keycap: () => [],
  });
  const card = label => ({ id: 'same-card', el: { focus: () => { focused = label; } } });
  panel(card('removed card'));
  panel(card('current card'));
  assert.equal(handler({ type: 'keydown', key: 'Escape', shiftKey: true, preventDefault() {} }), false);
  assert.equal(focused, 'current card');
  assert.equal(handler({ type: 'keydown', key: 'Escape', shiftKey: false }), true, 'plain Escape remains a shell key');
});

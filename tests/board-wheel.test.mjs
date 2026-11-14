import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function wheelHarness(swimlane = '') {
  const source = fs.readFileSync(new URL('../ui/keyboard.js', import.meta.url), 'utf8');
  const start = source.indexOf("$('#board').addEventListener('wheel'");
  const code = source.slice(start, source.indexOf('\nfunction selectedWorkSessionId', start));
  let handler;
  const board = { scrollLeft: 0, addEventListener: (name, callback) => { assert.equal(name, 'wheel'); handler = callback; } };
  vm.runInNewContext(code, { $: () => board, state: { filters: { swimlane } } });
  return { board, wheel(className = '', deltaX = 0, deltaY = 120) {
    const event = new Event('wheel', { cancelable: true });
    Object.defineProperties(event, {
      deltaX: { value: deltaX }, deltaY: { value: deltaY },
      target: { value: { closest: selector => selector.split(',').map(s => s.trim()).includes(`.${className}`) ? {} : null } },
    });
    handler(event);
    return event;
  } };
}

for (const name of ['inbox-list', 'gantt-list', 'cards']) {
  test(`${name} retains native vertical wheel scrolling`, () => {
    const harness = wheelHarness();
    assert.equal(harness.wheel(name).defaultPrevented, false, name);
    assert.equal(harness.board.scrollLeft, 0, name);
  });
}
test('empty Trello board space still converts vertical wheel to horizontal scrolling', () => {
  const harness = wheelHarness();
  assert.equal(harness.wheel().defaultPrevented, true);
  assert.equal(harness.board.scrollLeft, 120);
  assert.equal(harness.wheel('', 120, 0).defaultPrevented, false);
  assert.equal(harness.board.scrollLeft, 120);
  const lanes = wheelHarness('agent');
  assert.equal(lanes.wheel().defaultPrevented, false);
});

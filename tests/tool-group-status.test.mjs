import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture(count = 1) {
  const thread = fs.readFileSync(new URL('../ui/thread.js', import.meta.url), 'utf8');
  const realtime = fs.readFileSync(new URL('../ui/realtime.js', import.meta.url), 'utf8');
  const paint = thread.slice(thread.indexOf('function paintToolGroup('), thread.indexOf('// Put one item'));
  const update = realtime.slice(realtime.indexOf('function applyFeed('), realtime.indexOf('// ---- the long poll'));
  const tools = Array.from({ length: count }, () => ({ icon: { className: 'ti' }, out: { hidden: true } }));
  const classes = new Set();
  const group = { _kinds: new Map(), _list: tools, _label: { children: [], replaceChildren(...children) { this.children = children; } },
    classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } } };
  for (const tool of tools) tool.el = { closest: () => group };
  const select = selector => tools.filter(tool => selector.includes(':not') ? !/\b(ok|error)\b/.test(tool.icon.className) : /\berror\b/.test(tool.icon.className));
  const list = { querySelector() {}, childElementCount: 0 };
  const f = { list, tools: new Map(tools.map((tool, i) => [String(i), tool])) };
  const model = vm.runInNewContext(paint + update + '\n({paintToolGroup,applyFeed})', {
    h: (_tag, props) => props, TOOL_KINDS: [], TOOL_ICONS: { ok: '✓', error: '✗' },
    $$: select, $: selector => select(selector)[0], atFeedEnd: () => false,
  });
  model.paintToolGroup(group);
  return { f, tools, group, classes, update: items => model.applyFeed(f, { items, offset: 1, size: 1 }),
    running: () => group._label.children.some(el => el.class === 'tg-run') };
}

test('a later result removes the completed tool group running indicator', () => {
  const f = fixture();
  assert.equal(f.running(), true);
  f.update([{ k: 'result', ref: '0', ok: true, out: '完了' }]);
  assert.equal(f.running(), false);
  assert.equal(f.tools[0].out.textContent, '完了');
});

test('a failed result marks its existing group as an error', () => {
  const f = fixture();
  f.update([{ k: 'result', ref: '0', ok: false, out: '失敗' }]);
  assert.equal(f.classes.has('has-error'), true);
  assert.equal(f.running(), false);
});

test('a group stays running until its other pending tool completes', () => {
  const f = fixture(2);
  f.update([{ k: 'result', ref: '0', ok: true }]);
  assert.equal(f.running(), true);
  f.update([{ k: 'result', ref: '1', ok: true }]);
  assert.equal(f.running(), false);
});

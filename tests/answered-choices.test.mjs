import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture() {
  const read = name => fs.readFileSync(new URL(`../ui/${name}`, import.meta.url), 'utf8');
  const realtime = read('realtime.js'), requests = read('requests.js');
  const render = realtime.slice(realtime.indexOf('function renderFeed('), realtime.indexOf('const atFeedEnd ='));
  const update = realtime.slice(realtime.indexOf('function applyFeed('), realtime.indexOf('// ---- the long poll'));
  const choices = requests.slice(requests.indexOf('function paintChoices('), requests.indexOf('function fillChoice('));
  const node = (tag, props = {}) => ({ ...props, childNodes: [], childElementCount: 0,
    addEventListener() {}, append(...children) { this.childNodes.push(...children); },
    replaceChildren(...children) { this.childNodes = children; }, querySelector: () => null });
  let box = node('div');
  const pane = { el: { querySelector: selector => selector.includes('.cx-choices') ? box : null } };
  const live = { feeds: new Map() };
  const api = vm.runInNewContext(read('message-preview.js') + render + update + choices + '\n({renderFeed,applyFeed,paintChoices})', {
    document: { querySelector: () => null }, refreshShortcutHints() {}, h: node, live, keycap: () => [], queueMicrotask: fn => fn(), editSummary: () => ({ el: node('div') }),
    feedPush: () => true, paintFeedFoot() {}, kickLive() {}, atFeedEnd: () => false,
    refreshDispatch() {}, renderSignals: () => node('div'),
  });
  return {
    open(items, status = 'idle', preview = '') { api.renderFeed({ session: { id: 'fixture', status, preview }, feed: { items, offset: 0, size: 1 } }, pane); return live.feeds.get('fixture'); },
    update(f, items, status) { api.applyFeed(f, { items, status, offset: 1, size: 2 }); },
    replies: () => Array.from(pane.choices || [], c => c.reply),
    get box() { return box; },
    replaceBox() { box = node('div'); },
    repaint(feed) { api.paintChoices(feed); },
  };
}
const question = { k: 'assistant', text: 'この方針で進めてよいですか？' }, answer = { k: 'user', text: 'はい、お願いします。' };

test('an answered question has no choices when its conversation is first opened', () => {
  const f = fixture(); f.open([question, answer]); assert.deepEqual(f.replies(), []);
  assert.equal(f.box.hidden, true);
});
test('a live user reply removes the old question choices', () => {
  const f = fixture(), feed = f.open([question]); assert.equal(f.replies().length, 2);
  f.update(feed, [answer]); assert.deepEqual(f.replies(), []); assert.equal(f.box.hidden, true);
});
test('a new assistant question restores choices after a user reply', () => {
  const f = fixture(), feed = f.open([question, answer]); f.update(feed, [{ k: 'assistant', text: '次の調査を始めてよいですか？' }]);
  assert.deepEqual(f.replies(), ['はい。', 'いいえ。']);
});
test('tool results and turn markers do not consume an unanswered question', () => {
  const f = fixture(); f.open([question, { k: 'commentary', text: '補足' }, { k: 'tool', id: 'lookup', name: 'lookup' }, { k: 'result', ref: 'lookup', ok: true }, { k: 'turn', state: 'completed' }]);
  assert.deepEqual(f.replies(), ['はい。', 'いいえ。']);
});
test('a preview without a question in the fetched conversation cannot offer an answer', () => {
  const f = fixture(); f.open([], 'idle', question.text); assert.deepEqual(f.replies(), []);
  f.open([answer], 'idle', question.text); assert.deepEqual(f.replies(), []);
});
test('unchanged answer choices retain their button nodes on live updates', () => {
  const f = fixture(), feed = f.open([question]), button = f.box.childNodes[1];
  f.update(feed, [{ k: 'commentary', text: '補足が届きました' }]);
  assert.equal(f.box.childNodes[1], button);
  f.update(feed, [], 'idle');
  assert.equal(f.box.childNodes[1], button);
});
test('a rebuilt composer renders unchanged choices into its new box', () => {
  const f = fixture(), feed = f.open([question]);
  f.replaceBox(); f.repaint(feed);
  assert.equal(f.box.hidden, false);
  assert.equal(f.box.childNodes.length, 3);
});

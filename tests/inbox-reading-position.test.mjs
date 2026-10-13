import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture() {
  const src = fs.readFileSync(new URL('../ui/inbox.js', import.meta.url), 'utf8');
  const position = src.slice(src.indexOf('const inboxReadingPositions'), src.indexOf('function inboxRow'));
  const paint = src.slice(src.indexOf('async function paintInboxMain'));
  const main = { isConnected: true, dataset: { cardId: 'a' }, children: [], replaceChildren(...children) { this.children = children; } };
  const body = () => main.children.find(n => n.className === 'inbox-body');
  const h = (tag, props = {}, ...children) => ({ className: props.class || '', children, scrollTop: 0, scrollHeight: 1000, clientHeight: 200 });
  main.children = [h('div', { class: 'inbox-body' })];
  body().scrollTop = 100;
  const card = { id: 'a', updatedAt: 1, title: '架空の会話' };
  const state = { inbox: { sel: 'a', d: { session: card } } };
  const context = { state, h, atFeedEnd: el => el.scrollHeight - el.scrollTop - el.clientHeight < 48, findCard: () => ({ card }), faceGlyph() {}, faceWho() {}, dirPill() {}, faceStat() {}, relTime() {}, keycap: () => [], peekContent: () => [],
    $: (selector, el) => selector === '.inbox-body' ? el.children.find(n => n.className === 'inbox-body') : null };
  vm.runInNewContext((position.startsWith('const inboxReadingPositions') ? position : '') + paint + '\nthis.paint = paintInboxMain;', context);
  return { main, body, card, state, paint: () => context.paint(main) };
}

test('timeline repaint preserves the position while reading earlier messages', async () => {
  const f = fixture(); await f.paint(); assert.equal(f.body().scrollTop, 100);
});
test('timeline repaint follows the end when the reader was at the end', async () => {
  const f = fixture(); f.body().scrollTop = 800; await f.paint(); assert.equal(f.body().scrollTop, 1000);
});
test('timeline selection remembers each conversation independently', async () => {
  const f = fixture(); await f.paint(); f.card.id = 'b'; f.state.inbox.sel = 'b'; await f.paint();
  assert.equal(f.body().scrollTop, 1000);
  f.body().scrollTop = 300; f.card.id = 'a'; f.state.inbox.sel = 'a'; await f.paint(); assert.equal(f.body().scrollTop, 100);
});
test('a task preview does not overwrite the previous session position', async () => {
  const f = fixture(); await f.paint();
  f.card.id = 'task'; f.card.kind = 'task'; f.card.links = []; f.state.inbox.sel = 'task'; await f.paint();
  f.body().scrollTop = 300;
  f.card.id = 'a'; delete f.card.kind; f.state.inbox.sel = 'a'; await f.paint(); assert.equal(f.body().scrollTop, 100);
});

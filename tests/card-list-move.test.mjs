import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { boardHtml } from '../server/ui.mjs';

const html = boardHtml();
const source = html.slice(html.indexOf('function paneListId('), html.indexOf('function paintCardListControls('));
function fixture() {
  const lists = [
    { id: 'left', title: '受信箱', cards: [{ id: 'task:t', links: [{ id: 'codex:s' }] }] },
    { id: 'middle', title: '進行中', cards: [{ id: 'codex:s' }] },
    { id: 'right', title: '完了', cards: [] },
  ];
  const calls = [], messages = [];
  const context = vm.createContext({ state: { board: { lists } }, calls, messages,
    paintCardListControls() {}, refreshShortcutHints() {}, load: async () => {},
    toast: message => messages.push(message),
    act: async (name, args) => {
      calls.push({ name, args });
      const card = lists.flatMap(l => l.cards).find(c => c.id === args.cardId);
      for (const list of lists) list.cards = list.cards.filter(c => c.id !== args.cardId);
      lists.find(l => l.id === args.toList).cards.push(card);
    },
  });
  vm.runInContext(source, context);
  return { context, calls, messages, lists };
}
test('open card uses its own placement, follows list order, and stops at the ends', () => {
  const { context, lists } = fixture();
  const p = { id: 'codex:s', kind: 'session', d: { card: { listId: 'middle' } } };
  context.p = p;
  assert.equal(vm.runInContext('adjacentPaneList(p, -1).id', context), 'left');
  assert.equal(vm.runInContext('adjacentPaneList(p, 1).id', context), 'right');
  // A filtered/grouped session uses its own detail, not its parent task's list.
  lists[1].cards = [];
  assert.equal(vm.runInContext('paneListId(p)', context), 'middle');
  p.d.card.listId = 'left';
  assert.equal(vm.runInContext('adjacentPaneList(p, -1)', context), null);
  p.d.card.listId = 'right';
  assert.equal(vm.runInContext('adjacentPaneList(p, 1)', context), null);
  p.d.card.listId = 'deleted';
  assert.equal(vm.runInContext('adjacentPaneList(p, 1)', context), null);
});
test('moves a session and task without reopening or changing drafts; duplicate actions are blocked', async () => {
  for (const [id, kind, from, to] of [['codex:s', 'session', 'middle', 'right'], ['task:t', 'task', 'left', 'middle']]) {
    const { context, calls } = fixture();
    const draft = { text: '入力途中の文章' };
    context.p = { id, kind, d: { card: { listId: from } }, draft };
    const pending = vm.runInContext(`movePaneToList(p, '${to}')`, context);
    await vm.runInContext(`movePaneToList(p, '${to}')`, context);
    await pending;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.cardId, id);
    assert.equal(calls[0].args.toList, to);
    assert.equal(calls[0].args.position, 'top');
    assert.equal(context.p.d.card.listId, to);
    assert.equal(context.p.draft, draft);
    assert.equal(context.p.movingList, false);
    await vm.runInContext(`movePaneToList(p, '${to}')`, context);
    assert.equal(calls.length, 1);
  }
});
test('failed moves keep the original placement and release the pending lock without a success toast', async () => {
  const { context, messages } = fixture();
  context.p = { id: 'codex:s', kind: 'session', d: { card: { listId: 'middle' } } };
  context.act = async () => { throw new Error('fixture failure'); };
  await vm.runInContext("movePaneToList(p, 'right')", context);
  assert.equal(context.p.d.card.listId, 'middle');
  assert.equal(context.p.movingList, false);
  assert.equal(messages.length, 0);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { boardHtml } from '../server/ui.mjs';
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

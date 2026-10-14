import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { boardHtml } from '../server/ui.mjs';

const source = fs.readFileSync(new URL('../ui/exchanges-model.js', import.meta.url), 'utf8');
const model = new vm.Script(source + '\nexchangeModel').runInNewContext();
const plain = value => JSON.parse(JSON.stringify(value));
const events = [
  { id: '1', at: '2026-10-14T01:40:00Z', direction: 'sent', text: '最初', peer: { id: 'a', title: 'API' } },
  { id: '2', at: '2026-10-14T01:44:00Z', direction: 'received', text: '監視', peer: { id: 'b', title: '監視' } },
  { id: '3', at: '2026-10-14T01:46:00Z', direction: 'received', text: '回答', peer: { id: 'a', title: 'API' } },
];
test('changing presentation retains every message and repeated counterpart, without mutating the source', () => {
  const before = plain(events);
  assert.deepEqual(plain(model.chronological(events).map(e => e.id)), ['3', '2', '1']);
  assert.deepEqual(plain(model.groups(events).map(g => [g.peer.id, g.events.map(e => e.id)])), [['a', ['3', '1']], ['b', ['2']]]);
  assert.deepEqual(events, before);
});
test('equal titles do not merge distinct sessions and actual agents keep distinct provenance', () => {
  const same = events.map(e => ({ ...e, peer: { ...e.peer, title: '同じ名前' } }));
  assert.equal(model.groups(same).length, 2);
  assert.equal(model.relation('subagent'), 'サブエージェント');
  assert.equal(model.relation('session'), '別セッション');
});
test('the assembled UI remains a self-contained script after adding exchanges', () => {
  const html = boardHtml({ version: '0.27.13' });
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
});
test('keyboard entry resolves the selected card through the existing findCard wrapper', () => {
  const card = { id: 'codex:a', agent: 'codex' };
  const script = fs.readFileSync(new URL('../ui/exchanges.js', import.meta.url), 'utf8');
  const result = new vm.Script(script + '\nselectedExchangeCard()').runInNewContext({
    document: { addEventListener() {}, activeElement: { closest: () => ({ dataset: { cardId: card.id } }) } },
    paneLayer: { hidden: true }, findCard: () => ({ card }), inboxOn: () => false, state: {},
  });
  assert.equal(result, card);
});
test('the card speech bubble renders a visible icon from the existing icon set', () => {
  const icons = fs.readFileSync(new URL('../ui/icons.js', import.meta.url), 'utf8');
  const ui = fs.readFileSync(new URL('../ui/exchanges.js', import.meta.url), 'utf8');
  const result = new vm.Script(icons + '\n' + ui + '\nexchangePill({id:"codex:a",agent:"codex",exchanges:{sent:1,received:0,total:1}})').runInNewContext({
    document: { addEventListener() {} }, h: (tag, attrs, ...children) => ({ tag, attrs, children }),
  });
  assert.match(result.children[0].attrs.html, /<(path|circle|rect)\b/);
});

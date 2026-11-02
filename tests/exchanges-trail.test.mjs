import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../ui/exchanges-trail-model.js', import.meta.url), 'utf8');
const model = new vm.Script(source + '\nexchangeTrailModel').runInNewContext();
const plain = value => JSON.parse(JSON.stringify(value));
const event = (peer, direction, id = 'message') => ({ id, direction, at: '2026-10-16T10:00:00Z', peer: { id: peer, available: true } });
test('incoming visits insert left and outgoing visits right of the source without mutating it', () => {
  const root = model.start('a');
  const received = model.open(root, root.active, event('b', 'received'));
  assert.deepEqual(plain(received.order.map(id => received.visits[id].sessionId)), ['b', 'a']);
  const sent = model.open(received, root.active, event('c', 'sent'));
  assert.deepEqual(plain(sent.order.map(id => sent.visits[id].sessionId)), ['b', 'a', 'c']);
  assert.equal(root.order.length, 1);
  assert.equal(sent.visits[sent.active].source, root.active);
});
test('cycles create exactly one visit per gesture, retain origin, and reuse a single displayed session', () => {
  let state = model.start('a');
  for (let i = 0; i < 90; i++) state = model.open(state, state.active, event(['b', 'c', 'a'][i % 3], 'sent', String(i)));
  assert.equal(state.order.length, 91);
  assert.equal(Object.keys(state.visits).length, 91);
  assert.equal(state.visits[state.root].sessionId, 'a');
  const shown = model.cards(state);
  assert.equal(shown.length, 3);
  assert.equal(shown.find(v => v.sessionId === 'a').id, state.active);
});
test('history back and forward restore the previous visit and a branch replaces forward history', () => {
  let state = model.start('a');
  state = model.open(state, state.active, event('b', 'sent'));
  const b = state.active;
  state = model.open(state, state.active, event('a', 'sent'));
  const revisit = state.active;
  state = model.move(state, -1);
  assert.equal(state.active, b);
  state = model.move(state, 1);
  assert.equal(state.active, revisit);
  state = model.move(state, -1);
  state = model.open(state, state.active, event('d', 'received'));
  assert.equal(state.history.includes(revisit), false);
  assert.equal(model.move(state, 1).active, state.active);
  state = model.focus(state, state.root);
  assert.equal(state.active, state.root);
  assert.equal(model.cards(state).find(v => v.sessionId === 'a').id, state.root);
});
test('unknown or unavailable peers cannot produce phantom visits', () => {
  const state = model.start('a');
  assert.equal(model.open(state, 'missing', event('b', 'sent')), state);
  assert.equal(model.open(state, state.active, { ...event('b', 'sent'), peer: { id: 'b', available: false } }), state);
});
test('a cycle keeps the latest source visit in position instead of choosing a spatially later old copy', () => {
  let state = model.start('a');
  state = model.open(state, state.active, event('b', 'received'));
  state = model.open(state, state.active, event('a', 'received'));
  const source = state.active;
  state = model.open(state, source, event('b', 'sent'));
  assert.deepEqual(plain(model.cards(state).map(v => v.id)), [source, state.active]);
});
test('live relationship refresh coalesces bursts and never reloads a closed pane', () => {
  const script=fs.readFileSync(new URL('../ui/exchanges-trail.js',import.meta.url),'utf8');
  const source=script.slice(script.indexOf('function scheduleExchangeRefresh('),script.indexOf('async function loadExchangeTimeline('));
  const timers=[],calls=[],pane={kind:'session',d:{session:{agent:'codex'}}},panes=[pane];
  const schedule=vm.runInNewContext(source+'\nscheduleExchangeRefresh',{panes,paneLayer:{hidden:false},Date,setTimeout:(fn,delay)=>{timers.push({fn,delay});return timers.length;},loadExchangeTimeline:p=>calls.push(p)});
  schedule(pane);schedule(pane);schedule(pane);
  assert.equal(timers.length,1);
  timers.shift().fn();assert.equal(calls.length,1);
  schedule(pane);panes.length=0;timers.shift().fn();assert.equal(calls.length,1);
});

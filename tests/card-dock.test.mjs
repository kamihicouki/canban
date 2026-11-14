import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('opening an existing overlay child in the dock honors its explicit ID before detaching panes', async () => {
  const source = fs.readFileSync(new URL('../ui/card-overlay.js', import.meta.url), 'utf8');
  const open = source.slice(source.indexOf('async function openCard('), source.indexOf('const SESSION_PREFETCH_MS'));
  const parent = { id: 'task:parent' }, child = { id: 'claude:child', draft: '子の下書き' };
  const panes = [parent, child], loaded = [], cached = [], saved = [];
  let docked = false;
  const keep = id => {
    cached.push(...panes.filter(p => p.id !== id));
    panes.splice(0, panes.length, ...panes.filter(p => p.id === id));
    docked = true;
  };
  const context = vm.createContext({ panes, paneLayer: { hidden: false }, closePopover() {}, workspace: { utilityPage: () => false },
    exchangeTrail: null, paintingExchangeTrail: false,
    cardKind: id => id.startsWith('task:') ? 'task' : 'session', paneDocked: () => docked,
    state: { inbox: { sel: parent.id } },
    setCardsDocked: () => keep(parent.id),
    showCards: (ids, opts) => { assert.equal(opts.dock, true); assert.equal(ids.length, 1); keep(ids[0]); },
    store: { set: (...args) => saved.push(args) },
    loadSession: async p => { assert.ok(panes.includes(p), 'only an attached selected pane can be loaded'); loaded.push(p.id); },
  });
  vm.runInContext(open, context);
  await context.openCard(child.id, { dock: true });
  assert.deepEqual(panes, [child]);
  assert.deepEqual(loaded, [child.id]);
  assert.deepEqual(cached, [parent]);
  assert.equal(child.draft, '子の下書き');
  assert.deepEqual(saved, [['openCard', null]]);
});

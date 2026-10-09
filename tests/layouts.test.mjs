import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Store } from '../server/store.mjs';

const source = fs.readFileSync(new URL('../ui/layouts.js', import.meta.url), 'utf8');
const definitions = source.slice(source.indexOf('const LAYOUTS'), source.indexOf('// Places'));
const initial = source.slice(source.indexOf('state.layoutSaved ='), source.indexOf('function currentPlace'));
const setter = source.slice(source.indexOf('function setLayout('), source.indexOf('// Called after'));
const boot = fs.readFileSync(new URL('../ui/boot.js', import.meta.url), 'utf8');
const adopter = boot.slice(boot.indexOf('function adoptSharedUi('), boot.indexOf('async function applySharedUi('));

test('existing layout preferences survive startup; unknown values are displayed without rewriting', () => {
  for (const raw of ['trello', 'classic', 'rail', 'omni', 'hud', 'future-layout', null, undefined]) {
    const writes = [];
    const context = vm.createContext({ state: {}, store: { get: (_, fallback) => raw === undefined ? fallback : raw, set: (...args) => writes.push(args) } });
    vm.runInContext(definitions + initial, context);
    assert.equal(context.state.layout, ['classic', 'rail', 'omni', 'hud'].includes(raw) ? raw : 'trello');
    assert.deepEqual(writes, []);
    assert.equal(context.state.layoutSaved, raw === undefined ? 'trello' : raw);
  }
});

test('switching layout changes only the screen preference and redraws cached cards', () => {
  const state = { board: { cards: ['A', 'B'] }, filters: { status: 'running' }, unread: 2, view: 'timeline' };
  const calls = [];
  const context = vm.createContext({ state, store: { set: (...args) => calls.push(args) }, applyLayout: () => calls.push('apply'), render: () => calls.push('render') });
  vm.runInContext(definitions + setter, context);
  for (const layout of ['trello', 'classic', 'rail', 'omni', 'hud']) {
    calls.length = 0;
    vm.runInContext(`setLayout('${layout}')`, context);
    assert.deepEqual(calls, [['layout', layout], 'apply', 'render']);
    assert.deepEqual(state.board.cards, ['A', 'B']);
    assert.deepEqual(state.filters, { status: 'running' });
    assert.equal(state.unread, 2);
    assert.equal(state.view, 'timeline');
  }
  calls.length = 0;
  vm.runInContext("setLayout('not-a-layout')", context);
  assert.deepEqual(calls, []);
  assert.equal(state.layoutSaved, 'hud');
});

test('adopting shared layout keeps unknown values and normalizes explicit null without saving', () => {
  for (const raw of ['rail', 'future-layout', null, 42]) {
    const state = { layout: 'hud', layoutSaved: 'hud' }, writes = [], applied = [];
    const context = vm.createContext({ state, sharedUi: {}, SHARED_UI_KEYS: ['layout'],
      workspacePage: () => 'home', workspace: { navigate() {} }, $: () => null,
      store: { cache() {}, set: (...args) => writes.push(args) }, applyLayout: () => applied.push(state.layout) });
    vm.runInContext(definitions + adopter, context);
    context.record = { revision: 3, state: { layout: raw } };
    vm.runInContext('adoptSharedUi(record)', context);
    assert.equal(state.layout, raw === 'rail' ? 'rail' : 'trello');
    assert.equal(state.layoutSaved, raw);
    assert.deepEqual(writes, []);
    assert.deepEqual(applied, [state.layout]);
    applied.length = 0;
    vm.runInContext('adoptSharedUi(record)', context);
    assert.deepEqual(applied, []);
  }
});

test('remote layout-only updates redraw cached data; changed filters still fetch', async () => {
  const apply = boot.slice(boot.indexOf('async function applySharedUi('), boot.indexOf('async function reloadSharedUi('));
  for (const filtersChanged of [false, true]) {
    let snapshot = { layout: 'trello', filters: { agent: 'all' }, workspacePage: 'home' };
    let loads = 0, renders = 0;
    const context = vm.createContext({
      hasUnsavedPaneInput: () => false, sharedUi: {}, sharedUiSnapshot: () => snapshot,
      adoptSharedUi: record => { snapshot = record.state; return true; },
      applyCardWidths() {}, layoutCardBoard() {}, panes: [], applyPaneAttrs() {}, paintPaneBar() {},
      load: async () => loads++, render: () => renders++, renderSidebar() {}, state: { board: {} },
    });
    context.record = { state: { layout: 'rail', filters: { agent: filtersChanged ? 'codex' : 'all' }, workspacePage: 'home' } };
    await vm.runInContext(apply + '\napplySharedUi(record)', context);
    assert.equal(loads, filtersChanged ? 1 : 0);
    assert.equal(renders, 1);
  }
});

test('shared layout saves preserve all board data, read markers, settings and revision conflicts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-layout-store-'));
  const store = new Store(dir);
  await store.moveCard({ cardId: 'codex:synthetic', toListId: 'doing' });
  await store.markSeen({ cardId: 'codex:synthetic' });
  const { uiState: unused, ...before } = await store.load();
  let revision = 0;
  for (const layout of ['trello', 'classic', 'rail', 'omni', 'hud']) {
    const saved = await store.saveUiState({ expectedRevision: revision, state: { layout, boardView: 'timeline', filters: { status: 'running' } } });
    assert.equal(saved.saved, true);
    revision = saved.revision;
    const { uiState, ...after } = await store.load();
    assert.deepEqual(after, before);
    assert.equal(uiState.state.layout, layout);
  }
  const conflict = await store.saveUiState({ expectedRevision: 0, state: { layout: 'trello' } });
  assert.equal(conflict.conflict, true);
  assert.equal((await store.getUiState()).state.layout, 'hud');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const loadSource = fs.readFileSync(new URL('../ui/load.js', import.meta.url), 'utf8');
const keyboardSource = fs.readFileSync(new URL('../ui/keyboard.js', import.meta.url), 'utf8');
const keyboardStart = keyboardSource.lastIndexOf("document.addEventListener('keydown', (e) => {");
const keyboardEnd = keyboardSource.indexOf('// board: wheel', keyboardStart);

function harness(board = null) {
  const notifications = [], replacements = [], keyHandlers = [], buttons = new Map();
  const state = { board, filters: {}, lanes: [] };
  const context = vm.createContext({
    state, panes: [], bridge: { callTool: async () => { throw new Error('接続が切れました'); } },
    decodeSourceBoard: value => value,
    render() {}, reconcileCards() {}, paintCardListControls() {}, refreshShortcutHints() {}, refreshViews() {},
    toast: (...args) => notifications.push(args),
    h: (_tag, props) => props,
    $: selector => {
      if (selector === '#board') return { replaceChildren: value => replacements.push(value) };
      if (!buttons.has(selector)) buttons.set(selector, { addEventListener: (_event, handler) => buttons.get(selector).handler = handler });
      return buttons.get(selector);
    },
    document: { addEventListener: (event, handler) => { if (event === 'keydown') keyHandlers.push(handler); }, querySelector: () => null },
    typingIn: () => false, overlayOpen: () => false, inDockedPane: () => false,
    taskQuickAdd: {}, stepDisplayedCard() {}, focusSearch() {}, showShortcuts() {}, toggleSidebar() {}, stepLane() {},
    toggleAnalytics() {}, toggleView() {}, quickAdd() {}, scopePicker() {}, toggleBoardView() {}, toggleDotScope() {},
    slackUi: { toggle() {} },
  });
  vm.runInContext(loadSource, context);
  vm.runInContext(keyboardSource.slice(keyboardStart, keyboardEnd), context);
  return { context, state, notifications, replacements, keyHandlers, buttons };
}

const event = key => ({ key, target: { classList: { contains: () => false } }, preventDefault() {} });

test('initial board failure records the error and retry clears it after rendering', async () => {
  const h = harness();
  assert.equal(await vm.runInContext('load()', h.context), false);
  assert.equal(h.state.board, null);
  assert.equal(h.state.boardError, '接続が切れました');
  assert.match(h.replacements[0].text, /読み込みに失敗/);
  h.context.bridge.callTool = async () => ({ lists: [] });
  assert.equal(await vm.runInContext('load()', h.context), true);
  assert.equal(h.state.boardError, null);
  assert.equal(h.notifications.length, 0);
});

test('refresh failure retains the displayed board and reports failure for key and button', async () => {
  for (const route of ['key', 'button']) {
    const board = { lists: [{ cards: [{ id: 'fictional' }] }] }, h = harness(board);
    if (route === 'key') await h.keyHandlers[0](event('r'));
    else await h.buttons.get('#refresh').handler();
    assert.equal(h.state.board, board);
    assert.equal(h.replacements.length, 0, `${route} removed the current board`);
    assert.equal(h.state.boardError, '接続が切れました');
    assert.deepEqual(h.notifications, [['読み込みに失敗しました: 接続が切れました', true]]);
  }
});

test('successful refresh is the only key or button result that reports success', async () => {
  for (const route of ['key', 'button']) {
    const h = harness();
    h.context.bridge.callTool = async () => ({ lists: [] });
    if (route === 'key') await h.keyHandlers[0](event('r'));
    else await h.buttons.get('#refresh').handler();
    assert.deepEqual(h.notifications, [['最新の状態に更新しました']]);
  }
});

test('stale requests cannot clear the current error or announce refresh success', async () => {
  const h = harness({ lists: [] });
  let finishOld;
  h.context.bridge.callTool = () => new Promise(resolve => { finishOld = resolve; });
  const oldRefresh = h.buttons.get('#refresh').handler();
  h.context.bridge.callTool = async () => { throw new Error('新しい取得は失敗'); };
  await vm.runInContext('load()', h.context);
  finishOld({ lists: [] });
  await oldRefresh;
  assert.equal(h.state.boardError, '新しい取得は失敗');
  assert.deepEqual(h.notifications, [['読み込みに失敗しました: 新しい取得は失敗', true]]);
});

test('throwOnError still rejects with the original error', async () => {
  const h = harness();
  await assert.rejects(vm.runInContext('load({throwOnError:true})', h.context), /接続が切れました/);
  assert.equal(h.state.boardError, '接続が切れました');
});

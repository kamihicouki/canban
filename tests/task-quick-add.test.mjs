import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Store } from '../server/store.mjs';
import { matchesTask, normalizeFilters } from '../server/board.mjs';
import { effectiveTaskContext } from '../server/task-context.mjs';
import { boardHtml } from '../server/ui.mjs';

const model = new vm.Script(fs.readFileSync(new URL('../ui/task-quick-add-model.js', import.meta.url), 'utf8') + '\n({taskCreationDefaults, taskLaneCreation, saveQuickTaskDraft})').runInNewContext();
const plain = value => JSON.parse(JSON.stringify(value));

test('real lane construction keeps stable attribute IDs even when display names collide', () => {
  const source = boardHtml();
  const code = source.slice(source.indexOf('const LANE_MODES'), source.indexOf('const collapsedLanes'));
  const labels = [{ id: 'l1', name: '同名' }, { id: 'l2', name: '同名' }];
  const cards = [
    { id: 'a', kind: 'task', agent: 'codex', account: 'codex:a', project: 'p', labels: ['l1'], codexSection: { id: 's1', name: '同名' }, directory: { id: 'd1', name: '同名' } },
    { id: 'b', kind: 'task', agent: 'codex', account: 'codex:b', project: 'p', labels: ['l2'], codexSection: { id: 's2', name: '同名' }, directory: { id: 'd2', name: '同名' } },
  ];
  const board = { labels, lists: [{ id: 'inbox', cards }], projects: [{ name: 'p' }], directories: [{ id: 'd1', name: '同名' }, { id: 'd2', name: '同名' }, { id: 'empty', name: '空' }] };
  const context = vm.createContext({ state: { board }, T: { category: 'カテゴリ', taskCard: 'タスクカード' }, accountLaneKey: () => '同じ表示名' });
  vm.runInContext(fs.readFileSync(new URL('../ui/task-quick-add-model.js', import.meta.url), 'utf8') + '\n' + code, context);
  for (const mode of ['directory', 'label', 'section', 'account']) {
    const lanes = context.buildLanes(board, mode).filter(l => l.count);
    assert.equal(lanes.length, 2, mode);
    assert.notEqual(lanes[0].key, lanes[1].key);
    assert.deepEqual(plain(lanes.map(l => l.lists[0].cards.length)), [1, 1]);
  }
  const empty = context.buildLanes(board, 'directory').find(l => l.creation.directory === 'empty');
  assert.equal(empty.count, 0); assert.equal(empty.lists.length, 1);
  assert.equal(context.buildLanes(board, 'project')[0].creation.context.project, 'p');
  assert.equal(context.buildLanes(board, 'agent')[0].creation.context.agent, 'codex');
  assert.equal(context.buildLanes(board, 'host')[0].creation.context.host, 'local');
  const emptyBoard = { ...board, lists: [{ id: 'inbox', cards: [] }],
    codexSections: [{ id: 's1', name: '同名' }], hosts: [{ id: 'local', local: true }, { id: 'remote', label: 'サーバー' }],
    accounts: { accounts: [{ key: 'codex:a', label: 'a' }] } };
  context.state.board = emptyBoard;
  const emptyLane = (mode, creation) => context.buildLanes(emptyBoard, mode).find(l => JSON.stringify(l.creation) === JSON.stringify(creation));
  for (const [mode, creation] of [
    ['project', { context: { project: null } }], ['section', { context: { section: 's1' } }],
    ['section', { context: { section: null } }], ['agent', { context: { agent: 'claude' } }],
    ['host', { context: { host: 'remote' } }], ['account', { context: { account: 'codex:a' } }],
    ['account', { context: { account: null, host: 'remote' } }],
  ]) {
    const found = emptyLane(mode, creation);
    assert.ok(found, `${mode} preserves its empty destination`);
    assert.equal(found.count, 0);
    assert.equal(found.lists.length, 1);
  }
});

test('the real swimlane column always exposes task addition with its column and lane context', () => {
  const source = boardHtml();
  const code = source.slice(source.indexOf('function renderList('), source.indexOf('// The shell every card face shares'));
  const node = (tag, attrs = {}, ...children) => ({ tag, attrs, children,
    append(...items) { this.children.push(...items); }, addEventListener() {} });
  let request;
  const context = vm.createContext({ h: node, state: { shown: {} }, PAGE: 50, colorVar: x => x, splitByLife: (cards) => ({ awake: cards, dormant: [] }),
    taskQuickAdd: { open: value => { request = value; } } });
  vm.runInContext(code, context);
  const lane = { creation: { context: { project: 'p' } } };
  const list = context.renderList({ id: 'doing', title: '進行中', cards: [], count: 0 }, { inLane: true, lane });
  const footer = list.children.find(n => n.attrs.class === 'add-card');
  assert.ok(footer);
  footer.children[0].attrs.onclick();
  assert.deepEqual(plain(request), { listId: 'doing', lane });
});

test('defaults combine filters, solo lane, explicit lane and manual edits without mutating sources', () => {
  const board = { defaultListId: 'inbox' };
  const filters = { project: 'filter-project', directory: 'd1', label: 'l1', agent: 'codex', account: '__none', q: '検索', status: 'running' };
  const before = JSON.stringify(filters);
  const source = { listId: 'doing', soloLane: { creation: { context: { project: 'solo-project' } } },
    lane: { creation: { directory: '__none', context: { project: 'lane-project' }, labels: ['l2'] } } };
  const defaults = model.taskCreationDefaults(board, filters, source);
  assert.deepEqual(plain(defaults), { listId: 'doing', directory: '__none', labels: ['l2', 'l1'],
    context: { project: 'lane-project', agent: 'codex', account: null } });
  assert.equal(model.taskCreationDefaults(board, filters, source, { context: { project: 'manual' } }).context.project, 'manual');
  assert.equal(JSON.stringify(filters), before);
  assert.deepEqual(plain(model.taskCreationDefaults(board, filters, { lane: { creation: { labels: [] } } }).labels), []);
  assert.deepEqual(plain(model.taskLaneCreation({ host: { id: 'box' }, account: null }, 'account')), { context: { account: null, host: 'box' } });
});

test('saving survives duplicate submits, unknown outcomes and failed display refresh', async () => {
  const draft = { ...plain(model.taskCreationDefaults({ defaultListId: 'inbox' }, {})), title: 'タスク', description: '' };
  let calls = 0, release, firstRequest;
  const io = { newRequestId: () => 'retry-id', refresh: async () => { throw new Error('表示更新の失敗'); },
    callTool: async (name, args) => {
      calls++; firstRequest = args;
      await new Promise(resolve => { release = resolve; });
      throw new Error('通信の失敗');
    } };
  const pending = model.saveQuickTaskDraft(draft, io);
  assert.equal(await model.saveQuickTaskDraft(draft, io), null);
  assert.equal(calls, 1);
  release(); await assert.rejects(pending, /通信/);
  assert.equal(draft.title, 'タスク'); assert.equal(draft.clientRequestId, 'retry-id');
  io.callTool = async (name, args) => {
    assert.equal(args.clientRequestId, firstRequest.clientRequestId);
    return { cardId: 'task:x', title: args.title, description: args.description, listId: args.list, labels: args.labels, context: args.context };
  };
  const saved = await model.saveQuickTaskDraft(draft, io);
  assert.equal(saved.refreshError, '表示更新の失敗'); assert.equal(saved.matches, true);
  assert.equal(draft.title, ''); assert.equal(draft.clientRequestId, null);
});

test('a changed draft is preserved when a retry acknowledges the previous creation', async () => {
  const draft = { ...plain(model.taskCreationDefaults({ defaultListId: 'inbox' }, {})), title: '次の入力', description: '', clientRequestId: 'old-id' };
  const saved = await model.saveQuickTaskDraft(draft, { newRequestId: () => 'new-id', refresh: async () => {},
    callTool: async () => ({ cardId: 'task:old', title: '前の入力', description: '', listId: 'inbox', labels: [], context: {} }) });
  assert.equal(saved.matches, false); assert.equal(draft.title, '次の入力'); assert.equal(draft.clientRequestId, null);
});

test('quick creation stores classification atomically and retry returns the same task', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'canban-quick-task-')));
  const { id: directory } = await store.createDirectory({ name: '分類' });
  const { id: label } = await store.createLabel({ name: '優先' });
  const context = { project: 'canban', folder: 'app', section: 's1', agent: 'codex', host: 'local', account: 'codex:test' };
  const args = { title: '新しいタスク', listId: 'doing', directory, labels: [label], context, clientRequestId: 'request-1' };
  const task = await store.createTask(args);
  assert.equal(task.directoryId, directory);
  assert.deepEqual(task.labels, [label]);
  assert.deepEqual(task.context, context);
  assert.equal((await store.createTask(args)).cardId, task.cardId);
  assert.equal(Object.keys((await store.load()).cards).length, 1);
  const restarted = new Store(store.dir);
  assert.equal((await restarted.createTask(args)).cardId, task.cardId);
  await store.updateTask({ cardId: task.cardId, context: { project: '別プロジェクト', account: null } });
  assert.deepEqual((await store.load()).cards[task.cardId].context, { project: '別プロジェクト', account: null });
});

test('an unlinked task matches every inherited filter and explicit context overrides links', () => {
  const task = { title: '新しいタスク', labels: ['l1'], context: { project: 'canban', folder: 'app', section: 's1', agent: 'codex', host: 'box', account: 'codex:test' } };
  const filters = normalizeFilters({ ...task.context, directory: 'd1', label: 'l1' });
  const labels = new Map([['l1', { name: '優先' }]]);
  assert.equal(matchesTask(task, [], 'idle', filters, labels, { id: 'd1' }), true);
  const link = { agent: 'claude', project: 'other', folder: 'else', host: { id: 'other' }, account: 'claude:other', codexSection: { id: 's2' } };
  assert.equal(matchesTask(task, [link], 'idle', filters, labels, { id: 'd1' }), true);
  assert.equal(matchesTask(task, [link], 'idle', normalizeFilters({ project: 'other' }), labels, null), false);
  assert.deepEqual(effectiveTaskContext(task, [link]), task.context);
  assert.equal(matchesTask(task, [], 'idle', normalizeFilters({ status: 'running' }), labels, null), false);
  assert.equal(matchesTask(task, [], 'idle', normalizeFilters({ q: '一致しない' }), labels, null), false);
  const accountOnly = { context: { account: 'codex:test' } };
  assert.equal(effectiveTaskContext(accountOnly).agent, 'codex');
  assert.equal(matchesTask(accountOnly, [], 'idle', normalizeFilters({ agent: 'codex' }), labels, null), true);
  assert.equal(matchesTask(accountOnly, [], 'idle', normalizeFilters({ agent: 'claude' }), labels, null), false);
});

test('explicit none and legacy multi-session filters remain distinct', () => {
  const links = [{ agent: 'codex', project: 'p1', host: null }, { agent: 'claude', project: 'p2', codexSection: { id: 's1' }, account: 'claude:x' }];
  for (const project of ['p1', 'p2']) assert.equal(matchesTask({}, links, 'idle', { project }, new Map(), null), true);
  const task = { context: { project: null, section: null, account: null }, labels: [] };
  assert.equal(matchesTask(task, links, 'idle', { section: '__none', account: '__none', label: '__none' }, new Map(), null), true);
  assert.equal(effectiveTaskContext(task, links).project, null);
  assert.equal(matchesTask(task, links, 'idle', { project: 'p1' }, new Map(), null), false);
});

test('invalid attributes never leave partially created tasks', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'canban-quick-invalid-')));
  for (const extra of [{ directory: 'missing' }, { labels: ['missing'] }, { context: { agent: 'other' } }, { context: { agent: 'codex', account: 'claude:test' } }]) {
    await assert.rejects(store.createTask({ title: '失敗するタスク', ...extra }));
    assert.deepEqual((await store.load()).cards, {});
  }
  const task = await store.createTask({ title: '分類なし', directory: '__none', labels: [], context: { section: null, project: null } });
  assert.equal(task.directoryId, '__none');
  assert.deepEqual(task.context, { section: null, project: null });
});

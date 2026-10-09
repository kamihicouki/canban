import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDotCache, mergeDotSessions, CLOUD_OPERATION_REASON } from '../server/sources/codex-dots.mjs';
import { parseAppState, annotateCodexApp, codexAppState } from '../server/sources/codex-app.mjs';
import { headlessArgs, resumeCommand, desktopLink } from '../server/agents.mjs';
import { sessionActions } from '../server/session-actions.mjs';
import { dotFixture } from './fixtures/dots.mjs';
import { makeFixtures } from './helpers.mjs';

// Set up (and register the clean-up) before the first test: on Node 22 a top-level after() registered
// after tests have started, across a top-level await, runs before the remaining tests.
const fx = makeFixtures(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-dots-'));
process.env.CANBAN_CODEX_HOME = fx.codexHome; process.env.CANBAN_CLAUDE_HOME = fx.claudeHome;
process.env.CANBAN_CLAUDE_DESKTOP_DIR = fx.desktopDir;
process.env.CANBAN_GH = path.resolve('tests/fake-gh.sh'); process.env.CANBAN_GLAB = path.resolve('tests/fake-glab.sh');
process.env.FAKE_GH_DATA = '/dev/null';
const file = path.join(fx.codexHome, '.codex-global-state.json');
fs.writeFileSync(file, JSON.stringify(dotFixture()));
const { Store } = await import('../server/store.mjs');
const { buildBoard, sessionDetail, allSessions, dropLocalCache } = await import('../server/board.mjs');
const { Dispatcher, staticProblem, resolveSession } = await import('../server/dispatch.mjs');
const store = new Store(dir);
after(async () => { await store.close(); fx.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); });

test('only explicitly visible chats attached to an orbit profile are dot sessions', () => {
  const raw = dotFixture(1791500000000), result = parseDotCache(raw);
  assert.deepEqual(result.sessions.map(s => s.nativeId), ['dot-created', 'dot-related', 'dot-sub']);
  const s = result.sessions[0];
  assert.equal(s.dot.relation, 'created'); assert.equal(result.sessions[1].dot.relation, 'related');
  assert.equal(s.createdAt, 1791499900000); assert.equal(s.cloud.cachedAt, 1791500000000);
  assert.equal(s.cwd, null); assert.equal(s.sourcePath, null); assert.equal(s.account, 'codex:demo-account');
  const saved = raw['electron-persisted-atom-state']['cloud-aeon-sidebar-cache-v1'];
  saved.attachments[1].is_user_visible = undefined;
  saved.profilesByThreadId['dot-related'] = { ...saved.profilesByThreadId['dot-related'], aeon_kind: 'care' };
  assert.deepEqual(parseDotCache(raw).sessions.map(s => s.nativeId), ['dot-sub']);
  assert.equal(parseDotCache(null).sessions.length, 0);
  assert.equal(parseDotCache({ 'electron-persisted-atom-state': { 'cloud-aeon-sidebar-cache-v1': { threads: {}, attachments: {}, profilesByThreadId: [] } } }).sessions.length, 0);
});

test('dot metadata annotates existing sessions without duplicates or guessing agent-created chats', () => {
  const app = parseAppState(dotFixture());
  const local = { id: 'codex:dot-created', nativeId: 'dot-created', agent: 'codex', threadSource: 'aeon_child', cwd: '/local', status: 'completed' };
  const normal = { id: 'codex:ordinary', nativeId: 'ordinary', agent: 'codex', threadSource: 'agent_created_thread' };
  const sessions = mergeDotSessions([local, normal], app); annotateCodexApp(sessions, app);
  assert.equal(sessions.filter(s => s.id === local.id).length, 1); assert.equal(sessions[0].cwd, '/local');
  assert.equal(local.dot.relation, 'created'); assert.equal(normal.dot, null);
  annotateCodexApp([local], parseAppState({})); assert.equal(local.dot, null);
});

test('cached cloud sessions cannot produce terminal commands, headless turns or lifecycle mutations', () => {
  const s = parseDotCache(dotFixture()).sessions[0];
  assert.equal(resumeCommand(s), null); assert.equal(headlessArgs(s, { sandbox: 'read-only' }), null);
  assert.equal(sessionActions(s).available, false); assert.equal(sessionActions(s).reason, CLOUD_OPERATION_REASON);
  assert.equal(desktopLink(s).url, 'codex://threads/dot-created?hostId=durable');
});


test('board defaults exclude dots; all and only work with task links and saved views', async () => {
  const before = fx.snapshot();
  const cards = b => b.lists.flatMap(l => l.cards);
  assert.ok(!cards(await buildBoard(store, { days: 0 })).some(c => c.dot));
  const all = await buildBoard(store, { days: 0, dotScope: 'all', fulltext: true, q: '保存済み' });
  assert.equal(cards(all).filter(c => c.dot).length, 2);
  const created = cards(all).find(c => c.id === 'codex:dot-created');
  assert.equal(created.statusKnown, false); assert.equal(created.status, 'idle');
  assert.equal(cards(await buildBoard(store, { days: 0, dotScope: 'only', includeSubagents: true })).length, 3);
  const task = await store.createTask({ title: 'dotの成果を使う' });
  await store.linkSession({ taskId: task.cardId, sessionId: created.id });
  assert.ok(cards(await buildBoard(store, { days: 0 })).some(c => c.id === task.cardId));
  const only = cards(await buildBoard(store, { days: 0, dotScope: 'only' }));
  assert.ok(only.some(c => c.id === task.cardId)); assert.ok(!only.some(c => !c.dot && c.kind !== 'task'));
  const view = await store.saveView({ name: 'dotだけ', filters: { dotScope: 'only' } });
  assert.equal((await store.load()).settings.views.find(v => v.id === view.id).filters.dotScope, 'only');
  assert.deepEqual(fx.snapshot(), before, 'Codex and Claude source files remain unchanged');
});

test('detail and dispatcher restrict cloud operations before recording any request', async () => {
  const detail = await sessionDetail(store, 'codex:dot-created');
  assert.equal(detail.dispatch.unavailableReason, CLOUD_OPERATION_REASON);
  assert.match(detail.messagesError, /会話本文/); assert.equal(detail.git, null);
  assert.equal(detail.launch.terminal.command, null);
  assert.equal(staticProblem(detail.session), CLOUD_OPERATION_REASON);
  await store.updateDispatchSettings({ enabled: true });
  const dispatcher = new Dispatcher(store);
  for (const when of ['queue', 'now']) await assert.rejects(dispatcher.submit({ cardId: detail.session.id, prompt: '実行しない', when }), /クラウド/);
  assert.equal((await dispatcher.requests.list({ cardId: detail.session.id })).length, 0);
  await assert.rejects(resolveSession(store, detail.session.id, undefined, { allowCloud: false }), /セッションが見つかりません/);
});

test('a failed local Codex listing is not reclassified as cloud sessions', async () => {
  const db = path.join(fx.codexHome, 'state_5.sqlite'), backup = `${db}.saved`;
  fs.renameSync(db, backup);
  try {
    fs.writeFileSync(db, 'temporarily unreadable fixture database');
    const { sessions, errors } = await allSessions(await store.load(), { force: true });
    assert.ok(errors.some(error => error.includes('Codex DB 読み取り失敗')));
    assert.ok(!sessions.some(s => s.sourceKind === 'codex-cloud'));
  } finally {
    fs.rmSync(db, { force: true }); fs.renameSync(backup, db); dropLocalCache();
  }
});

test('the app cache retains the last valid snapshot during a partial write and refreshes after a valid replacement', async () => {
  const first = await codexAppState({ home: fx.codexHome });
  fs.writeFileSync(file, '{partial');
  assert.equal((await codexAppState({ home: fx.codexHome })).dotSessions.length, first.dotSessions.length);
  fs.writeFileSync(file, '{}');
  assert.equal((await codexAppState({ home: fx.codexHome })).dotSessions.length, 0);
});

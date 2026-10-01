// End-to-end over stdio: the server exposes the sidebar entrypoint and the MCP App resource.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeFixtures } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-mcp-'));
const fx = makeFixtures();
let child;
let nextId = 1;
const waiting = new Map();

function rpc(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve) => waiting.set(id, resolve));
}
const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;

before(async () => {
  child = spawn('/bin/sh', [path.join(root, 'scripts', 'launch.sh')], { cwd: root, env: { ...process.env, CANBAN_DATA_DIR: dataDir, CANBAN_CODEX_HOME: fx.codexHome, CANBAN_CLAUDE_HOME: fx.claudeHome, CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir, CANBAN_LAUNCH_DRYRUN: '1', CANBAN_SEARCH_INDEX: '0', CANBAN_GH: path.join(root, 'tests', 'fake-gh.sh'), CANBAN_GLAB: path.join(root, 'tests', 'fake-glab.sh'), FAKE_GH_DATA: '/dev/null' }, stdio: ['pipe', 'pipe', 'ignore'] });
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m);
  });
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'canban');
});
after(() => {
  child.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fx.cleanup();
});

test('open_canban declares a global sidebar entrypoint and ui resource', async () => {
  const { result } = await rpc('tools/list');
  const open = result.tools.find((t) => t.name === 'open_canban');
  assert.deepEqual(open._meta['openai/ui'].entrypoints, [{ type: 'global' }]);
  assert.equal(open._meta.ui.resourceUri, 'ui://canban/board.html');
  assert.equal(open._meta['openai/outputTemplate'], 'ui://canban/board.html');
  const hidden = result.tools.filter((t) => t._meta?.ui?.visibility?.join() === 'app').map((t) => t.name);
  assert.ok(hidden.includes('canban_get_board') && hidden.includes('canban_create_list'));
});

test('ui resource is served as an MCP App', async () => {
  const { result } = await rpc('resources/read', { uri: 'ui://canban/board.html' });
  assert.equal(result.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.match(result.contents[0].text, /ui\/initialize/);
});

test('list and card operations persist only to the kanban store', async () => {
  const board = (await call('canban_get_board', { days: 0 })).structuredContent;
  assert.equal(board.lists[0].id, 'inbox');
  const created = (await call('canban_create_list', { title: '保留' })).structuredContent.result;
  const card = board.lists[0].cards[0];
  assert.ok(card, 'fixture sessions should be on the board');
  {
    const moved = await call('canban_move_card', { cardId: card.id, toList: '保留' });
    assert.ok(!moved.isError, moved.content?.[0]?.text);
    const b2 = (await call('canban_get_board', { days: 0 })).structuredContent;
    assert.ok(b2.lists.find((l) => l.id === created.id).cards.some((c) => c.id === card.id));
  }
  const saved = await new (await import('../server/store.mjs')).Store(dataDir).load();
  assert.ok(saved.lists.some((l) => l.title === '保留'));
  const bad = await call('canban_move_card', { cardId: 'codex:does-not-exist', toList: 'inbox' });
  assert.equal(bad.isError, true);
});

test('directories: source categories, explicit assignment and category-less filter', async () => {
  const dir = (await call('canban_create_directory', { name: 'Web', paths: ['/r/web'] })).structuredContent.result;
  let board = (await call('canban_get_board', { days: 0 })).structuredContent;
  const all = board.lists.flatMap((l) => l.cards);
  const inWeb = all.filter((c) => c.cwd === '/r/web');
  assert.ok(inWeb.length, 'fixtures have sessions under /r/web');
  assert.ok(inWeb.filter(c => c.agent === 'codex').every(c => c.directory === null), 'Codex without a project stays category-less');
  assert.ok(inWeb.filter(c => c.agent === 'claude').every(c => c.directory?.name === 'web'), 'Claude falls back to its cwd name');
  assert.equal(board.directories.find(d => d.id === dir.id).count, 0);
  for (const card of inWeb) await call('canban_update_card', { cardId: card.id, directory: dir.id });
  board = (await call('canban_get_board', { days: 0 })).structuredContent;
  assert.equal(board.directories.find(d => d.id === dir.id).count, inWeb.length);
  const res = await call('canban_update_card', { cardId: inWeb[0].id, directory: '__none' });
  assert.ok(!res.isError, res.content?.[0]?.text);
  board = (await call('canban_get_board', { days: 0, directory: dir.id })).structuredContent;
  const shown = board.lists.flatMap((l) => l.cards).map((c) => c.id);
  assert.ok(!shown.includes(inWeb[0].id));
  assert.equal(shown.length, inWeb.length - 1);
  const found = (await call('canban_search', { directory: '__none' })).structuredContent;
  assert.ok(JSON.stringify(found).includes(inWeb[0].id));
  await call('canban_delete_directory', { directoryId: dir.id });
});

test('open_session: desktop link, terminal route, and unsupported desktop fallback', async () => {
  const c2 = await call('canban_open_session', { cardId: 'claude:c2', route: 'desktop' });
  assert.ok(!c2.isError, c2.content?.[0]?.text);
  assert.equal(c2.structuredContent.url, 'claude://code/continue?session=local_abc-123');
  assert.equal(c2.structuredContent.exact, true);
  if (process.platform === 'darwin') {
    const t = await call('canban_open_session', { cardId: 'codex:t1', route: 'terminal', terminal: 'terminal', target: 'new-tab' });
    assert.ok(!t.isError, t.content?.[0]?.text);
    assert.equal(t.structuredContent.command, 'cd /Users/x/.codex/worktrees/0346/demo-app 2>/dev/null; codex resume t1');
    assert.equal(t.structuredContent.target, 'new-tab');
  }
  const bad = await call('canban_open_session', { cardId: 'nope:x' });
  assert.equal(bad.isError, true);
});

test('settings and hosts tools', async () => {
  await call('canban_update_settings', { route: 'terminal', target: 'split' });
  const board = (await call('canban_get_board', {})).structuredContent;
  assert.equal(board.settings.launch.route, 'terminal');
  assert.equal(board.settings.launch.target, 'split');
  assert.equal(board.hosts[0].id, 'local');
  const hosts = await call('canban_list_hosts', {});
  assert.deepEqual(hosts.structuredContent.hosts, []);
  const bad = await call('canban_set_remote_host', { hostId: 'remote-ssh-discovered:nope', enabled: true });
  assert.equal(bad.isError, true);
});

test('task flow: create, start (dry-run), link, board shows the session inside the task', async () => {
  const created = await call('canban_create_task', { title: 'README を直す', list: 'doing' });
  const taskId = created.structuredContent.cardId;
  const started = await call('canban_start_session', { taskId, agent: 'claude', cwd: '/r/web', route: 'desktop' });
  assert.ok(!started.isError, started.content?.[0]?.text);
  assert.equal(started.structuredContent.url, 'claude://code/new?q=README+%E3%82%92%E7%9B%B4%E3%81%99&folder=%2Fr%2Fweb');
  let board = (await call('canban_get_board', { days: 0 })).structuredContent;
  let task = board.lists.flatMap((l) => l.cards).find((c) => c.id === taskId);
  assert.equal(task.kind, 'task');
  assert.equal(task.pending.length, 1);
  await call('canban_link_session', { taskId, sessionId: 'claude:c1' });
  board = (await call('canban_get_board', { days: 0, includeArchived: true })).structuredContent;
  const all = board.lists.flatMap((l) => l.cards);
  task = all.find((c) => c.id === taskId);
  assert.deepEqual(task.links.map((l) => l.id), ['claude:c1']);
  assert.ok(!all.some((c) => c.id === 'claude:c1'), 'linked session is not shown as its own card');
  const d = (await call('canban_get_session', { cardId: 'claude:c1' })).structuredContent;
  assert.equal(d.task.id, taskId);
});

test('requests: model tools are visible, UI-only ones are not; gates answer with a reason', async () => {
  const { result } = await rpc('tools/list');
  const vis = (n) => result.tools.find((t) => t.name === n)?._meta?.ui?.visibility?.join();
  assert.equal(vis('canban_send_prompt'), 'model,app');
  assert.equal(vis('canban_list_requests'), 'model,app');
  for (const n of ['canban_dispatch', 'canban_stop_request', 'canban_update_dispatch_settings', 'canban_get_perf']) assert.equal(vis(n), 'app', n);
  // Fixture sessions live in folders that do not exist here: refused before anything runs.
  const sent = await call('canban_send_prompt', { cardId: 'claude:c2', prompt: 'hi', when: 'now' });
  assert.equal(sent.isError, true);
  assert.match(sent.content[0].text, /作業フォルダがありません/);
  const list = await call('canban_list_requests', {});
  assert.deepEqual(list.structuredContent.requests, []);
  const d = (await call('canban_get_session', { cardId: 'claude:c2' })).structuredContent;
  assert.equal(d.dispatch.permission.mode, 'default');
  assert.deepEqual(d.dispatch.queue, []);
  const perf = (await call('canban_get_perf', {})).structuredContent;
  assert.equal(perf.leader, true);
  assert.ok(perf.ops.buildBoard.count > 0);
});

test('Codex pins are shown and filterable; Claude sessions without desktop metadata are marked unknown', async () => {
  const board = (await call('canban_get_board', { days: 0, includeArchived: true, pinnedOnly: true })).structuredContent;
  const ids = board.lists.flatMap((l) => l.cards).map((c) => c.id);
  assert.deepEqual(ids, ['codex:t1']);
  assert.equal(board.lists.flatMap((l) => l.cards)[0].pinnedInAgent, true);
  const d = (await call('canban_get_session', { cardId: 'claude:c1' })).structuredContent;
  assert.equal(d.session.desktopKnown, true);
  assert.equal(d.session.entrypoint, 'claude-desktop');
});

test('shared view state tools are app-only and return stale-write conflicts', async () => {
  const { result } = await rpc('tools/list');
  const vis = (name) => result.tools.find((tool) => tool.name === name)?._meta?.ui?.visibility?.join();
  assert.equal(vis('canban_get_ui_state'), 'app');
  assert.equal(vis('canban_save_ui_state'), 'app');

  const initial = (await call('canban_get_ui_state')).structuredContent.result;
  assert.deepEqual(initial, { revision: 0, state: null });
  const state = { view: 'board', filters: { agent: 'codex' } };
  const saved = await call('canban_save_ui_state', { expectedRevision: 0, state });
  assert.deepEqual(saved.structuredContent.result, { saved: true, revision: 1, state });
  const conflict = await call('canban_save_ui_state', { expectedRevision: 0, state: { view: 'analytics' } });
  assert.deepEqual(conflict.structuredContent.result, { saved: false, conflict: true, revision: 1, state });
});

test('accounts: usage is visible to the model, account settings only to the board', async () => {
  const { result } = await rpc('tools/list');
  const vis = (n) => result.tools.find((t) => t.name === n)?._meta?.ui?.visibility?.join();
  assert.equal(vis('canban_get_usage'), 'model,app');
  assert.equal(vis('canban_update_accounts'), 'app');
  const usage = (await call('canban_get_usage', {})).structuredContent;
  assert.ok(usage.accounts.some((a) => a.key === 'claude:a' && a.agent === 'claude'));
  assert.ok(usage.homes.some((h) => h.agent === 'claude' && h.default));
  await call('canban_update_accounts', { label: { key: 'claude:a', name: '個人' } });
  const board = (await call('canban_get_board', { days: 0, account: 'claude:a' })).structuredContent;
  assert.equal(board.accounts.accounts.find((a) => a.key === 'claude:a').label, '個人');
  const ids = board.lists.flatMap((l) => l.cards.map((c) => c.id)); // c2, possibly inside a task card
  assert.ok(ids.length && !ids.some((id) => id.startsWith('codex:')));
});

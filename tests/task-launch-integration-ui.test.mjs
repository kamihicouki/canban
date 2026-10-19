import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read = file => fs.readFileSync(new URL(`../ui/${file}`, import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function node(tag, attrs = {}, ...children) {
  return { tag, ...attrs, value: attrs.value || '', children: children.flat(), classList: { add() {} }, addEventListener() {}, setAttribute() {}, focus() {}, repaint() {},
    replaceChildren(...items) { this.children = items; if (tag === 'select') this.value = items[0]?.value || ''; }, get options() { return this.children; } };
}
async function taskFixture({ agent = 'codex', targets = {}, draft = {}, result = { state: 'opened' }, cancel = { state: 'cancelled' }, accountSwitch = true, activeAccounts = ['claude:a'], route = 'desktop' } = {}) {
  const calls = [], nodes = []; let composer, sections;
  const board = { hosts: [{ local: true, id: 'local' }, { id: 'remote', alias: 'box' }], folders: [], labels: [], settings: { launch: { route, terminal: 'terminal', target: 'new-window' } } };
  const card = { id: 'task:fake', title: 'fake', description: '', target: { agent, cwd: '/work', account: `${agent}:b` }, context: {}, labels: [], links: [], pending: [], status: 'idle' };
  const context = {
    state: { board }, h: (...args) => { const el = node(...args); nodes.push(el); return el; }, pickerButton: options => node('picker', options),
    bridge: { callTool: async (name, args) => { calls.push({ name, args: plain(args) }); if (name === 'canban_launch_targets') return targets; if (name === 'canban_cancel_start_session') return cancel; if (name === 'canban_copy_prompt_images') return { state: 'copied' }; return result; } },
    desktopAccounts: { refresh: async () => ({ accountSwitch, activeAccount: activeAccounts.length > 1 ? activeAccounts.shift() : activeAccounts[0] }), defaultAccount: () => 'claude:b', problem: () => accountSwitch ? null : '認証保持の再確認が必要です' },
    promptComposer: (input, options) => composer = { ...options, input, root: node('composer'), draft, payload: () => ({ imageIds: draft.images?.map(i => i.id) || [] }), setSending: v => { draft.sending = v; }, contextChanged() {}, clear() { draft.images = []; input.value = ''; } },
    workspace: { draftValues: new Map(), trackDrafts() {} }, taskRequestText: () => 'fake prompt', cardListControls: () => node('list'), cardCrumb: () => node('crumb'),
    TASK_SESSIONS_MAX: 5, taskOverlayIds: () => ({ total: 0 }), taskQuickAdd: { button() {}, summary() {} }, sourceDetails() {}, keycap: () => [], keyHint: () => node('hint'), picon: () => '',
    STATUS_LABELS: {}, T: {}, routeLabel: () => 'desktop', shortcutHelp: () => '', optsFromEvent: () => ({}), accountItems: () => [], accountName: x => x,
    renderTaskThreadPane: (p, card, secs) => { sections = secs; }, paintPaneButtons() {}, applyPaneAttrs() {}, sourceRefKey: () => '', load() {}, toast() {}, crypto: { randomUUID: () => 'new-id' },
  };
  const api = new vm.Script(read('task-quick-add-model.js') + '\n' + read('task-detail.js') + '\n({loadTask,taskLaunchLocation,cancelTaskLaunchWait})').runInNewContext(context);
  const pane = { id: card.id, el: node('pane') };
  await api.loadTask(pane, { card, list: { id: 'inbox' } }); await Promise.resolve();
  const start = (opts = {}) => composer.submit(opts);
  return { api, pane, draft, calls, nodes, composer, sections, start };
}

test('task new-request waits for durable cancellation and preserves the original request when cancellation loses', async () => {
  for (const state of ['cancelled', 'opened']) {
    const draft = { launchRequest: { clientRequestId: 'old' }, launchResult: { state: 'waiting-for-quit' } };
    const f = await taskFixture({ draft, cancel: { state } });
    await f.pane.newTaskRequest();
    assert.equal(f.calls.filter(c => c.name === 'canban_cancel_start_session').length, 1);
    assert.equal(draft.launchRequest?.clientRequestId, state === 'cancelled' ? undefined : 'old');
    assert.equal(f.calls.filter(c => c.name === 'canban_start_session').length, 0);
  }
});

test('task edited submit cancels a waiting request before starting; identical retry retains its ID', async () => {
  const f = await taskFixture({ result: { state: 'waiting-for-quit' } });
  await f.start(); await f.start();
  assert.equal(f.calls.filter(c => c.name === 'canban_cancel_start_session').length, 0);
  f.composer.input.value = 'edited'; await f.start();
  assert.deepEqual(f.calls.slice(-2).map(c => c.name), ['canban_cancel_start_session', 'canban_start_session']);
});

test('task preset terminal route uses folder/host without project source claims', async () => {
  const f = await taskFixture({ route: 'terminal', targets: { codex: { projects: [{ id: 'p', root: '/srv/work', hostId: 'remote', sourceRef: { nativeId: 'p' } }] } } });
  f.nodes.find(n => n['aria-label'] === '開始設定').value = 'project:p';
  await f.start();
  const request = f.calls.find(c => c.name === 'canban_start_session').args;
  assert.equal(request.cwd, '/srv/work'); assert.equal(request.hostId, 'remote'); assert.equal(request.account, null);
  assert.equal(request.projectId, undefined); assert.equal(request.sourceRef, undefined);
});

test('task Claude Desktop switch is enabled only after verified capability', async () => {
  for (const accountSwitch of [false, true]) {
    const f = await taskFixture({ agent: 'claude', accountSwitch }); await f.start();
    const request = f.calls.find(c => c.name === 'canban_start_session')?.args;
    if (accountSwitch) assert.equal(request.allowDesktopSwitch, true);
    else assert.equal(request, undefined, 'unverified switching never launches');
  }
});

test('task opened Desktop images retain the composer and an explicit clipboard action', async () => {
  const draft = { images: [{ id: 'fake-image' }] };
  const f = await taskFixture({ draft, targets: { desktopCapabilities: { clipboardImages: true } } });
  await f.start();
  const button = f.nodes.find(n => n.text === '画像をコピー');
  assert.equal(button.hidden, false); assert.equal(button.disabled, false);
  assert.equal(draft.images[0].id, 'fake-image'); assert.equal(f.composer.input.value, 'fake prompt');
  await button.onclick();
  assert.deepEqual(f.calls.at(-1), { name: 'canban_copy_prompt_images', args: { imageIds: ['fake-image'] } });
});

function quickFixture() {
  const calls = [];
  const quick = new vm.Script(read('task-quick-add-model.js') + '\n' + read('task-quick-add.js') + '\ntaskQuickAdd').runInNewContext({
    bridge: { callTool: async (name, args) => { calls.push({ name, args }); return {}; } }, state: { board: { hosts: [{ id: 'remote', alias: 'box' }] } },
  });
  quick.mount = () => {};
  return { quick, calls };
}

test('quick-add uncertain terminal and cloud results can start a new draft without Desktop acknowledge', async () => {
  for (const request of [{ route: 'terminal' }, { route: 'desktop', runOn: 'cloud' }]) {
    const { quick, calls } = quickFixture();
    quick.sessionDraft = { prompt: 'keep', startRequest: { ...request, clientRequestId: 'old' }, startResult: { state: 'uncertain' } };
    await quick.newSessionRequest();
    assert.deepEqual(calls, []); assert.equal(quick.sessionDraft.prompt, 'keep'); assert.equal(quick.sessionDraft.startRequest, undefined);
  }
});

test('quick-add switching saved Desktop projects/environments to terminal preserves only folder/host', () => {
  for (const agent of ['codex', 'claude']) {
    const { quick } = quickFixture();
    quick.targets = { codex: { projects: [{ id: 'project', root: '/srv/work', hostId: 'remote' }] }, claude: { environments: [{ id: 'env', cwd: '/srv/work', kind: 'ssh', sshHost: 'box' }] } };
    quick.sessionDraft = { route: 'desktop', agent, projectId: 'project', environmentId: 'env', account: `${agent}:a`, cwd: '', sourceRef: { nativeId: 'p' } };
    quick.chooseSessionDestination(agent, 'terminal');
    const draft = quick.sessionDraft;
    assert.equal(draft.cwd, '/srv/work'); assert.equal(draft.hostId, 'remote'); assert.equal(draft.account, null); assert.equal(draft.sourceRef, null);
    assert.equal(draft.projectId, '__folder'); assert.equal(draft.environmentId, '__folder');
  }
});


test('task retry keeps its ID when account switching permission changes after recovery', async () => {
  const f = await taskFixture({ agent: 'claude', activeAccounts: ['claude:a', 'claude:b'], result: { state: 'waiting-for-quit' } });
  await f.start(); await f.start();
  assert.equal(f.calls.filter(c => c.name === 'canban_cancel_start_session').length, 0);
  assert.equal(f.calls.filter(c => c.name === 'canban_start_session').length, 2);
});

test('task explicit new request acknowledges uncertain Desktop receipt before replacing ID', async () => {
  const draft = { launchRequest: { clientRequestId: 'old', route: 'desktop', agent: 'claude' }, launchResult: { state: 'uncertain' } };
  const f = await taskFixture({ draft });
  await f.pane.newTaskRequest();
  assert.equal(f.calls.at(-1).name, 'canban_acknowledge_desktop_launch');
  assert.equal(draft.launchRequest, undefined);
});

test('task edited Claude uncertain request keeps its ID until explicitly acknowledged', async () => {
  const draft = { launchRequest: { clientRequestId: 'old', route: 'desktop', agent: 'claude', prompt: 'original' }, launchResult: { state: 'uncertain' } };
  const f = await taskFixture({ agent: 'claude', draft });
  await f.start();
  assert.equal(draft.launchRequest.clientRequestId, 'old');
  assert.equal(f.calls.filter(c => c.name === 'canban_start_session').length, 0);
});

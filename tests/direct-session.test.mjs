import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { makeFixtures } from './helpers.mjs';
import { newSessionLink, newSessionCommand } from '../server/agents.mjs';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-direct-'));
const fx = makeFixtures();
let child, nextId = 0;
const waiting = new Map();
const rpc = (method, params) => new Promise(resolve => {
  const id = ++nextId;
  waiting.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
before(async () => {
  child = spawn(process.execPath, ['tests/fixtures/direct-session-server.mjs'], { cwd: root, stdio: ['pipe', 'pipe', 'inherit'], env: {
    ...process.env, HOME: dataDir, CANBAN_DATA_DIR: dataDir, CANBAN_CODEX_HOME: fx.codexHome,
    CANBAN_CLAUDE_HOME: fx.claudeHome, CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir,
    CANBAN_LAUNCH_DRYRUN: '1', CANBAN_SSH: path.join(dataDir,'ssh-must-not-run'), CANBAN_SEARCH_INDEX: '0', CANBAN_BACKGROUND: '0',
  } });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message); waiting.delete(message.id);
  });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'direct-test', version: '0' } });
});
after(async () => {
  await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  fs.rmSync(dataDir, { recursive: true, force: true }); fx.cleanup();
});

test('direct desktop starts do not create tasks and retry tokens cannot launch changed requests', async () => {
  const tasks = async () => (await call('canban_get_board', { days: 0 })).structuredContent.lists.flatMap(l => l.cards).filter(c => c.kind === 'task').map(c => c.id);
  const before = await tasks();
  for (const agent of ['codex', 'claude']) {
    const args = { agent, cwd: '/r/web', prompt: 'README を確認する', route: 'desktop', clientRequestId: `direct-${agent}` };
    const opened = await call('canban_start_session', args);
    assert.ok(!opened.isError, opened.content?.[0]?.text);
    assert.equal(opened.structuredContent.state, 'opened');
    assert.equal(opened.structuredContent.route, 'desktop');
    assert.match(opened.structuredContent.url, agent === 'codex' ? /^codex:\/\/threads\/new\?/ : /^claude:\/\/code\/new\?/);
    assert.deepEqual((await call('canban_start_session', args)).structuredContent, opened.structuredContent);
    assert.equal((await call('canban_start_session', { ...args, prompt: '別の依頼' })).isError, true);
  }
  assert.deepEqual(await tasks(), before);
  assert.equal((await call('canban_start_session', { agent: 'codex', taskId: 'task:missing', route: 'desktop' })).isError, true);
});

test('desktop starts take the Claude environment and the Codex project / cloud from the apps', async () => {
  const app = path.dirname(fx.desktopDir);
  fs.writeFileSync(path.join(app, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'acct-1' }));
  fs.writeFileSync(path.join(app, 'ssh_configs.json'), JSON.stringify({ configs: [{ id: 'ssh-1', name: 'box', sshHost: 'box' }] }));
  fs.writeFileSync(path.join(app, 'ccd-session-presets.json'), JSON.stringify({ byAccount: {
    'acct-1': { presets: [{ id: 'env-old', name: 'web', lastUsedAt: 1, target: { kind: 'local', cwd: '/r/web' } }, { id: 'env-ssh', name: 'srv', lastUsedAt: 2, target: { kind: 'ssh', sshConfigId: 'ssh-1', cwd: '/srv/app' } }] },
    'acct-other': { presets: [{ id: 'env-x', name: 'other', target: { kind: 'local', cwd: '/x' } }] } } }));
  const state = path.join(fx.codexHome, '.codex-global-state.json');
  fs.writeFileSync(state, JSON.stringify({ 'pinned-thread-ids': ['t1'], 'local-projects': { 'p-web': { id: 'p-web', name: 'web', rootPaths: ['/r/web'] } },
    'remote-projects': [{ id: 'p-srv', hostId: 'remote-ssh-discovered:box', remotePath: '/srv/app', label: 'srv' }], 'project-order': ['p-srv', 'p-web'],
    'environment-catalog-cache-v2': { data: [{ id: 'acct~asenvcfg_web', name: 'web' }] } }));
  const targets = (await call('canban_launch_targets')).structuredContent;
  assert.deepEqual(targets.claude.environments.map(e => [e.id, e.kind, e.sshHost || null]), [['env-ssh', 'ssh', 'box'], ['env-old', 'local', null]], 'only the signed-in account, most recent first');
  assert.deepEqual(targets.codex.projects.map(p => [p.id, p.hostId]), [['p-srv', 'remote-ssh-discovered:box'], ['p-web', 'local']]);
  assert.deepEqual(targets.codex.cloudEnvironments, [{ id: 'asenvcfg_web', name: 'web' }]);

  const ssh = await call('canban_start_session', { agent: 'claude', route: 'desktop', environmentId: 'env-ssh', prompt: '確認', clientRequestId: 'env-ssh-1' });
  assert.equal(ssh.isError, true);
  assert.match(ssh.content[0].text, /完全適用/);
  const local = await call('canban_start_session', { agent: 'claude', route: 'desktop', cwd: '/r/web', prompt: '確認', clientRequestId: 'folder-1' });
  assert.equal(new URL(local.structuredContent.url).searchParams.get('folder'), '/r/web');
  assert.deepEqual(local.structuredContent.selection.selectedRefs, []);
  assert.equal(local.structuredContent.receipt.status, 'unresolved');

  const codex = new URL((await call('canban_start_session', { agent: 'codex', route: 'desktop', projectId: 'p-web', prompt: '確認', clientRequestId: 'p-web-1' })).structuredContent.url);
  assert.deepEqual([codex.searchParams.get('projectId'), codex.searchParams.get('path')], ['p-web', '/r/web']);
  assert.equal((await call('canban_start_session', { agent: 'codex', route: 'desktop', projectId: 'p-srv', prompt: '確認' })).isError, true, 'the Codex link opens only local projects');
  const cloud = await call('canban_start_session', { agent: 'codex', route: 'desktop', runOn: 'cloud', cloudEnvironment: 'asenvcfg_web', prompt: '確認', clientRequestId: 'cloud-1' });
  assert.ok(!cloud.isError, cloud.content?.[0]?.text);
  assert.equal(cloud.structuredContent.route, 'cloud');
  assert.match(cloud.structuredContent.command, /cloud exec --env asenvcfg_web -- /);
  assert.equal(cloud.structuredContent.url, 'https://chatgpt.com/codex/tasks/task_e_dryrun');
  assert.equal((await call('canban_start_session', { agent: 'codex', runOn: 'cloud', prompt: '確認' })).isError, true, 'cloud needs an environment');
});

test('Desktop entry rejects source refs without a matching project and scopes from another home', async () => {
  const ref = { provider: 'codex', identityDomain: 'app-storage', scopeId: '/another-home', kind: 'project', nativeId: 'p-web' };
  for (const extra of [{ sourceRef: ref }, { projectId: 'p-web', sourceRef: ref }]) {
    const result = await call('canban_start_session', { agent: 'codex', route: 'desktop', prompt: 'scope guard', clientRequestId: `scope-${extra.projectId || 'missing'}`, ...extra });
    assert.equal(result.isError, true, 'Desktop entry must not bypass source ownership checks');
    assert.match(result.content[0].text, /projectId|scope|出典/);
  }
});

test('durable Desktop starts retain unresolved evidence without changing manual source plans', async () => {
  const ref = { provider: 'claude', identityDomain: 'preset-account', scopeId: '/planned', kind: 'environment', nativeId: 'planned' };
  const sourceContext = [{ ref }];
  const created = await call('canban_create_task', { title: 'Desktop integration', sourceContext });
  const taskId = (created.structuredContent.result || created.structuredContent).cardId;
  const args = { taskId, agent: 'codex', cwd: '/r/web', prompt: 'unresolved evidence', route: 'desktop', clientRequestId: 'merge-desktop-task' };
  const response = await call('canban_start_session', args);
  assert.ok(!response.isError, response.content[0].text);
  const detail = response.structuredContent;
  assert.equal(detail.state, 'opened');
  assert.equal(detail.selection.requestId, args.clientRequestId);
  assert.equal(detail.receipt.status, 'unresolved');
  assert.deepEqual(detail.receipt.appliedRefs, []);
  assert.deepEqual((await call('canban_get_start_session', { clientRequestId: args.clientRequestId })).structuredContent.result.receipt, detail.receipt);
  assert.deepEqual((await call('canban_start_session', args)).structuredContent, detail);
  const board = (await call('canban_get_board', { days: 0, dotScope: 'all' })).structuredContent;
  const card = board.lists.flatMap(l => l.cards).find(c => c.id === taskId);
  assert.deepEqual(card.sourceContext, sourceContext);
});

test('a remote Codex start cannot silently open a local Desktop session', () => {
  assert.throws(() => newSessionLink('codex', { host: { id: 'remote-ssh-discovered:box', alias: 'box', local: false }, cwd: '/srv', prompt: '確認' }), /ターミナル/);
});

test('a terminal start never runs the agent when changing to the requested folder fails', () => {
  const binDir = path.join(dataDir, 'bin'); fs.mkdirSync(binDir);
  const marker = path.join(dataDir, 'launched');
  fs.writeFileSync(path.join(binDir, 'codex'), '#!/bin/sh\nprintf launched > "$CANBAN_START_MARKER"\n', { mode: 0o700 });
  const command = newSessionCommand('codex', { cwd: path.join(dataDir, 'missing'), prompt: 'hello' });
  spawnSync('/bin/sh', ['-c', command], { env: { PATH: binDir, CANBAN_START_MARKER: marker } });
  assert.equal(fs.existsSync(marker), false);
});

// Receipt and dry-run are confined to this disposable fixture data root.
test('verified remote capability opens an existing Codex thread without a terminal fallback', async () => {
  fs.writeFileSync(path.join(dataDir,'desktop-capabilities.json'), JSON.stringify({version:1,builds:{codex:'1:2:3:4'},codexRemote:{verified:true,modelTurns:0,draftVerified:true}}),{mode:0o600});
  const file=path.join(fx.codexHome,'.codex-global-state.json'), state=JSON.parse(fs.readFileSync(file,'utf8'));
  state['codex-managed-remote-connections']=[{hostId:'remote-ssh-discovered:box',alias:'box'}];
  fs.writeFileSync(file,JSON.stringify(state));
  const preset=await call('canban_start_session',{agent:'codex',route:'desktop',projectId:'p-srv',prompt:'確認',clientRequestId:'remote-preset-unverified'});
  assert.equal(preset.isError,true,'verified remote drafts do not prove complete project preset application');
  assert.match(preset.content[0].text,/完全適用/);
  const args={agent:'codex',route:'desktop',hostId:'remote-ssh-discovered:box',cwd:'/srv/app',prompt:'未送信の下書き',clientRequestId:'remote-existing-1'};
  const response=await call('canban_start_session',args);
  assert.ok(!response.isError,response.content?.[0]?.text);
  assert.equal(response.structuredContent.state,'opened');
  const url=new URL(response.structuredContent.url);
  assert.equal(url.searchParams.get('hostId'),'remote-ssh-discovered:box');
  assert.equal(url.searchParams.get('prompt'),'未送信の下書き');
  assert.notEqual(url.pathname,'/new');
  assert.deepEqual((await call('canban_start_session',args)).structuredContent,response.structuredContent);
  state['codex-managed-remote-connections'][0].sshPort=2222;fs.writeFileSync(file,JSON.stringify(state));
  const claude=await call('canban_start_session',{agent:'claude',route:'desktop',hostId:'remote-ssh-discovered:box',cwd:'/srv/app',prompt:'確認',clientRequestId:'mismatch-port'});
  assert.equal(claude.isError,true,'a different Desktop environment port cannot be guessed');
});

test('Desktop images stay local IDs and never become prompt paths on local or SSH starts',async()=>{
  const file=path.join(fx.codexHome,'.codex-global-state.json'),state=JSON.parse(fs.readFileSync(file,'utf8'));delete state['codex-managed-remote-connections'][0].sshPort;fs.writeFileSync(file,JSON.stringify(state));
  const bytes=fs.readFileSync(path.join(root,'assets','canban.png'));let image;
  for(let offset=0;offset<bytes.length;offset+=128*1024){const r=await call('canban_upload_prompt_image',{...(image?{id:image.id}:{name:'canban.png',mime:'image/png',size:bytes.length}),offset,data:bytes.subarray(offset,offset+128*1024).toString('base64')});image=r.structuredContent.result;}
  for(const agent of ['claude','codex'])for(const remote of [false,true]){
    const args={agent,route:'desktop',prompt:'画像を確認してください',imageIds:[image.id],clientRequestId:`image-${agent}-${remote}`,...(remote?{hostId:'remote-ssh-discovered:box',cwd:'/srv/app'}:{cwd:'/r/web'})};
    const response=await call('canban_start_session',args);assert.ok(!response.isError,response.content?.[0]?.text);
    assert.equal(response.structuredContent.state,'opened');const url=new URL(response.structuredContent.url);
    assert.equal(url.searchParams.get(agent==='claude'?'q':'prompt'),args.prompt);
    assert.deepEqual(response.structuredContent.imageIds,[image.id]);assert.equal(response.structuredContent.attachmentState,'pending-paste');
  }
});

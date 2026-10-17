import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const modulePath = '../server/claude-desktop-accounts.mjs';
const rootsPath = '../server/claude-desktop-roots.mjs';
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canban-desktop-account-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'canban'), appDir = path.join(root, 'Claude');
  await fs.mkdir(dataDir); await fs.mkdir(appDir);
  await fs.writeFile(path.join(appDir, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'a', privateValue: 'never-copy-this' }));
  await fs.writeFile(path.join(appDir, 'conversation'), 'A conversation');
  for (const name of ['cli-a', 'cli-b']) {
    await fs.mkdir(path.join(root, name));
    await fs.writeFile(path.join(root, name, 'auth'), name + ' credential');
  }
  return { root, dataDir, appDir };
}

test('enroll-current records only the Desktop mapping and leaves CLI sessions intact', async t => {
  const { createDesktopAccounts } = await import(modulePath);
  const { readDesktopProfileRoots } = await import(rootsPath);
  const f = await fixture(t);
  let keychainCalls = 0;
  const service = createDesktopAccounts({ ...f, runtime: async () => { keychainCalls++; throw Error('must not inspect credentials'); } });
  assert.deepEqual((await service.view()).profiles, []);
  const enrolled = await service.command({ type: 'enroll-current', account: 'claude:a' });
  assert.equal(enrolled.state, 'prepared');
  assert.match(enrolled.profileId, /^[0-9a-f-]{36}$/);
  assert.equal((await service.view()).profiles[0].account, 'claude:a');
  const mapping = path.join(f.dataDir, 'desktop-accounts', 'claude', 'registry.json');
  const registry = JSON.parse(await fs.readFile(mapping, 'utf8'));
  assert.deepEqual(Object.keys(registry).sort(), ['profiles', 'version']);
  assert.deepEqual(Object.keys(registry.profiles[0]).sort(), ['account', 'active', 'dir', 'id']);
  assert.equal(registry.profiles[0].active, true);
  assert.equal(registry.profiles[0].dir, await fs.realpath(f.appDir));
  assert.equal((await fs.stat(mapping)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(mapping))).mode & 0o777, 0o700);
  assert.doesNotMatch(await fs.readFile(mapping, 'utf8'), /never-copy-this|credential/);
  assert.equal((await readDesktopProfileRoots(f))[0].sessionsDir, path.join(await fs.realpath(f.appDir), 'claude-code-sessions'));
  assert.equal((await service.command({ type: 'enroll-current', account: 'claude:a' })).profileId, enrolled.profileId);
  assert.equal((await service.view()).profiles.length, 1);
  for (const name of ['cli-a', 'cli-b']) assert.equal(await fs.readFile(path.join(f.root, name, 'auth'), 'utf8'), name + ' credential');
  assert.equal(await fs.readFile(path.join(f.appDir, 'conversation'), 'utf8'), 'A conversation');
  assert.equal(keychainCalls, 0);
});

test('wrong or malformed account is rejected before any state is created', async t => {
  const { createDesktopAccounts } = await import(modulePath);
  const f = await fixture(t), service = createDesktopAccounts(f);
  for (const account of ['claude:b', 'codex:a', 'claude:../a', '', null]) {
    await assert.rejects(service.command({ type: 'enroll-current', account }));
    await assert.rejects(fs.stat(path.join(f.dataDir, 'desktop-accounts')), { code: 'ENOENT' });
  }
});

test('symlink roots and an unexpected file at the managed location are never overwritten', async t => {
  const { createDesktopAccounts } = await import(modulePath);
  const f = await fixture(t), linked = path.join(f.root, 'linked-Claude');
  await fs.symlink(f.appDir, linked);
  await assert.rejects(createDesktopAccounts({ ...f, appDir: linked }).command({ type: 'enroll-current', account: 'claude:a' }), /実ディレクトリ/);
  const managed = path.join(f.dataDir, 'desktop-accounts');
  await fs.writeFile(managed, 'do not overwrite');
  await assert.rejects(createDesktopAccounts(f).command({ type: 'enroll-current', account: 'claude:a' }));
  assert.equal(await fs.readFile(managed, 'utf8'), 'do not overwrite');
});

test('profile validation rejects a different owner or filesystem', async t => {
  const { inspectProfileDirectory } = await import(rootsPath);
  const f = await fixture(t), st = await fs.stat(f.appDir, { bigint: true });
  await assert.rejects(inspectProfileDirectory(f.appDir, { uid: Number(st.uid) + 1 }), /所有者/);
  await assert.rejects(inspectProfileDirectory(f.appDir, { device: String(st.dev + 1n) }), /同じファイルシステム/);
});

test('untrusted registry paths and symlink metadata cannot expose another profile', async t => {
  const { createDesktopAccounts } = await import(modulePath);
  const { readDesktopProfileRoots } = await import(rootsPath);
  const f = await fixture(t), service = createDesktopAccounts(f);
  await service.command({ type: 'enroll-current', account: 'claude:a' });
  const file = path.join(f.dataDir, 'desktop-accounts', 'claude', 'registry.json');
  const registry = JSON.parse(await fs.readFile(file, 'utf8'));
  registry.profiles[0].dir = path.join(f.root, 'cli-a');
  await fs.writeFile(file, JSON.stringify(registry));
  await assert.rejects(readDesktopProfileRoots(f), /保存先/);
  await fs.unlink(file); await fs.symlink(path.join(f.appDir, 'config.json'), file);
  await assert.rejects(service.view(), /通常ファイル/);
});

async function onboarding(t, overrides = {}) {
  const { createDesktopAccounts } = await import(modulePath);
  const f = await fixture(t), opened = [];
  const backup = async ({ requestId, profiles }) => {
    const dir = path.join(f.root, 'backups', requestId);
    await fs.mkdir(dir, { recursive: true });
    for (const p of profiles) await fs.cp(p.dir, path.join(dir, p.id), { recursive: true });
    return dir;
  };
  const options = { ...f, runtime: async () => ({ running: false }), backup, open: async x => opened.push(x), ...overrides };
  const service = createDesktopAccounts(options);
  await service.command({ type: 'enroll-current', account: 'claude:a' });
  return { ...f, service, opened, options };
}

test('first Desktop login holds the old login and never binds the wrong account to CLI', async t => {
  const f = await onboarding(t);
  const begin = await f.service.command({ type: 'begin-login', account: 'claude:b', requestId: 'connect-b' });
  assert.equal(begin.state, 'waiting-for-login');
  assert.equal((await f.service.view()).profiles.some(p => p.account === 'claude:b'), false);
  await fs.writeFile(path.join(f.appDir, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'wrong-account' }));
  const wrong = await f.service.command({ type: 'finish-login', account: 'claude:b' });
  assert.equal(wrong.state, 'waiting-for-login');
  assert.equal((await f.service.view()).profiles.some(p => p.account === 'claude:wrong-account'), false);
  assert.equal((await f.service.view()).profiles.some(p => p.account === 'claude:b'), false);
  await fs.writeFile(path.join(f.appDir, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'b' }));
  assert.equal((await f.service.command({ type: 'finish-login', account: 'claude:b' })).state, 'prepared');
  assert.equal((await f.service.command({ type: 'finish-login', account: 'claude:b' })).state, 'prepared');
  assert.equal((await f.service.view()).profiles.find(p => p.active).account, 'claude:b');
  assert.equal((await f.service.withAccount('claude:a', { requestId: 'back-a', allowSwitch: true }, () => ({ state: 'opened' }))).state, 'opened');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.appDir, 'config.json'), 'utf8')).privateValue, 'never-copy-this');
  for (const name of ['cli-a', 'cli-b']) assert.equal(await fs.readFile(path.join(f.root, name, 'auth'), 'utf8'), name + ' credential');
  assert.equal(f.opened[0].purpose, 'login');
});

test('cancelling initial Desktop login restores A and retains the unconnected profile', async t => {
  const f = await onboarding(t);
  const begin = await f.service.command({ type: 'begin-login', account: 'claude:b', requestId: 'cancel-b' });
  await fs.writeFile(path.join(f.appDir, 'unsent-draft'), 'keep this registration draft');
  assert.equal((await f.service.command({ type: 'cancel', requestId: 'restore-a' })).state, 'cancelled');
  assert.equal((await f.service.view()).profiles.find(p => p.active).account, 'claude:a');
  assert.equal(await fs.readFile(path.join(f.dataDir, 'desktop-accounts', 'claude', 'profiles', begin.profileId, 'unsent-draft'), 'utf8'), 'keep this registration draft');
  assert.equal((await f.service.view()).pending.active, false);
  assert.equal(f.opened.at(-1).purpose, 'restore');
});

test('a runtime status failure keeps login state and asks for a state recheck', async t => {
  const f = await onboarding(t, { runtime: async () => { throw Error('network unavailable'); } });
  const original = await fs.readFile(path.join(f.appDir, 'config.json'), 'utf8');
  const result = await f.service.withAccount('claude:a', { requestId: 'uncertain-runtime' }, () => assert.fail('must not open an unconfirmed profile'));
  assert.equal(result.state, 'waiting-for-quit');
  assert.notEqual(result.state, 'waiting-for-login');
  assert.equal(await fs.readFile(path.join(f.appDir, 'config.json'), 'utf8'), original);
});

test('Desktop environments are resolved only for their expected account', async t => {
  const { claudeEnvironments } = await import('../server/sources/launch-targets.mjs');
  const f = await fixture(t);
  await fs.writeFile(path.join(f.appDir, 'ccd-session-presets.json'), JSON.stringify({ byAccount: { a: { presets: [{ id: 'env-a', name: 'A work', target: { kind: 'local', cwd: '/work/a' } }] } } }));
  assert.deepEqual((await claudeEnvironments(f.appDir, { expectedAccount: 'claude:b' })).environments, []);
  assert.equal((await claudeEnvironments(f.appDir, { expectedAccount: 'claude:a' })).environments[0].id, 'env-a');
});

test('aliases of the configured Canban data root share the same lifecycle lock', async t => {
  const { createDesktopAccounts } = await import(modulePath);
  const f = await onboarding(t), alias = path.join(f.root, 'data-link');
  await fs.symlink(f.dataDir, alias);
  const other = createDesktopAccounts({ ...f.options, dataDir: alias });
  assert.equal((await other.view()).profiles[0].account, 'claude:a');
  await other.withAccount('claude:a', {}, async () => {
    await assert.rejects(f.service.withAccount('claude:a', {}, () => {}), { code: 'desktop_busy' });
  });
});

test('the existing Desktop gateway delegates a registered account without changing CLI selection', async t => {
  const { withDesktopAccount } = await import('../server/claude-desktop-profile.mjs');
  const f = await onboarding(t);
  await f.service.command({ type: 'begin-login', account: 'claude:b', requestId: 'delegate-b' });
  await fs.writeFile(path.join(f.appDir, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'b' }));
  await f.service.command({ type: 'finish-login', account: 'claude:b' });
  const previous = process.env.CANBAN_CLAUDE_DESKTOP_DIR;
  process.env.CANBAN_CLAUDE_DESKTOP_DIR = path.join(f.appDir, 'claude-code-sessions');
  t.after(() => { if (previous === undefined) delete process.env.CANBAN_CLAUDE_DESKTOP_DIR; else process.env.CANBAN_CLAUDE_DESKTOP_DIR = previous; });
  const result = await withDesktopAccount('claude:a', status => ({ openedAs: status.account }), { accounts: f.service, allowSwitch: true, requestId: 'delegate-a' });
  assert.equal(result.openedAs, 'claude:a');
  assert.equal(await fs.readFile(path.join(f.root, 'cli-b', 'auth'), 'utf8'), 'cli-b credential');
});

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

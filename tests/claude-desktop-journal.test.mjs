import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const B = '22222222-2222-4222-8222-222222222222';
async function setup(t, adapters = {}) {
  const { createDesktopAccounts } = await import('../server/claude-desktop-accounts.mjs');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canban-desktop-swap-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data'), appDir = path.join(root, 'Claude');
  await fs.mkdir(dataDir); await fs.mkdir(appDir);
  await fs.writeFile(path.join(appDir, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'a' }));
  await fs.writeFile(path.join(appDir, 'conversation'), 'A saved conversation and cookie');
  const state = path.join(dataDir, 'desktop-accounts', 'claude');
  const options = { dataDir, appDir, runtime: async () => ({ running: false }),
    backup: async ({ requestId, profiles }) => {
      const dir = path.join(root, 'backups', requestId);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      for (const p of profiles) await fs.cp(p.dir, path.join(dir, p.id), { recursive: true });
      return dir;
    }, ...adapters };
  const service = createDesktopAccounts(options);
  const a = await service.command({ type: 'enroll-current', account: 'claude:a' });
  const bDir = path.join(state, 'profiles', B);
  await fs.mkdir(bDir);
  await fs.writeFile(path.join(bDir, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'b' }));
  await fs.writeFile(path.join(bDir, 'conversation'), 'B saved conversation and cookie');
  const registry = JSON.parse(await fs.readFile(path.join(state, 'registry.json'), 'utf8'));
  registry.profiles.push({ id: B, account: 'claude:b', active: false, dir: bDir });
  await fs.writeFile(path.join(state, 'registry.json'), JSON.stringify(registry));
  return { root, dataDir, appDir, state, service, options, a: a.profileId, bDir, create: overrides => createDesktopAccounts({ ...options, ...overrides }) };
}
const open = () => ({ state: 'opened' });
const switchTo = (service, account, requestId = 'switch-b') => service.withAccount(account, { requestId, allowSwitch: true }, open);

test('same account keeps the app running and holds the lifecycle lock through open', async t => {
  let quitCalls = 0;
  const f = await setup(t, { quit: async () => { quitCalls++; } });
  const service = f.create({ runtime: async () => ({ running: true, profileDir: await fs.realpath(f.appDir) }) });
  const result = await service.withAccount('claude:a', { requestId: 'same' }, async () => {
    await assert.rejects(switchTo(f.service, 'claude:b'), { code: 'desktop_busy' });
    return { state: 'opened' };
  });
  assert.equal(result.state, 'opened');
  assert.equal(quitCalls, 0);
  assert.equal(await fs.readFile(path.join(f.appDir, 'conversation'), 'utf8'), 'A saved conversation and cookie');
});

test('A-B-A preserves both profile trees and does not touch CLI authentication', async t => {
  const f = await setup(t);
  const cli = path.join(f.root, '.claude'); await fs.mkdir(cli);
  await fs.writeFile(path.join(cli, '.credentials.json'), 'CLI A stays signed in');
  assert.equal((await switchTo(f.service, 'claude:b')).state, 'opened');
  assert.equal(await fs.readFile(path.join(f.appDir, 'conversation'), 'utf8'), 'B saved conversation and cookie');
  assert.equal(await fs.readFile(path.join(f.state, 'profiles', f.a, 'conversation'), 'utf8'), 'A saved conversation and cookie');
  assert.equal((await switchTo(f.service, 'claude:a', 'switch-a')).state, 'opened');
  assert.equal(await fs.readFile(path.join(f.appDir, 'conversation'), 'utf8'), 'A saved conversation and cookie');
  assert.equal(await fs.readFile(path.join(f.bDir, 'conversation'), 'utf8'), 'B saved conversation and cookie');
  assert.equal(await fs.readFile(path.join(cli, '.credentials.json'), 'utf8'), 'CLI A stays signed in');
  await assert.rejects(fs.stat(path.join(f.state, 'switch.json')), { code: 'ENOENT' });
});

test('busy or unconfirmed Desktop waits without quitting or changing either profile', async t => {
  let quitCalls = 0, openCalls = 0;
  const f = await setup(t, { quit: async () => { quitCalls++; } });
  for (const status of [{ running: true, busy: true, draftsSaved: true }, { running: true, busy: false }, { running: true, busy: false, draftsSaved: true, profileDir: null }]) {
    const service = f.create({ runtime: async () => status });
    const result = await service.withAccount('claude:b', { requestId: 'wait', allowSwitch: true, allowQuit: true }, () => { openCalls++; });
    assert.equal(result.state, 'waiting-for-quit');
  }
  assert.equal(quitCalls, 0); assert.equal(openCalls, 0);
  assert.equal(await fs.readFile(path.join(f.appDir, 'conversation'), 'utf8'), 'A saved conversation and cookie');
  assert.equal(await fs.readFile(path.join(f.bDir, 'conversation'), 'utf8'), 'B saved conversation and cookie');
});

test('a stopped Desktop still requires an explicit switch operation', async t => {
  const f = await setup(t);
  assert.notEqual((await f.service.withAccount('claude:b', { requestId: 'cli-selection' }, open)).state, 'opened');
  assert.equal(await fs.readFile(path.join(f.appDir, 'conversation'), 'utf8'), 'A saved conversation and cookie');
});

for (const afterMove of [1, 2]) test(`crash after rename ${afterMove} recovers from durable intent`, async t => {
  const { moveProfileDirectory } = await import('../server/claude-desktop-journal.mjs');
  let moves = 0;
  const f = await setup(t, { move: async (from, to) => { await moveProfileDirectory(from, to); if (++moves === afterMove) throw Error('simulated connection loss'); } });
  await assert.rejects(switchTo(f.service, 'claude:b'), /simulated connection loss/);
  assert.equal((await fs.stat(path.join(f.state, 'switch.json'))).mode & 0o777, 0o600);
  const recovered = await f.create({ move: moveProfileDirectory }).command({ type: 'recover' });
  assert.equal(recovered.state, 'prepared');
  const expected = afterMove === 1 ? 'A saved conversation and cookie' : 'B saved conversation and cookie';
  assert.equal(await fs.readFile(path.join(f.appDir, 'conversation'), 'utf8'), expected);
  const view = await f.service.view();
  assert.equal(view.profiles.find(p => p.active).account, afterMove === 1 ? 'claude:a' : 'claude:b');
  assert.equal(view.profiles.length, 2);
});

test('external recreation of the standard path is preserved and recovery stops', async t => {
  const { moveProfileDirectory } = await import('../server/claude-desktop-journal.mjs');
  let moves = 0;
  const f = await setup(t, { move: async (from, to) => {
    await moveProfileDirectory(from, to);
    if (++moves === 1) { await fs.mkdir(from); await fs.writeFile(path.join(from, 'external'), 'new external profile'); }
  } });
  await assert.rejects(switchTo(f.service, 'claude:b'));
  await assert.rejects(f.create({ move: moveProfileDirectory }).command({ type: 'recover' }));
  assert.equal(await fs.readFile(path.join(f.appDir, 'external'), 'utf8'), 'new external profile');
  assert.equal(await fs.readFile(path.join(f.state, 'profiles', f.a, 'conversation'), 'utf8'), 'A saved conversation and cookie');
  assert.equal(await fs.readFile(path.join(f.bDir, 'conversation'), 'utf8'), 'B saved conversation and cookie');
});

test('exclusive directory rename never overwrites an existing empty destination', async t => {
  const { moveProfileDirectory } = await import('../server/claude-desktop-journal.mjs');
  const f = await setup(t), destination = path.join(f.root, 'external');
  await fs.mkdir(destination);
  const inode = (await fs.stat(destination)).ino;
  await assert.rejects(moveProfileDirectory(f.appDir, destination));
  assert.equal((await fs.stat(destination)).ino, inode);
  assert.equal(await fs.readFile(path.join(f.appDir, 'conversation'), 'utf8'), 'A saved conversation and cookie');
});

test('guest restore failure prevents parking the active profile', async t => {
  const f = await setup(t, { restoreGuests: async () => ({ problems: ['guest write-back failed'] }) });
  await assert.rejects(switchTo(f.service, 'claude:b'), /guest write-back failed/);
  assert.equal(await fs.readFile(path.join(f.appDir, 'conversation'), 'utf8'), 'A saved conversation and cookie');
  await assert.rejects(fs.stat(path.join(f.state, 'switch.json')), { code: 'ENOENT' });
});

test('losing the lifecycle lease stops the next rename without losing either tree', async t => {
  const { moveProfileDirectory } = await import('../server/claude-desktop-journal.mjs');
  let moves = 0, f;
  f = await setup(t, { move: async (from, to) => {
    await moveProfileDirectory(from, to); moves++;
    await fs.writeFile(path.join(f.state, 'lifecycle.lock', 'owner.json'), JSON.stringify({ pid: process.pid, generation: 'replacement' }));
  } });
  await assert.rejects(switchTo(f.service, 'claude:b'), { code: 'desktop_busy' });
  assert.equal(moves, 1);
  assert.equal(await fs.readFile(path.join(f.state, 'profiles', f.a, 'conversation'), 'utf8'), 'A saved conversation and cookie');
  assert.equal(await fs.readFile(path.join(f.bDir, 'conversation'), 'utf8'), 'B saved conversation and cookie');
});

test('guest watcher uses the same lifecycle lock and nested restore does not deadlock', async t => {
  const { restoreGuests } = await import('../server/claude-desktop-guests.mjs');
  const f = await setup(t);
  const state = path.join(f.dataDir, 'desktop-integrated');
  const paths = { state, dataDir: f.dataDir, app: f.appDir, sessions: path.join(f.appDir, 'claude-code-sessions'), ledger: path.join(state, 'ledger.json') };
  let wake;
  const gate = new Promise(resolve => { wake = resolve; });
  const watcher = (async () => { await gate; return restoreGuests({ paths }); })();
  const service = f.create({ restoreGuests: () => restoreGuests({ paths }), backup: async input => {
    wake(); await assert.rejects(watcher, { code: 'desktop_busy' });
    return f.options.backup(input);
  } });
  assert.equal((await switchTo(service, 'claude:b')).state, 'opened');
  assert.equal(await fs.readFile(path.join(f.appDir, 'conversation'), 'utf8'), 'B saved conversation and cookie');
});

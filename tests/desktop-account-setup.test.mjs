import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDesktopAccounts } from '../server/claude-desktop-accounts.mjs';
import { backupDesktopProfiles } from '../server/desktop-backup.mjs';
import { readDesktopCapabilities } from '../server/desktop-capabilities.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canban-setup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data'), appDir = path.join(root, 'Claude');
  await fs.mkdir(dataDir); await fs.mkdir(appDir);
  await fs.writeFile(path.join(appDir, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'a' }));
  let running = false, opens = 0;
  const runtime = async () => ({ running, profileDir: running ? appDir : null });
  const accounts = createDesktopAccounts({ dataDir, appDir, runtime, backup: x => backupDesktopProfiles({ dataDir, ...x }), open: async () => { opens++; running = true; } });
  const mod = await import('../server/desktop-account-setup.mjs').catch(() => ({}));
  assert.equal(typeof mod.createDesktopAccountSetup, 'function', 'initial connection must have a service independent of the normal switching gate');
  const builds = { claude: 'test-claude', codex: 'test-codex' };
  let currentBuilds = builds;
  const setup = mod.createDesktopAccountSetup({ dataDir, appDir, accounts, runtime, builds: async () => currentBuilds, platform: 'darwin', open: async () => { opens++; running = true; } });
  return { dataDir, appDir, setup, builds, accounts, runtime, stopped: () => { running = false; }, update: () => { currentBuilds = { ...builds, claude: 'updated' }; }, opens: () => opens };
}
async function connectB(f) {
  await f.setup.command({ type: 'enroll-current', account: 'claude:a' });
  await f.setup.command({ type: 'begin-login', account: 'claude:b', requestId: 'connect-b' });
  await fs.writeFile(path.join(f.appDir, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'b' }));
  await f.setup.command({ type: 'finish-login', account: 'claude:b' });
}

test('unverified setup permits initial connection, retained candidates and restoration without enabling normal switching', async t => {
  const f = await fixture(t);
  assert.equal((await f.setup.view()).activeAccount, 'claude:a');
  assert.equal((await f.setup.view()).accountSwitch, false);
  await f.setup.command({ type: 'enroll-current', account: 'claude:a' });
  const login = await f.setup.command({ type: 'begin-login', account: 'claude:b', requestId: 'login-b' });
  assert.equal(login.state, 'waiting-for-login');
  f.stopped();
  assert.equal((await f.setup.command({ type: 'cancel', requestId: 'cancel-b' })).state, 'cancelled');
  f.stopped();
  assert.equal((await f.setup.command({ type: 'begin-login', account: 'claude:b', requestId: 'retry-b' })).profileId, login.profileId);
  await fs.writeFile(path.join(f.appDir, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'b' }));
  assert.equal((await f.setup.command({ type: 'finish-login', account: 'claude:b' })).state, 'prepared');
  assert.equal((await f.setup.view()).accountSwitch, false);
  await assert.rejects(f.setup.command({ type: 'switch', account: 'claude:a' }));
});

test('setup persists a quit wait, resumes after restart, and can cancel the wait without changing profiles', async t => {
  const f = await fixture(t); await connectB(f);
  const waiting = await f.setup.command({ type: 'trial-start', account: 'claude:a', requestId: 'trial' });
  assert.equal(waiting.state, 'ready');
  assert.equal((await f.setup.command({ type: 'trial-switch', requestId: 'switch-1' })).state, 'waiting-for-quit');
  assert.equal((await f.setup.view()).setup.pendingCommand.requestId, 'switch-1');
  await f.setup.command({ type: 'cancel-wait' });
  f.stopped(); await f.setup.recover();
  assert.equal((await f.accounts.view()).profiles.find(p => p.active).account, 'claude:b');
  assert.equal(f.opens(), 1);
});

test('acceptance requires six observed transitions and explicit history, CLI, draft and Dock confirmation', async t => {
  const f = await fixture(t); await connectB(f);
  await f.setup.command({ type: 'trial-start', account: 'claude:a', requestId: 'trial-3' });
  await assert.rejects(f.setup.command({ type: 'trial-complete', confirmations: {} }));
  for (let i = 0; i < 6; i++) {
    f.stopped();
    assert.equal((await f.setup.command({ type: 'trial-switch', requestId: `step-${i}` })).state, 'awaiting-observation');
    assert.equal((await f.setup.view()).accountSwitch, false);
    await f.setup.command({ type: 'trial-observe', confirmations: { authenticated: true, noLogin: true, draftsPreserved: true } });
  }
  await assert.rejects(f.setup.command({ type: 'trial-complete', confirmations: { cliPreserved: true } }));
  assert.equal((await readDesktopCapabilities(f.dataDir, { builds: f.builds, platform: 'darwin' })).accountSwitch, false);
  await f.setup.command({ type: 'trial-complete', confirmations: { cliPreserved: true, desktopPreserved: true, draftsPreserved: true, historyPreserved: true, writebackPreserved: true, dockPreserved: true, messagesSentByUser: true } });
  assert.equal((await f.setup.view()).accountSwitch, true);
  f.update();
  const outdated=await f.setup.view();
  assert.equal(outdated.accountSwitch, false);
  assert.equal(outdated.setup.trial.state,'needs-review');
  assert.equal(outdated.profiles.every(p=>p.status==='needs-verification'),true);
});

test('a changed build, wrong identity or unobserved login cannot produce a capability receipt', async t => {
  const f = await fixture(t); await connectB(f);
  await f.setup.command({ type: 'trial-start', account: 'claude:a', requestId: 'trial-wrong' });
  f.stopped(); await f.setup.command({ type: 'trial-switch', requestId: 'trial-wrong-step' });
  await fs.writeFile(path.join(f.appDir, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'wrong' }));
  await assert.rejects(f.setup.command({ type: 'trial-observe', confirmations: { authenticated: true, noLogin: true, draftsPreserved: true } }));
  assert.equal((await readDesktopCapabilities(f.dataDir, { builds: f.builds, platform: 'darwin' })).accountSwitch, false);
});

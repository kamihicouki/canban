import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureAccounts, resetAccountsForTest } from '../server/accounts.mjs';
import { desktopProfilePlan, withDesktopAccount, desktopExecutionLink, setDesktopProcessCheck } from '../server/claude-desktop-profile.mjs';

let root, app, first, second, previousEnv, previousCheck;
const options = { platform: 'darwin' };
const id = '11111111-2222-3333-4444-555555555555';
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'canban-desktop-profile-'));
  app = path.join(root, 'Claude'); first = path.join(root, 'Claude-Profiles', 'first'); second = path.join(root, 'Claude-Profiles', 'second');
  for (const [dir, account] of [[first, 'first'], [second, 'second']]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ lastKnownAccountUuid: account, fixtureCredential: `SECRET-${account}` }));
    await fs.writeFile(path.join(dir, 'history'), `${account}-history`);
  }
  await fs.symlink(first, app);
  previousEnv = process.env.CANBAN_CLAUDE_DESKTOP_DIR;
  process.env.CANBAN_CLAUDE_DESKTOP_DIR = path.join(app, 'claude-code-sessions');
  resetAccountsForTest(); configureAccounts({ discover: true });
  previousCheck = setDesktopProcessCheck(async () => false);
});
afterEach(async () => {
  setDesktopProcessCheck(previousCheck);
  if (previousEnv === undefined) delete process.env.CANBAN_CLAUDE_DESKTOP_DIR; else process.env.CANBAN_CLAUDE_DESKTOP_DIR = previousEnv;
  resetAccountsForTest(); await fs.rm(root, { recursive: true, force: true });
});

test('normal startup reads the chosen Desktop account after switching and rediscovery; data is untouched', async () => {
  const before = await Promise.all([first, second].flatMap(dir => ['config.json', 'history'].map(file => fs.readFile(path.join(dir, file)))));
  assert.equal((await desktopProfilePlan('claude:second', options)).change, true);
  const result = await withDesktopAccount('claude:second', async desktop => desktop, options);
  assert.equal(result.maintained, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(app, 'config.json'))).lastKnownAccountUuid, 'second');
  assert.equal((await desktopProfilePlan('claude:second', options)).change, false);
  assert.deepEqual(await Promise.all([first, second].flatMap(dir => ['config.json', 'history'].map(file => fs.readFile(path.join(dir, file))))), before);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test('running Desktop, overlapping switches, and callback failure protect the existing profile', async () => {
  setDesktopProcessCheck(async () => true);
  await assert.rejects(withDesktopAccount('claude:second', async () => {}, options), /Desktop を終了/);
  assert.equal(await fs.realpath(app), await fs.realpath(first));
  setDesktopProcessCheck(async () => false);
  await withDesktopAccount('claude:second', async () => {
    await assert.rejects(withDesktopAccount('claude:first', async () => {}, options), /切替が進行中/);
  }, options);
  await assert.rejects(withDesktopAccount('claude:first', async () => { throw new Error('commit failed'); }, options), /commit failed/);
  assert.equal(await fs.realpath(app), await fs.realpath(second));
  assert.equal((await fs.readdir(root)).some(name => name.includes('.lock') || name.includes('.canban-')), false);
});

test('unknown account and a regular data directory are never replaced or migrated', async () => {
  assert.equal((await desktopProfilePlan('claude:unknown', options)).available, false);
  await assert.rejects(withDesktopAccount('claude:unknown', async () => {}, options), /プロフィールがありません/);
  await fs.unlink(app); await fs.mkdir(app);
  await fs.writeFile(path.join(app, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'first' }));
  await assert.rejects(withDesktopAccount('claude:second', async () => {}, options), /リンクになっていません/);
  assert.equal((await fs.lstat(app)).isDirectory(), true);
});

test('a legacy duplicate does not prevent selecting the current switcher family', async () => {
  const legacy = path.join(root, 'Claude-second');
  await fs.mkdir(legacy);
  await fs.writeFile(path.join(legacy, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'second' }));
  const plan = await desktopProfilePlan('claude:second', options);
  assert.equal(plan.available, true);
  assert.equal(plan.dir, await fs.realpath(second));
  assert.equal(plan.profile, 'second');
  // Two matching profiles in the active family remain ambiguous.
  const duplicate = path.join(root, 'Claude-Profiles', 'second-copy');
  await fs.mkdir(duplicate);
  await fs.writeFile(path.join(duplicate, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'second' }));
  assert.equal((await desktopProfilePlan('claude:second', options)).available, false);
});

test('continue requires matching metadata reachable from the selected account; CLI imports require the real transcript', async () => {
  const session = { agent: 'claude', nativeId: id, desktopSessionId: 'local_kept', cwd: root };
  const cliHome = path.join(root, 'cli'), projects = path.join(cliHome, 'projects', 'worktree');
  await fs.mkdir(projects, { recursive: true });
  session.sourcePath = path.join(projects, `${id}.jsonl`);
  await fs.writeFile(session.sourcePath, 'existing conversation');
  const metadataDir = path.join(second, 'claude-code-sessions', 'second', 'org');
  await fs.mkdir(metadataDir, { recursive: true });
  const metadata = path.join(metadataDir, 'local_kept.json');
  await fs.writeFile(metadata, JSON.stringify({ sessionId: 'local_kept', cliSessionId: id }));
  assert.equal((await desktopExecutionLink(session, 'claude:second', { ...options, cliHome })).url, 'claude://code/continue?session=local_kept');
  await fs.writeFile(metadata, JSON.stringify({ sessionId: 'local_kept', cliSessionId: 'other-session' }));
  assert.equal((await desktopExecutionLink(session, 'claude:second', { ...options, cliHome })).url, `claude://resume?session=${id}`);
  assert.equal((await desktopExecutionLink(session, 'claude:second', { ...options, cliHome })).url, `claude://resume?session=${id}`);
  await fs.writeFile(metadata, JSON.stringify({ sessionId: 'local_kept', cliSessionId: id }));
  session.sourcePath = path.join(root, 'unreachable.jsonl');
  await fs.writeFile(session.sourcePath, 'different conversation');
  assert.equal(await desktopExecutionLink(session, 'claude:second', { ...options, cliHome }), null);
});

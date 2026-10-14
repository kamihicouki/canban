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

test('Desktop is used only for the signed-in account; profiles and links are never switched', async () => {
  const before = await Promise.all([first, second].flatMap(dir => ['config.json', 'history'].map(file => fs.readFile(path.join(dir, file)))));
  const same = await desktopProfilePlan('claude:first', options);
  assert.equal(same.available, true);
  assert.equal(same.change, false);
  const result = await withDesktopAccount('claude:first', async desktop => desktop, options);
  assert.equal(result.maintained, true);
  const other = await desktopProfilePlan('claude:second', options);
  assert.equal(other.available, false);
  assert.match(other.reason, /ログインを切り替える/);
  await assert.rejects(withDesktopAccount('claude:second', async () => {}, options), error => error.code === 'desktop_unavailable');
  assert.equal(await fs.realpath(app), await fs.realpath(first));
  assert.deepEqual(await Promise.all([first, second].flatMap(dir => ['config.json', 'history'].map(file => fs.readFile(path.join(dir, file))))), before);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test('a running Desktop must be confirmed to have the signed-in folder open', async () => {
  setDesktopProcessCheck(async () => true);
  await assert.rejects(withDesktopAccount('claude:first', async () => {}, options), error => error.code === 'desktop_running');
  setDesktopProcessCheck(async () => ({ running: true, profileDir: await fs.realpath(first) }));
  assert.equal(await withDesktopAccount('claude:first', async () => 'opened', options), 'opened');
});

test('the pure layout (one real folder) works the same and is never replaced', async () => {
  await fs.unlink(app); await fs.mkdir(app);
  await fs.writeFile(path.join(app, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'second' }));
  assert.equal((await desktopProfilePlan('claude:second', options)).available, true);
  await assert.rejects(withDesktopAccount('claude:first', async () => {}, options), /ログインを切り替える/);
  assert.equal((await fs.lstat(app)).isDirectory(), true);
  assert.equal((await desktopProfilePlan('claude:unknown', options)).available, false);
});

test('continue requires matching metadata reachable from the signed-in account; CLI imports require the real transcript', async () => {
  const session = { agent: 'claude', nativeId: id, desktopSessionId: 'local_kept', cwd: root };
  const cliHome = path.join(root, 'cli'), projects = path.join(cliHome, 'projects', 'worktree');
  await fs.mkdir(projects, { recursive: true });
  session.sourcePath = path.join(projects, `${id}.jsonl`);
  await fs.writeFile(session.sourcePath, 'existing conversation');
  const metadataDir = path.join(first, 'claude-code-sessions', 'first', 'org');
  await fs.mkdir(metadataDir, { recursive: true });
  const metadata = path.join(metadataDir, 'local_kept.json');
  await fs.writeFile(metadata, JSON.stringify({ sessionId: 'local_kept', cliSessionId: id }));
  assert.equal((await desktopExecutionLink(session, 'claude:first', { ...options, cliHome })).url, 'claude://code/continue?session=local_kept');
  await fs.writeFile(metadata, JSON.stringify({ sessionId: 'local_kept', cliSessionId: 'other-session' }));
  assert.equal((await desktopExecutionLink(session, 'claude:first', { ...options, cliHome })).url, `claude://resume?session=${id}`);
  assert.equal((await desktopExecutionLink(session, 'claude:first', { ...options, cliHome })).url, `claude://resume?session=${id}`);
  await fs.writeFile(metadata, JSON.stringify({ sessionId: 'local_kept', cliSessionId: id }));
  session.sourcePath = path.join(root, 'unreachable.jsonl');
  await fs.writeFile(session.sourcePath, 'different conversation');
  assert.equal(await desktopExecutionLink(session, 'claude:first', { ...options, cliHome }), null);
});

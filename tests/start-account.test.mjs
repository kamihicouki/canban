import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureAccounts, resetAccountsForTest, accountName } from '../server/accounts.mjs';
import { setDesktopProcessCheck } from '../server/claude-desktop-profile.mjs';
import { startAccount } from '../server/start-account.mjs';
import { newSessionCommand } from '../server/agents.mjs';

let root, app, first, second, previousEnv, previousCheck;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'canban-start-account-'));
  app = path.join(root, 'Claude'); first = path.join(root, 'Claude-Profiles', 'first'); second = path.join(root, 'Claude-Profiles', 'second');
  for (const [dir, account] of [[first, 'first'], [second, 'second']]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ lastKnownAccountUuid: account }));
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

test('a new Claude Desktop session starts in the chosen account\'s signed-in profile', { skip: process.platform !== 'darwin' }, async () => {
  const as = await startAccount({ agent: 'claude', account: 'claude:second', host: { local: true }, route: 'desktop' });
  let profileWhenOpened = null;
  await as.open(async () => { profileWhenOpened = JSON.parse(await fs.readFile(path.join(app, 'config.json'))).lastKnownAccountUuid; });
  assert.equal(profileWhenOpened, 'second');
  assert.equal(as.account, 'claude:second');
});

test('a running Desktop on another profile is not switched and the error names the account', { skip: process.platform !== 'darwin' }, async () => {
  setDesktopProcessCheck(async () => true);
  const as = await startAccount({ agent: 'claude', account: 'claude:second', host: { local: true }, route: 'desktop' });
  let opened = false;
  await assert.rejects(as.open(async () => { opened = true; }), /Claude · .* で Desktop を開けません.*ターミナル/);
  assert.equal(opened, false);
  assert.equal(await fs.realpath(app), await fs.realpath(first));
});

test('no account keeps the current login; mismatched AI App and remote hosts are refused', async () => {
  const none = await startAccount({ agent: 'codex', account: null, route: 'terminal' });
  assert.equal(none.prefix, '');
  await assert.rejects(startAccount({ agent: 'codex', account: 'claude:second', route: 'terminal' }), /一致していません/);
  await assert.rejects(startAccount({ agent: 'claude', account: 'claude:second', host: { local: false, id: 'box' }, route: 'terminal' }), /このマシンだけ/);
  await assert.rejects(startAccount({ agent: 'codex', account: 'codex:nobody', host: { local: true }, route: 'desktop' }), /Codex Desktop は .* でサインインしています/);
});

test('accounts are named with their AI App, and the CLI prefix goes before the binary', () => {
  assert.equal(accountName('codex:abcdef123456'), 'Codex · abcdef12');
  assert.equal(accountName('claude:x', { 'claude:x': 'me@example.com' }), 'Claude · me@example.com');
  assert.equal(accountName(null), 'アカウント不明');
  assert.equal(newSessionCommand('codex', { cwd: '/w', prompt: 'x', prefix: 'env CODEX_HOME=/h ' }), 'cd /w 2>/dev/null; env CODEX_HOME=/h codex x');
});

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { makeFixtures } from '../tests/helpers.mjs';
import { configureAccounts, refreshAccounts, accountsView, accountLimits, homeEnv, resetAccountsForTest } from '../server/accounts.mjs';
import { listClaudeSessions } from '../server/sources/claude.mjs';
import { listCodexSessions } from '../server/sources/codex.mjs';
import { desktopProfilePlan, withDesktopAccount, setDesktopProcessCheck, saveClaudeExecutionAccount } from '../server/claude-desktop-profile.mjs';
import { desktopProfileLock } from '../server/claude-desktop-lock.mjs';
import { inspectDesktopRuntime } from '../server/claude-desktop-runtime.mjs';
import { resolveAccountHome, normalizeClaudeExecution } from '../server/accounts.mjs';
import { matchesAccount } from '../server/accounts-mcp.mjs';
import { cleanEnv } from '../server/dispatch.mjs';
import { Store } from '../server/store.mjs';
import { accountActions } from '../server/account-actions.mjs';
import { shutdownLogins } from '../server/login.mjs';
import { claudeExecutionSession } from '../server/claude-handoff.mjs';

let root, env, previousCheck;
const write = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
};
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'canban-account-audit-'));
  env = { ...process.env };
  process.env.CANBAN_CLAUDE_HOME = path.join(root, 'default-claude');
  process.env.CANBAN_CODEX_HOME = path.join(root, 'default-codex');
  process.env.CANBAN_CLAUDE_DESKTOP_DIR = path.join(root, 'Claude', 'claude-code-sessions');
  await fs.mkdir(process.env.CANBAN_CLAUDE_HOME);
  await fs.mkdir(process.env.CANBAN_CODEX_HOME);
  resetAccountsForTest(); configureAccounts({ discover: false });
  previousCheck = setDesktopProcessCheck(async () => false);
});
afterEach(async () => {
  setDesktopProcessCheck(previousCheck); resetAccountsForTest();
  await shutdownLogins();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  await fs.rm(root, { recursive: true, force: true });
});

test('MA-01: newer cross-account transcript must win even with shared Desktop lastActivityAt', async () => {
  const fx = makeFixtures();
  try {
    process.env.CANBAN_CLAUDE_HOME = fx.claudeHome;
    process.env.CANBAN_CODEX_HOME = fx.codexHome;
    process.env.CANBAN_CLAUDE_DESKTOP_DIR = fx.desktopDir;
    const target = path.join(root, 'target');
    const newer = path.join(target, 'projects', 'worktree', 'c2.jsonl');
    await write(path.join(target, '.claude.json'), { oauthAccount: { accountUuid: 'target' } });
    await write(newer, { type: 'user', cwd: '/new-worktree', timestamp: '2026-09-23T00:00:00Z', message: { content: 'newer target account turn' } });
    configureAccounts({ claudeHomes: [target], discover: false });
    const session = (await listClaudeSessions()).sessions.find(s => s.nativeId === 'c2');
    assert.equal(session.sourcePath, newer);
  } finally { fx.cleanup(); }
});

test('MA-02: moving a managed Claude home must retain the saved execution home ID', async () => {
  const store = new Store(path.join(root, 'data'));
  const allSessions = async state => {
    configureAccounts(state.settings.accounts);
    await refreshAccounts({ force: true });
    return { sessions: [] };
  };
  const actions = accountActions({ store, allSessions, bin: () => '/fake/claude', launch: async () => {}, getClaudeCredentials: async () => ({ claudeAiOauth: { accessToken: 'fixture' } }), dryRun: true });
  const { profile } = await actions.startLogin({ agent: 'claude' });
  await write(path.join(profile.dir, '.claude.json'), { oauthAccount: { accountUuid: 'target' } });
  await write(path.join(profile.dir, '.credentials.json'), { claudeAiOauth: { accessToken: 'fixture' } });
  await actions.checkLogin({ id: profile.id });
  await store.setClaudeExecution({ cardId: 'claude:same-session', execution: { homeId: profile.id, account: 'claude:target' } });
  const destination = path.join(root, 'moved-claude');
  await actions.moveHome({ id: profile.id, dir: destination });
  const registry = await refreshAccounts({ force: true });
  const saved = (await store.load()).cards['claude:same-session'].claudeExecution;
  assert.equal(registry.homes.claude.find(h => h.id === saved.homeId)?.dir, destination);
  await store.setClaudeExecution({ cardId: 'claude:same-session', execution: { homeId: 'moved-claude', account: 'claude:target' } });
  assert.equal(normalizeClaudeExecution((await store.load()).cards['claude:same-session'].claudeExecution).homeId, profile.id);
  const again = path.join(root, 'moved-again');
  await actions.moveHome({ id: profile.id, dir: again });
  assert.equal((await store.load()).cards['claude:same-session'].claudeExecution.homeId, profile.id);
});

test('MA-03: moving a managed Codex home must keep transcript references readable', async () => {
  const fx = makeFixtures();
  try {
    const store = new Store(path.join(root, 'data'));
    const id = '11111111-2222-3333-4444-555555555555';
    await fs.writeFile(path.join(fx.codexHome, '.canban-account-profile'), id);
    await write(path.join(fx.codexHome, 'auth.json'), { tokens: { account_id: 'target' } });
    await store.updateAccountSettings({ codexHomes: [fx.codexHome], profile: { id, agent: 'codex', dir: fx.codexHome, key: 'codex:target', pending: false } });
    const actions = accountActions({ store, allSessions: async () => ({ sessions: [] }), dryRun: true });
    const destination = path.join(fx.root, 'moved-codex');
    await actions.moveHome({ id, dir: destination });
    const session = (await listCodexSessions({ home: destination })).sessions.find(s => s.nativeId === 't1');
    assert.equal(await fs.stat(session.sourcePath).then(() => true, () => false), true, 'state DB still points at the deleted original rollout path');
  } finally {
    if ((await fs.lstat(fx.codexHome).catch(() => null))?.isSymbolicLink()) await fs.unlink(fx.codexHome);
    fx.cleanup();
  }
});

test('MA-04: unknown account count must agree with the account filter for remote sessions', () => {
  const remote = { agent: 'claude', account: null, host: { local: false, id: 'remote' } };
  const view = accountsView({ sessions: [remote] });
  assert.equal(view.unknown.claude, [remote].filter(s => matchesAccount('__none', s)).length);
});

test('MA-05: Claude Desktop usage fallback must use the newest sample across an account orgs', async () => {
  const home = process.env.CANBAN_CLAUDE_HOME;
  const app = path.dirname(process.env.CANBAN_CLAUDE_DESKTOP_DIR);
  await write(path.join(home, '.claude.json'), { oauthAccount: { accountUuid: 'target', organizationUuid: 'new-org' } });
  for (const org of ['new-org', 'old-org']) await fs.mkdir(path.join(app, 'claude-code-sessions', 'target', org), { recursive: true });
  await write(path.join(app, 'config.json'), { lastKnownAccountUuid: 'target' });
  await write(path.join(app, 'plan-usage-history.json'), { samples: [
    { org: 'new-org', t: 200, u: { fh: 90 } },
    { org: 'old-org', t: 100, u: { fh: 10 } },
  ] });
  await refreshAccounts({ force: true });
  assert.equal(accountLimits().find(a => a.key === 'claude:target').at, 200);
});

test('MA-06: Codex resume environment must not inherit another account API credential', () => {
  const session = { agent: 'codex', homeDir: '/selected-home' };
  const result = { ...cleanEnv({ PATH: '/usr/bin', OPENAI_API_KEY: 'fixture-other-account', CODEX_ACCESS_TOKEN: 'fixture-other-account' }), ...homeEnv(session) };
  assert.equal(result.CODEX_HOME, '/selected-home');
  assert.equal(result.OPENAI_API_KEY, undefined);
});

test('MA-07: an abandoned Desktop profile lock must not block account switching forever', async () => {
  const app = path.join(root, 'Claude');
  await write(path.join(app, 'config.json'), { lastKnownAccountUuid: 'target' });
  const lock = path.join(root, '.canban-claude-profile.lock');
  await fs.mkdir(lock);
  await fs.utimes(lock, new Date(0), new Date(0));
  await withDesktopAccount('claude:target', async () => {}, { platform: 'darwin' });
});

test('MA-08 limitation: even unchanged Desktop account is rejected while the app is running', async () => {
  await write(path.join(root, 'Claude', 'config.json'), { lastKnownAccountUuid: 'target' });
  const plan = await desktopProfilePlan('claude:target', { platform: 'darwin' });
  assert.equal(plan.change, false);
  setDesktopProcessCheck(async () => true);
  await assert.rejects(withDesktopAccount('claude:target', async () => {}, { platform: 'darwin' }), /Desktop を終了/);
});

test('MA-09: the same Claude account in another organization must use the selected home org', async () => {
  const first = process.env.CANBAN_CLAUDE_HOME;
  const second = path.join(root, 'other-org');
  await write(path.join(first, '.claude.json'), { oauthAccount: { accountUuid: 'target', emailAddress: 'target@example.test', organizationUuid: 'org-first' } });
  await write(path.join(second, '.claude.json'), { oauthAccount: { accountUuid: 'target', emailAddress: 'target@example.test', organizationUuid: 'org-second' } });
  configureAccounts({ discover: false, claudeHomes: [second] });
  const registry = await refreshAccounts({ force: true });
  const selected = registry.homes.claude.find(h => h.dir === second);
  process.env.CANBAN_CLAUDE_BIN = path.resolve('tests/fake-claude.sh');
  const transcript = path.join(root, 'same-session.jsonl');
  await fs.writeFile(transcript, '{}\n');
  const session = { agent: 'claude', id: 'claude:same-session', nativeId: 'same-session', cwd: root, sourcePath: transcript, account: 'claude:target' };
  const result = await claudeExecutionSession(session, selected.id, 'claude:target');
  assert.equal(result.homeDir, second);
});

test('MA-10: reordering same-named homes must not redirect a saved home to another directory', async () => {
  const first = path.join(root, 'one', 'profile');
  const second = path.join(root, 'two', 'profile');
  for (const dir of [first, second]) await write(path.join(dir, '.claude.json'), { oauthAccount: { accountUuid: 'target' } });
  configureAccounts({ discover: false, claudeHomes: [first, second] });
  const savedId = (await refreshAccounts({ force: true })).homes.claude.find(h => h.dir === first).id;
  configureAccounts({ discover: false, claudeHomes: [second, first] });
  assert.equal((await refreshAccounts({ force: true })).homes.claude.find(h => h.id === savedId).dir, first);
});

test('legacy unique IDs resolve; ambiguous collision IDs cannot redirect queued choices', async () => {
  const dirs = [path.join(root, 'a', 'shared'), path.join(root, 'b', 'shared')];
  for (const dir of dirs) await write(path.join(dir, '.claude.json'), { oauthAccount: { accountUuid: 'target' } });
  configureAccounts({ discover: false, claudeHomes: dirs });
  const registry = await refreshAccounts({ force: true });
  assert.equal(resolveAccountHome('claude', 'shared'), null);
  assert.equal(resolveAccountHome('claude', 'shared-2'), null);
  const second = registry.homes.claude.find(h => h.dir === dirs[1]);
  configureAccounts({ discover: false, claudeHomes: [dirs[1]] });
  await refreshAccounts({ force: true });
  assert.equal(resolveAccountHome('claude', second.id).dir, dirs[1]);
});

test('CLI selection is committed while Desktop is running; verified same profile can reopen', async () => {
  const app = path.join(root, 'Claude');
  await write(path.join(app, 'config.json'), { lastKnownAccountUuid: 'target' });
  setDesktopProcessCheck(async () => true);
  let saved;
  const selection = { homeId: 'fixture', account: 'claude:target' };
  const result = await saveClaudeExecutionAccount('claude:target', async () => { saved = selection; return saved; }, { platform: 'darwin' });
  assert.deepEqual(saved, selection);
  assert.deepEqual(result.execution, selection);
  assert.equal(result.desktop.pending, true);
  assert.equal(result.desktop.code, 'desktop_running');
  setDesktopProcessCheck(async () => ({ running: true, profileDir: await fs.realpath(app) }));
  assert.equal((await withDesktopAccount('claude:target', async status => status, { platform: 'darwin' })).maintained, true);
  await assert.rejects(saveClaudeExecutionAccount('claude:target', async () => { throw new Error('DB failed'); }, { platform: 'darwin' }), /DB failed/);
});

test('runtime inspection uses open-file inode and every main process, not a changed symlink', async () => {
  const app = path.join(root, 'Claude'), first = path.join(root, 'Claude-Profiles', 'first'), second = path.join(root, 'Claude-Profiles', 'second');
  await write(path.join(first, 'config.json'), { lastKnownAccountUuid: 'first' });
  await write(path.join(second, 'config.json'), { lastKnownAccountUuid: 'second' });
  await fs.symlink(second, app);
  const st = await fs.stat(path.join(first, 'config.json'), { bigint: true });
  configureAccounts({ discover: true });
  const plan = await desktopProfilePlan('claude:second', { platform: 'darwin' });
  const processLine = '123 /Applications/Claude.app/Contents/MacOS/Claude';
  const openFile = `p123\nf4\ni${st.ino}\nD0x${st.dev.toString(16)}\nn${app}/config.json\n`;
  const run = async bin => bin.endsWith('ps') ? processLine : openFile;
  assert.equal((await inspectDesktopRuntime(plan, { run })).profileDir, await fs.realpath(first));
  const helper = async bin => bin.endsWith('ps') ? processLine + '\n124 /Applications/Claude.app/Contents/Frameworks/Claude Helper --browser-subprocess-path=/Applications/Claude.app/Contents/MacOS/Claude' : openFile;
  assert.equal((await inspectDesktopRuntime(plan, { run: helper })).profileDir, await fs.realpath(first));
  const unknownMain = async bin => bin.endsWith('ps') ? processLine + '\n124 /Applications/Claude.app/Contents/MacOS/Claude' : openFile;
  assert.equal((await inspectDesktopRuntime(plan, { run: unknownMain })).profileDir, null);
});

test('expired live lock is retained, dead lock is reclaimed, and concurrent recovery has one owner', async () => {
  const lock = path.join(root, '.canban-claude-profile.lock');
  await fs.mkdir(lock);
  await write(path.join(lock, 'owner.json'), { pid: process.pid, generation: 'live' });
  await fs.utimes(lock, new Date(0), new Date(0));
  await assert.rejects(desktopProfileLock(lock), { code: 'desktop_busy' });
  await write(path.join(lock, 'owner.json'), { pid: 2147483647, generation: 'dead' });
  await fs.utimes(lock, new Date(0), new Date(0));
  const results = await Promise.allSettled([desktopProfileLock(lock), desktopProfileLock(lock)]);
  const held = results.filter(r => r.status === 'fulfilled');
  assert.equal(held.length, 1);
  await held[0].value.assertHeld();
  await held[0].value.release();
  assert.equal(await fs.lstat(lock).catch(() => null), null);
});

test('Codex repeated moves preserve earlier paths and DB failure rolls the latest move back', async () => {
  const store = new Store(path.join(root, 'move-data'));
  const id = '11111111-2222-3333-4444-555555555555', original = path.join(root, 'managed-codex');
  await write(path.join(original, 'auth.json'), { tokens: { account_id: 'target' } });
  await fs.writeFile(path.join(original, '.canban-account-profile'), id);
  await fs.writeFile(path.join(original, 'rollout.jsonl'), 'kept history');
  await store.updateAccountSettings({ codexHomes: [original], profile: { id, agent: 'codex', dir: original, key: 'codex:target', pending: false } });
  const actions = accountActions({ store, allSessions: async () => ({ sessions: [] }), dryRun: true });
  const first = path.join(root, 'codex-move-one'), second = path.join(root, 'codex-move-two'), failed = path.join(root, 'codex-move-failed');
  await actions.moveHome({ id, dir: first });
  await actions.moveHome({ id, dir: second });
  assert.equal(await fs.readFile(path.join(original, 'rollout.jsonl'), 'utf8'), 'kept history');
  assert.equal(await fs.realpath(first), await fs.realpath(second));
  const failingStore = { dir: store.dir, load: () => store.load(), updateAccountSettings: async () => { throw new Error('DB failed'); } };
  const failing = accountActions({ store: failingStore, allSessions: async () => ({ sessions: [] }), dryRun: true });
  await assert.rejects(failing.moveHome({ id, dir: failed }), /変更できません/);
  assert.equal((await fs.lstat(second)).isSymbolicLink(), false);
  assert.equal(await fs.lstat(failed).catch(() => null), null);
  assert.equal(await fs.readFile(path.join(original, 'rollout.jsonl'), 'utf8'), 'kept history');
  assert.equal((await store.load()).settings.accounts.profiles[0].dir, second);
});

test('legacy managed marker retains its UUID without a pending-login settings record', async () => {
  const dir = path.join(root, 'legacy-managed'), id = '11111111-2222-3333-4444-555555555555';
  await write(path.join(dir, '.claude.json'), { oauthAccount: { accountUuid: 'target' } });
  await fs.writeFile(path.join(dir, '.canban-account-profile'), id);
  configureAccounts({ claudeHomes: [dir], profiles: [], discover: false });
  await refreshAccounts({ force: true });
  assert.equal(resolveAccountHome('claude', id).dir, dir);
  const other = path.join(root, 'copied-marker');
  await write(path.join(other, '.claude.json'), { oauthAccount: { accountUuid: 'target' } });
  await fs.writeFile(path.join(other, '.canban-account-profile'), id);
  configureAccounts({ claudeHomes: [other, dir], profiles: [], discover: false });
  await refreshAccounts({ force: true });
  assert.equal(resolveAccountHome('claude', id), null);
});

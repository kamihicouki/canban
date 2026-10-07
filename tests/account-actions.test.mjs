import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { accountActions, accountActionTools } from '../server/account-actions.mjs';
import { normalizeAccounts } from '../server/accounts-settings.mjs';
import { CLAUDE_AUTH_OVERRIDES } from '../server/claude-auth-env.mjs';
import { configureAccounts, refreshAccounts, accountsView, resetAccountsForTest } from '../server/accounts.mjs';

let root, home, store, oldEnv, time = Date.now();
const allSessions = async (state) => { configureAccounts(state.settings.accounts); await refreshAccounts({ force: true }); return { sessions: [] }; };
const write = (file, value) => fs.writeFile(file, JSON.stringify(value));
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'canban-actions-')); home = path.join(root, 'codex');
  await fs.mkdir(home); await fs.mkdir(path.join(root, 'claude')); await fs.mkdir(path.join(root, 'desktop', 'sessions'), { recursive: true });
  await write(path.join(home, 'auth.json'), { tokens: { account_id: 'a', access_token: 'PRIVATE-TOKEN' } });
  oldEnv = Object.fromEntries(['CANBAN_CODEX_HOME', 'CANBAN_CLAUDE_HOME', 'CANBAN_CLAUDE_DESKTOP_DIR'].map((k) => [k, process.env[k]]));
  process.env.CANBAN_CODEX_HOME = home; process.env.CANBAN_CLAUDE_HOME = path.join(root, 'claude'); process.env.CANBAN_CLAUDE_DESKTOP_DIR = path.join(root, 'desktop', 'sessions');
  store = new Store(path.join(root, 'data')); await store.load();
});
beforeEach(() => resetAccountsForTest());
after(async () => { await store.close(); for (const [k, v] of Object.entries(oldEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } await fs.rm(root, { recursive: true, force: true }); });
const successful = async ({ key, home: h }) => { assert.equal(key, 'codex:a'); assert.equal(h.dir, home); return { at: time, primary: { usedPercent: 23, windowMinutes: 300, resetsAt: time + 3600000 }, secondary: null, source: 'live' }; };
test('refresh snapshots persist in SQLite; failures keep previous values and sanitized status', async () => {
  const a = accountActions({ store, allSessions, providers: { codex: successful }, now: () => time, dryRun: false });
  assert.equal((await a.refresh({ key: 'codex:a' })).updated[0].status, 'ok');
  time += 1000;
  const failing = accountActions({ store, allSessions, providers: { codex: async () => { throw new Error('PRIVATE-TOKEN'); } }, now: () => time, dryRun: false });
  await failing.refresh({ key: 'codex:a' });
  const state = await store.load(), v = state.settings.accounts.usage['codex:a'];
  assert.equal(v.primary.usedPercent, 23); assert.equal(v.at, time - 1000); assert.equal(v.attemptedAt, time); assert.equal(v.code, 'unavailable');
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE/);
  await allSessions(state);
  const account = accountsView().accounts.find((a) => a.key === 'codex:a');
  assert.equal(account.limits.primary.usedPercent, 23); assert.equal(account.usage.status, 'error');
});
test('configured interval, off switch and per-account lease prevent duplicate updates; manual bypasses interval', async () => {
  let count = 0, release;
  const a = accountActions({ store, allSessions, dryRun: false, now: () => time, providers: { codex: async () => { count++; return successful({ key: 'codex:a', home: { dir: home } }); } } });
  await store.updateAccountSettings({ refresh: { enabled: true, intervalMinutes: 7 } });
  assert.equal((await a.refresh({ automatic: true })).updated.length, 0);
  time += 7 * 60000; await a.refresh({ automatic: true }); assert.equal(count, 1);
  await store.updateAccountSettings({ refresh: { enabled: false } }); time += 7 * 60000;
  await a.refresh({ automatic: true }); assert.equal(count, 1);
  await a.refresh({ key: 'codex:a' }); assert.equal(count, 2);
  const slow = accountActions({ store, allSessions, dryRun: false, providers: { codex: async () => { await new Promise((r) => { release = r; }); return successful({ key: 'codex:a', home: { dir: home } }); } } });
  const first = slow.refresh({ key: 'codex:a' });
  while (!release) await new Promise((r) => setTimeout(r, 5));
  const second = await a.refresh({ key: 'codex:a' }); assert.equal(second.updated.length, 0); assert.equal(count, 2);
  release(); await first;
  await assert.rejects(store.updateAccountSettings({ refresh: { intervalMinutes: 0 } }), /1〜1440/);
});
test('login creates an isolated home without a directory argument; rejects wrong account and completes persistently', async () => {
  let launch;
  const actions = accountActions({ store, allSessions, bin: () => '/fake/codex', launch: async (value) => { launch = value; }, dryRun: true });
  const result = await actions.startLogin({ agent: 'codex', key: 'codex:a' });
  const p = result.profile;
  assert.notEqual(p.dir, home); assert.ok(p.dir.startsWith(path.join(store.dir, 'accounts', 'codex')));
  assert.ok((await fs.stat(p.dir)).isDirectory()); assert.equal((await fs.stat(p.dir)).mode & 0o777, 0o700);
  assert.ok(launch.command.includes(p.dir)); assert.ok(launch.command.includes('login')); assert.ok(!launch.command.includes('PRIVATE-TOKEN'));
  assert.equal((await actions.checkLogin({ id: p.id })).complete, false);
  await write(path.join(p.dir, 'auth.json'), { tokens: { account_id: 'wrong' } });
  assert.equal((await actions.checkLogin({ id: p.id })).wrongAccount, true);
  assert.ok(!(await store.load()).settings.accounts.codexHomes.includes(p.dir));
  await write(path.join(p.dir, 'auth.json'), { tokens: { account_id: 'a' } });
  assert.equal((await actions.checkLogin({ id: p.id })).complete, true);
  assert.ok((await store.load()).settings.accounts.codexHomes.includes(p.dir));
  assert.equal((await actions.checkLogin({ id: p.id })).complete, true);
  assert.equal((await fs.readFile(path.join(home, 'auth.json'), 'utf8')).includes('PRIVATE-TOKEN'), true);
});
test('managed home can move to an unused path; default, occupied and active-session paths are protected', async () => {
  const actions = accountActions({ store, allSessions, bin: () => '/fake/codex', launch: async () => {}, dryRun: true });
  const p = (await store.load()).settings.accounts.profiles.find((p) => !p.pending);
  const destination = path.join(root, 'my account'); await fs.writeFile(path.join(p.dir, 'history.jsonl'), 'history');
  await assert.rejects(actions.moveHome({ id: p.id, dir: home }), /未使用/);
  await assert.rejects(actions.moveHome({ id: p.id, dir: path.join(p.dir, 'child') }), /親・子/);
  const busy = accountActions({ store, allSessions: async () => ({ sessions: [{ homeDir: p.dir, status: 'running' }] }), dryRun: true });
  await assert.rejects(busy.moveHome({ id: p.id, dir: destination }), /終了/);
  assert.equal((await actions.moveHome({ id: p.id, dir: destination })).dir, destination);
  assert.equal(await fs.readFile(path.join(destination, 'history.jsonl'), 'utf8'), 'history');
  assert.ok((await store.load()).settings.accounts.codexHomes.includes(destination));
  assert.equal(await fs.realpath(p.dir), await fs.realpath(destination));
  assert.ok((await fs.lstat(p.dir)).isSymbolicLink());
});
test('normalization persists only whitelisted snapshot fields and strips credentials', () => {
  const a = normalizeAccounts({ usage: { 'codex:a': { at: 1000, attemptedAt: 2000, status: 'error', code: 'PRIVATE-TOKEN', plan: 'PRIVATE-TOKEN', accessToken: 'PRIVATE-TOKEN', primary: { usedPercent: null }, secondary: { usedPercent: 0, windowMinutes: 10080 } } }, refresh: { intervalMinutes: 'garbage' } });
  assert.equal(a.refresh.intervalMinutes, 5); assert.equal(a.usage['codex:a'].primary, null); assert.equal(a.usage['codex:a'].secondary.usedPercent, 0);
  assert.doesNotMatch(JSON.stringify(a), /PRIVATE-TOKEN|accessToken/);
});

test('Claude relocation preserves the current credential securely and rolls back on settings failure', async () => {
  const credential = { claudeAiOauth: { accessToken: 'PRIVATE-CURRENT', refreshToken: 'PRIVATE-REFRESH' } };
  const actions = accountActions({ store, allSessions, bin: () => '/fake/claude', launch: async () => {}, getClaudeCredentials: async () => credential, dryRun: true });
  const login = await actions.startLogin({ agent: 'claude' });
  for (const key of CLAUDE_AUTH_OVERRIDES) assert(login.command.includes(`-u ${key} `));
  const p = login.profile;
  await write(path.join(p.dir, '.claude.json'), { oauthAccount: { accountUuid: 'c' } });
  await write(path.join(p.dir, '.credentials.json'), { claudeAiOauth: { accessToken: 'PRIVATE-OLD' } });
  assert.equal((await actions.checkLogin({ id: p.id })).complete, true);
  const destination = path.join(root, 'claude-moved');
  const failing = accountActions({ store: { dir: store.dir, load: () => store.load(), updateAccountSettings: async () => { throw Error('db_busy'); } }, allSessions, getClaudeCredentials: async () => credential, dryRun: true });
  await assert.rejects(failing.moveHome({ id: p.id, dir: destination }), /変更できません/);
  assert.ok((await fs.stat(p.dir)).isDirectory()); await assert.rejects(fs.stat(destination));
  await actions.moveHome({ id: p.id, dir: destination });
  const file = path.join(destination, '.credentials.json');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).claudeAiOauth.accessToken, 'PRIVATE-CURRENT');
  assert.doesNotMatch(JSON.stringify(await store.load()), /PRIVATE-CURRENT|PRIVATE-REFRESH|PRIVATE-OLD/);
});

test('batch refresh keeps successful accounts isolated when another account fails', async () => {
  const second = path.join(root, 'second-codex'); await fs.mkdir(second);
  await write(path.join(second, 'auth.json'), { tokens: { account_id: 'b' } });
  const settings = (await store.load()).settings.accounts;
  await store.updateAccountSettings({ codexHomes: [...settings.codexHomes, second] });
  const actions = accountActions({ store, allSessions, dryRun: false, providers: {
    codex: async ({ key, home }) => {
      if (key === 'codex:a') throw Error('PRIVATE-TOKEN');
      assert.equal(key, 'codex:b'); assert.equal(home.dir, second);
      return { at: Date.now(), primary: { usedPercent: 67, windowMinutes: 300 }, secondary: null };
    }, claude: async () => { throw Object.assign(Error('unsupported'), { code: 'unsupported' }); },
  } });
  const result = await actions.refresh();
  assert.equal(result.updated.find(v => v.key === 'codex:b').status, 'ok');
  assert.equal(result.updated.find(v => v.key === 'codex:a').status, 'error');
  const usage = (await store.load()).settings.accounts.usage;
  assert.equal(usage['codex:b'].primary.usedPercent, 67); assert.equal(usage['codex:a'].primary.usedPercent, 23);
});

test('browser login uses the same isolated pending home, reuses its session and can switch to terminal', async () => {
  let session, starts = 0, cancelled = 0, terminal;
  const manager = {
    catalog: () => [], active: p => session?.homeId === p.id ? { id: session.sessionId } : null,
    view: () => session,
    start: async (p, target) => { starts++; assert.equal(target.mode, 'manual'); session = { sessionId: 'test-session', homeId: p.id, state: 'waiting', authUrl: 'https://auth.openai.com/authorize?state=fixture' }; return session; },
    cancel: async () => { cancelled++; session = null; },
  };
  const actions = accountActions({ store, allSessions, bin: () => '/fake/codex', loginManager: manager,
    launch: async value => { terminal = value; }, dryRun: true });
  const result = await actions.startLogin({ agent: 'codex', method: 'browser', loginOptions: { mode: 'manual' } });
  assert.equal(starts, 1); assert.equal(terminal, undefined);
  assert.equal(result.login.state, 'waiting'); assert.notEqual(result.profile.dir, home);
  assert.equal((await actions.loginBrowsers({ profileId: result.profile.id })).active.sessionId, 'test-session');
  assert.equal((await actions.loginDetails({ profileId: result.profile.id })).command, result.command);
  await actions.startLogin({ agent: 'codex', profileId: result.profile.id, method: 'browser' });
  assert.equal(starts, 1);
  await actions.startLogin({ agent: 'codex', profileId: result.profile.id, method: 'terminal' });
  assert.equal(cancelled, 1); assert.ok(terminal.command.includes(result.profile.dir));
  await actions.cancelLogin({ id: result.profile.id });
});

test('failed terminal launch preserves a copyable isolated command without raw launcher errors', async () => {
  const actions = accountActions({ store, allSessions, bin: () => '/fake/codex',
    launch: async () => { throw Error('PRIVATE-LAUNCH-ERROR'); }, dryRun: true });
  const result = await actions.startLogin({ agent: 'codex', method: 'terminal' });
  assert.equal(result.opened, false); assert.match(result.error, /コピー/);
  assert.ok(result.command.includes(result.profile.dir));
  assert.equal((await actions.loginDetails({ profileId: result.profile.id })).command, result.command);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-LAUNCH/);
  assert.match(result.command, /CODEX_ACCESS_TOKEN/); assert.match(result.command, /BROWSER/);
  await actions.cancelLogin({ id: result.profile.id });
});

test('account login tool schemas carry the method, browser target and ephemeral session operations', () => {
  const list = accountActionTools({ actions: {}, store, appTool: (name, description, properties, required) => ({ name, properties, required }) });
  const start = list.find(t => t.name === 'canban_start_account_login');
  assert.deepEqual(start.properties.method.enum, ['terminal', 'browser']);
  assert.deepEqual(start.properties.loginOptions.properties.mode.enum, ['auto', 'manual']);
  for (const operation of ['status', 'open', 'cancel', 'code']) assert.ok(list.some(t => t.name === `canban_account_login_${operation}`));
});

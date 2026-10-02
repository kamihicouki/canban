import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LoginManager, authUrl, loginEnvironment, loginPreference, loginPortAvailable, MARKER, LOGIN_TARGET_FILE } from '../server/login.mjs';
import { loginBrowsers, loginTarget, openLoginBrowser } from '../server/login-browsers.mjs';

const fixture = fileURLToPath(new URL('./fixtures/login-cli.mjs', import.meta.url));
const browsers = [{ id: 'chrome', label: 'Chrome', executable: '/Applications/Chrome with spaces.app/Contents/MacOS/Chrome', profiles: [{ id: 'Profile 2', label: 'Work' }] }, { id: 'safari', label: 'Safari', executable: '/Applications/Safari.app', profiles: [] }];
const auto = { mode: 'auto', browserId: 'chrome', profileId: 'Profile 2' };
const waitFor = async (fn) => {
  const end = Date.now() + 6000;
  while (Date.now() < end) { const value = fn(); if (value) return value; await new Promise((r) => setTimeout(r, 15)); }
  throw new Error('fixture timed out');
};
function setup(t, { scenario = 'hold', ...options } = {}) {
  const root = fs.mkdtempSync(path.join('/tmp', 'canban-login-'));
  const home = { id: 'codex-test', agent: 'codex', dir: path.join(root, 'home with spaces') };
  fs.mkdirSync(home.dir);
  const marker = () => fs.writeFileSync(path.join(home.dir, MARKER), home.id);
  marker();
  const calls = [], launches = [], evidence = path.join(root, 'evidence.jsonl');
  const manager = new LoginManager({ platform: 'darwin', browsers: () => browsers, resolveCli: () => '/fake/cli with spaces',
    runtimeDir: path.join(root, 'run'), checkPort: async () => true, onComplete: async () => ({ key: `${home.agent}:test`, email: 'test@example.com' }),
    spawnChild: (file, args, opts) => {
      launches.push({ file, args, opts });
      return home.agent === 'claude' && process.platform === 'darwin'
        ? spawn(file, [args[0], process.execPath, fixture, home.agent, scenario, evidence], opts)
        : spawn(process.execPath, [fixture, home.agent, scenario, evidence], opts);
    }, openBrowser: async (...args) => calls.push(args), ...options });
  const records = () => fs.existsSync(evidence) ? fs.readFileSync(evidence, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  t.after(async () => { await manager.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  return { manager, home, root, marker, calls, launches, records };
}
const ready = async (manager, id) => waitFor(() => manager.status(id).state === 'waiting' && manager.status(id));
const finished = async (manager, id) => {
  await waitFor(() => ['succeeded', 'failed', 'cancelled'].includes(manager.status(id).state));
  await manager.sessions.get(id).finishing;
  return manager.status(id);
};

test('browser metadata excludes missing profiles and private credential fields', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-browser-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const apps = path.join(root, 'My Applications'), chrome = path.join(apps, 'Google Chrome.app/Contents/MacOS/Google Chrome');
  fs.mkdirSync(path.dirname(chrome), { recursive: true }); fs.writeFileSync(chrome, ''); fs.mkdirSync(path.join(apps, 'Safari.app'));
  const data = path.join(root, 'Library/Application Support/Google/Chrome');
  fs.mkdirSync(path.join(data, 'Profile 2'), { recursive: true });
  fs.writeFileSync(path.join(data, 'Local State'), JSON.stringify({ profile: { info_cache: { 'Profile 2': { name: 'Work', user_name: 'private@example.com' }, 'Profile 9': { name: 'Gone' }, '../bad': { name: 'bad' } } } }));
  const list = loginBrowsers({ platform: 'darwin', home: root, apps, systemApps: root });
  assert.deepEqual(list[0].profiles, [{ id: 'Profile 2', label: 'Work' }]);
  assert.doesNotMatch(JSON.stringify(list), /private@example|Gone|bad/);
  assert.deepEqual(loginBrowsers({ platform: 'linux' }), []);
});
test('browser argv preserve spaces, explicit profiles, and URLs without shell expansion', async () => {
  const calls = [], url = 'https://auth.openai.com/oauth?state=x%20y&literal=$(ignore)';
  const run = (file, args, opts, cb) => { calls.push({ file, args }); cb(null); };
  await openLoginBrowser(auto, url, browsers, run);
  await openLoginBrowser({ mode: 'auto', browserId: 'safari' }, url, browsers, run);
  assert.deepEqual(calls[0], { file: browsers[0].executable, args: ['--profile-directory=Profile 2', url] });
  assert.deepEqual(calls[1], { file: '/usr/bin/open', args: ['-a', browsers[1].executable, url] });
  assert.throws(() => loginTarget({ mode: 'auto', browserId: 'chrome' }, browsers), /プロファイル/);
  assert.throws(() => loginTarget({ ...auto, profileId: 'Profile 99' }, browsers), /選び直/);
  assert.throws(() => loginTarget({ mode: 'auto', browserId: 'edge' }, browsers), /ブラウザ/);
  assert.deepEqual(loginTarget({ ...auto, mode: 'manual' }, []), { ...auto, mode: 'manual' });
});
test('login environment isolates the selected home and removes inherited authentication / PTY routing', () => {
  const env = loginEnvironment({ agent: 'claude', dir: '/test home' }, { PATH: '/bin', BROWSER: 'old', CODEX_HOME: '/old', CLAUDE_CONFIG_DIR: '/old', OPENAI_API_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret', CLAUDE_BG_PIPE: 'old', CLAUDE_PTY_FD: 'old', CLAUDECODE: 'old' });
  assert.equal(env.CLAUDE_CONFIG_DIR, '/test home');
  assert.doesNotMatch(JSON.stringify(env), /secret|old/);
});
test('a browser that stays running is accepted without killing it on launch timeout', async (t) => {
  const root = fs.mkdtempSync(path.join('/tmp', 'canban-open-'));
  const file = path.join(root, 'browser with spaces'), pidFile = path.join(root, 'pid');
  fs.writeFileSync(file, `#!/bin/sh\necho $$ > '${pidFile}'\nsleep 15\n`, { mode: 0o700 });
  let pid;
  t.after(() => { if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch {} } fs.rmSync(root, { recursive: true, force: true }); });
  await openLoginBrowser(auto, 'https://auth.openai.com/authorize', [{ ...browsers[0], executable: file }]);
  await waitFor(() => fs.existsSync(pidFile));
  pid = Number(fs.readFileSync(pidFile, 'utf8').trim()); assert.doesNotThrow(() => process.kill(pid, 0));
});
test('only initial provider authorization URLs may cross into the UI', () => {
  assert.equal(authUrl('codex', 'https://auth.openai.com/authorize?state=x'), 'https://auth.openai.com/authorize?state=x');
  for (const url of ['http://auth.openai.com/', 'https://evil.test/', 'https://user:pass@auth.openai.com/', 'https://auth.openai.com/callback?code=secret', 'https://auth.openai.com/?access_token=secret']) assert.throws(() => authUrl('codex', url));
  assert.equal(authUrl('claude', 'https://claude.ai/oauth/authorize?code=true'), 'https://claude.ai/oauth/authorize?code=true');
  assert.equal(authUrl('claude', 'https://claude.com/cai/oauth/authorize?code=true'), 'https://claude.com/cai/oauth/authorize?code=true');
  for (const url of ['https://claude.ai/oauth/authorize?code=secret', 'https://claude.ai/callback?code=true', 'https://claude.ai/oauth/authorize#access_token=secret']) assert.throws(() => authUrl('claude', url));
});
test('Codex manual login runs only app-server, keeps URLs ephemeral, and verifies the selected home', async (t) => {
  const { manager, home, calls, launches } = setup(t, { scenario: 'success' });
  const { sessionId } = await manager.start(home, { ...auto, mode: 'manual' });
  await ready(manager, sessionId);
  assert.equal(calls.length, 0);
  const result = await finished(manager, sessionId);
  assert.equal(result.state, 'succeeded'); assert.equal(result.account.email, 'test@example.com'); assert.equal(result.authUrl, null);
  assert.deepEqual(launches[0].args, ['app-server', '-c', 'cli_auth_credentials_store="file"']); assert.equal(launches[0].opts.env.CODEX_HOME, home.dir);
  assert.deepEqual(loginPreference(home), { ...auto, mode: 'manual' });
  assert.doesNotMatch(fs.readFileSync(path.join(home.dir, MARKER), 'utf8'), /https:|fixture|token/);
});
test('Codex automatic login uses exactly the selected profile; another loginId cannot finish it', async (t) => {
  const { manager, home, calls } = setup(t);
  const { sessionId } = await manager.start(home, auto); await ready(manager, sessionId);
  await waitFor(() => calls.length); assert.deepEqual(calls[0][0], auto);
  await assert.rejects(manager.start(home, auto), /認証中/);
  assert.equal(manager.status(sessionId).state, 'waiting');
  await manager.cancel(sessionId);
});
test('Codex completion notification arriving before login/start response is retained', async (t) => {
  const { manager, home } = setup(t, { scenario: 'early' });
  const { sessionId } = await manager.start(home, { mode: 'manual' });
  assert.equal((await finished(manager, sessionId)).state, 'succeeded');
});
test('browser launch failure leaves a copyable URL and never selects a fallback browser', async (t) => {
  let tries = 0;
  const { manager, home } = setup(t, { openBrowser: async () => { tries++; throw new Error('private URL'); } });
  const { sessionId } = await manager.start(home, auto); await ready(manager, sessionId);
  const result = manager.status(sessionId); assert.equal(tries, 1); assert.equal(result.state, 'waiting'); assert.ok(result.authUrl); assert.ok(result.browserError);
  assert.doesNotMatch(JSON.stringify(result), /private URL/);
  await manager.cancel(sessionId);
});
test('provider errors and missing post-login account are failures with no raw CLI output', async (t) => {
  for (const scenario of ['api-error', 'failure', 'success']) {
    const { manager, home } = setup(t, { scenario, onComplete: async () => null });
    const { sessionId } = await manager.start(home, { mode: 'manual' });
    const result = await finished(manager, sessionId); assert.equal(result.state, 'failed'); assert.equal(result.authUrl, null);
    assert.doesNotMatch(JSON.stringify(result), /secret that/);
  }
});
test('port conflict and concurrent Canban manager fail without spawning or cancelling existing login', async (t) => {
  const a = setup(t), b = setup(t, { runtimeDir: a.manager.runtimeDir }), c = setup(t, { checkPort: async () => false });
  const first = await a.manager.start(a.home, { mode: 'manual' }); await ready(a.manager, first.sessionId);
  const second = await b.manager.start(b.home, { mode: 'manual' }); assert.match((await finished(b.manager, second.sessionId)).error, /別のCodex/); assert.equal(b.launches.length, 0);
  const third = await c.manager.start(c.home, { mode: 'manual' }); assert.match((await finished(c.manager, third.sessionId)).error, /ポート/); assert.equal(c.launches.length, 0);
  assert.equal(a.manager.status(first.sessionId).state, 'waiting');
  assert.ok(!a.records().some((r) => r.method === 'account/login/cancel'));
});
test('loopback port preflight detects a listener and releases its own probe', async (t) => {
  const server = net.createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port; assert.equal(await loginPortAvailable(port), false);
  await new Promise((r) => server.close(r)); assert.equal(await loginPortAvailable(port), true);
});
test('a dead Codex owner can be reclaimed; an incomplete live lock is left untouched', async (t) => {
  const { manager, home } = setup(t);
  const lock = path.join(manager.runtimeDir, 'codex.lock'); fs.mkdirSync(lock, { recursive: true });
  await assert.rejects(manager.codexLock({ id: 'probe' }), /別のCodex/); assert.ok(fs.existsSync(lock));
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647, sessionId: 'dead-owner' }));
  const { sessionId } = await manager.start(home, { mode: 'manual' }); await ready(manager, sessionId);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'))).sessionId, sessionId);
  assert.ok(!fs.existsSync(`${lock}.reclaim`));
});
test('cancellation uses the official Codex API and removes only its child and lock', async (t) => {
  const { manager, home, root, records } = setup(t);
  const { sessionId } = await manager.start(home, { mode: 'manual' }); await ready(manager, sessionId);
  const child = manager.sessions.get(sessionId).child;
  const result = await manager.cancel(sessionId); assert.equal(result.state, 'cancelled'); assert.equal(result.authUrl, null);
  assert.ok(records().some((r) => r.method === 'account/login/cancel')); assert.equal(manager.sessions.get(sessionId).didExit, true);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' }); assert.ok(!fs.existsSync(path.join(root, 'run/codex.lock')));
});
test('cancel during port preflight cannot spawn a late child; server shutdown prevents new starts', async (t) => {
  let release;
  const { manager, home, launches } = setup(t, { checkPort: () => new Promise((r) => { release = r; }) });
  const { sessionId } = await manager.start(home, { mode: 'manual' }); await waitFor(() => release);
  await manager.cancel(sessionId); release(true); await manager.sessions.get(sessionId).launch;
  assert.equal(launches.length, 0); assert.equal(manager.status(sessionId).state, 'cancelled');
  await manager.shutdown(); await assert.rejects(manager.start(home), /開き直/);
});
test('timeout escalates termination of an unresponsive owned process and clears the URL', async (t) => {
  const { manager, home } = setup(t, { scenario: 'stubborn', timeoutMs: 1000 });
  const { sessionId } = await manager.start(home, { mode: 'manual' });
  const result = await finished(manager, sessionId); assert.equal(result.state, 'failed'); assert.match(result.error, /タイムアウト/); assert.equal(result.authUrl, null);
  assert.equal(manager.sessions.get(sessionId).didExit, true);
});
test('Claude uses a real invisible PTY and scoped BROWSER helper; code reaches stdin and account is verified', async (t) => {
  const { manager, home, marker, launches, calls, records } = setup(t);
  home.agent = 'claude'; home.id = 'claude-test'; marker();
  const { sessionId } = await manager.start(home, auto); await ready(manager, sessionId);
  await waitFor(() => manager.status(sessionId).manualCodeRequired);
  assert.equal(launches[0].file, '/bin/bash'); assert.match(launches[0].args[0], /auth-claude.sh$/); assert.deepEqual(launches[0].args.slice(1), ['/fake/cli with spaces', 'auth', 'login', '--claudeai']);
  assert.equal(launches[0].opts.env.CLAUDE_CONFIG_DIR, home.dir); assert.match(launches[0].opts.env.BROWSER, /auth-browser.sh$/);
  assert.equal(calls.length, 1); if (process.platform === 'darwin') assert.equal(records()[0].tty, true);
  assert.throws(() => manager.submitCode(sessionId, 'bad\ncode'), /1行/);
  manager.submitCode(sessionId, 'fixture-code'); assert.equal((await finished(manager, sessionId)).state, 'succeeded');
  assert.ok(records().some((r) => r.codeAccepted)); assert.equal(manager.sessions.get(sessionId).didExit, true);
});
test('Claude manual mode, failure and cancellation clean up their sockets', async (t) => {
  for (const scenario of ['success', 'failure', 'hold']) {
    const { manager, home, marker, root, calls, records } = setup(t, { scenario }); home.agent = 'claude'; marker();
    const { sessionId } = await manager.start(home, { mode: 'manual' });
    if (scenario === 'hold') { await ready(manager, sessionId); await manager.cancel(sessionId); }
    const result = await finished(manager, sessionId);
    assert.equal(result.state, { success: 'succeeded', failure: 'failed', hold: 'cancelled' }[scenario]); assert.equal(calls.length, 0); assert.equal(result.authUrl, null);
    const pid = records()[0]?.pid; if (pid) await waitFor(() => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } });
    assert.deepEqual(fs.readdirSync(path.join(root, 'run')), []);
  }
});
test('saved deleted profiles and absent CLI require reselection before any process starts', async (t) => {
  const { manager, home, launches } = setup(t);
  fs.writeFileSync(path.join(home.dir, LOGIN_TARGET_FILE), JSON.stringify({ ...auto, profileId: 'Profile 99' }));
  await assert.rejects(manager.start(home), /選び直/); assert.equal(launches.length, 0);
  manager.resolveCli = () => null; await assert.rejects(manager.start(home, { mode: 'manual' }), /CLIが見つかりません/);
});
test('shutdown terminates an unresponsive Claude PTY child without touching a sibling', async (t) => {
  const a = setup(t, { scenario: 'stubborn' }), b = setup(t);
  a.home.agent = 'claude'; a.marker(); b.home.agent = 'claude'; b.marker();
  const first = await a.manager.start(a.home, { mode: 'manual' }); await ready(a.manager, first.sessionId);
  const other = await b.manager.start(b.home, { mode: 'manual' }); await ready(b.manager, other.sessionId);
  await a.manager.shutdown(); assert.equal(a.manager.status(first.sessionId).state, 'cancelled');
  await waitFor(() => { try { process.kill(a.records()[0].pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } });
  assert.equal(b.manager.status(other.sessionId).state, 'waiting'); assert.doesNotThrow(() => process.kill(b.records()[0].pid, 0));
});

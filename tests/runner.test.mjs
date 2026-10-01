// Account runner: Canban-made account folders, the statusline tap, and how the
// accounts registry picks them up. Everything happens in a temporary folder.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHome, removeHome, listRunnerHomes, loginCommand, readTapUsage, slugName, MARKER } from '../server/runner.mjs';
import { configureAccounts, refreshAccounts, claudeHomes, accountLimits, resetAccountsForTest, runAs, accountChoices, roomiest, homeEnv } from '../server/accounts.mjs';
import { applyCardAccounts, startFolderFor, pinSessionAccount, accountForRun, retryAccount, LIMIT_ERROR } from '../server/accounts-mcp.mjs';
import { newSessionCommand, resumeCommand } from '../server/agents.mjs';
import { Store } from '../server/store.mjs';
import { listClaudeSessions } from '../server/sources/claude.mjs';
import { normalizeAccounts, applyAccountPatch } from '../server/accounts-settings.mjs';
import { accountTools } from '../server/accounts-mcp.mjs';

const TAP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'statusline-tap.mjs');
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

let root, data, claude, codex;
const saved = {};
before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canban-runner-')));
  data = path.join(root, 'data');
  claude = path.join(root, 'claude');
  codex = path.join(root, 'codex');
  write(path.join(claude, 'projects', '-r-app', 's1.jsonl'), `${JSON.stringify({ type: 'user', cwd: '/r/app', timestamp: '2026-09-30T00:00:00Z', message: { content: 'hello' } })}\n`);
  write(path.join(claude, 'CLAUDE.md'), '# rules\n');
  fs.mkdirSync(path.join(claude, 'skills'));
  write(path.join(claude, 'settings.json'), JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: 'echo original-status' } }));
  write(path.join(codex, 'config.toml'), 'model = "x"\n');
  write(path.join(codex, 'AGENTS.md'), '# agents\n');
  for (const [k, v] of Object.entries({ CANBAN_DATA_DIR: data, CANBAN_CLAUDE_HOME: claude, CANBAN_CODEX_HOME: codex, CANBAN_CLAUDE_DESKTOP_DIR: path.join(root, 'desktop', 'claude-code-sessions') })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
after(() => {
  for (const [k, v] of Object.entries(saved)) v == null ? delete process.env[k] : (process.env[k] = v);
  fs.rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  resetAccountsForTest();
  configureAccounts({ claudeHomes: [], codexHomes: [], discover: false });
});

test('a Claude folder shares conversations and settings, and taps the statusline', () => {
  const h = createHome({ dataDir: data, agent: 'claude', name: 'Work', sourceHome: claude });
  assert.equal(h.id, 'claude-work');
  assert.equal(fs.readlinkSync(path.join(h.dir, 'projects')), path.join(claude, 'projects'));
  assert.equal(fs.readlinkSync(path.join(h.dir, 'CLAUDE.md')), path.join(claude, 'CLAUDE.md'));
  assert.ok(fs.lstatSync(path.join(h.dir, 'skills')).isSymbolicLink());
  const settings = JSON.parse(fs.readFileSync(path.join(h.dir, 'settings.json'), 'utf8'));
  assert.equal(settings.theme, 'dark'); // copied, not linked
  assert.ok(!fs.lstatSync(path.join(h.dir, 'settings.json')).isSymbolicLink());
  assert.match(settings.statusLine.command, /statusline-tap\.mjs/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, MARKER), 'utf8')).statusLine, 'echo original-status');
  assert.equal(loginCommand(h), `CLAUDE_CONFIG_DIR=${h.dir} claude auth login`);
  // the source folder is untouched
  assert.equal(JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8')).statusLine.command, 'echo original-status');
});

test('a Codex folder copies config.toml and links AGENTS.md', () => {
  const h = createHome({ dataDir: data, agent: 'codex', name: 'side', sourceHome: codex });
  assert.equal(fs.readFileSync(path.join(h.dir, 'config.toml'), 'utf8'), 'model = "x"\n');
  assert.ok(!fs.lstatSync(path.join(h.dir, 'config.toml')).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(h.dir, 'AGENTS.md')).isSymbolicLink());
  assert.equal(loginCommand(h), `CODEX_HOME=${h.dir} codex login`);
  assert.deepEqual(listRunnerHomes(data).map((x) => x.id), ['claude-work', 'codex-side']);
});

test('names, duplicates and removal are guarded', () => {
  assert.equal(slugName(' My Team 2 '), 'my-team-2');
  assert.throws(() => slugName('日本語'), /英数字/);
  assert.throws(() => createHome({ dataDir: data, agent: 'claude', name: 'work', sourceHome: claude }), /もうあります/);
  assert.throws(() => createHome({ dataDir: data, agent: 'gemini', name: 'x', sourceHome: claude }), /Claude か Codex/);
  fs.mkdirSync(path.join(data, 'accounts', 'not-ours'));
  assert.throws(() => removeHome({ dataDir: data, id: 'not-ours' }), /Canban が作った/);
  assert.throws(() => removeHome({ dataDir: data, id: '../claude' }), /Canban が作った/);
  const tmp = createHome({ dataDir: data, agent: 'claude', name: 'tmp', sourceHome: claude });
  const res = removeHome({ dataDir: data, id: tmp.id, now: 1 });
  assert.ok(!fs.existsSync(tmp.dir));
  assert.ok(fs.existsSync(path.join(res.movedTo, MARKER))); // moved, not deleted
  assert.ok(fs.existsSync(path.join(claude, 'projects', '-r-app', 's1.jsonl'))); // shared conversations stay
});

test('the statusline tap records usage and still prints the original status line', () => {
  const input = JSON.stringify({ model: { id: 'x' }, rate_limits: { five_hour: { used_percentage: 42, resets_at: 4102444800 }, seven_day: { used_percentage: 7, resets_at: 4102444800 } } });
  const r = spawnSync(process.execPath, [TAP, path.join(data, 'usage'), 'claude-work'], { input });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.toString().trim(), 'original-status');
  const [u] = readTapUsage(data);
  assert.equal(u.homeId, 'claude-work');
  assert.equal(u.fiveHour.used_percentage, 42);
  // no rate_limits (API key users, before the first reply): nothing written, status still printed
  const r2 = spawnSync(process.execPath, [TAP, path.join(data, 'usage'), 'codex-side'], { input: '{}' });
  assert.equal(r2.status, 0);
  assert.equal(readTapUsage(data).length, 1);
});

test('runner folders become homes; their usage counts for their account; shared conversations are read once', async () => {
  write(path.join(data, 'accounts', 'claude-work', '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct-w', emailAddress: 'w@example.com' } }));
  await refreshAccounts({ force: true });
  const homes = await claudeHomes();
  assert.deepEqual(homes.map((h) => [h.id, h.source]), [['default', 'default'], ['claude-work', 'runner']]);
  const l = accountLimits(new Map()).find((x) => x.key === 'claude:acct-w');
  assert.equal(l.source, 'statusline');
  assert.equal(l.primary.usedPercent, 42);
  assert.equal(l.primary.windowMinutes, 300);
  const { sessions } = await listClaudeSessions({ desktopDir: path.join(root, 'none') });
  assert.deepEqual(sessions.map((s) => s.nativeId), ['s1']);
  assert.equal(sessions[0].home, undefined); // listed from the default folder
});

test('runner settings: off by default, patched field by field, limit clamped', () => {
  assert.deepEqual(normalizeAccounts({}).runner, { enabled: false, shareProjects: true, shareConfig: true, limitAt: 95 });
  const a = normalizeAccounts(applyAccountPatch(normalizeAccounts({}), { runner: { enabled: true, limitAt: 20 } }));
  assert.deepEqual(a.runner, { enabled: true, shareProjects: true, shareConfig: true, limitAt: 50 });
});

test('creating a folder is refused while the runner is off', async () => {
  const store = { load: async () => ({ settings: { accounts: normalizeAccounts({}), launch: { terminal: 'none' } } }) };
  const appTool = (name, _t, _p, _r, fn) => ({ name, fn });
  const tools = accountTools({ store, allSessions: async () => ({ sessions: [] }), appTool, meta: {} });
  const create = tools.find((t) => t.name === 'canban_account_create');
  await assert.rejects(create.fn({ agent: 'claude', name: 'x' }), /オフ/);
  assert.ok(!fs.existsSync(path.join(data, 'accounts', 'claude-x')));
});

// ---- sessions and accounts (phase B) --------------------------------------------
async function signedIn() {
  // claude-work (shared projects) is acct-w; a second folder without shared conversations is acct-s
  if (!fs.existsSync(path.join(data, 'accounts', 'claude-solo'))) {
    createHome({ dataDir: data, agent: 'claude', name: 'solo', sourceHome: claude, shareProjects: false });
    write(path.join(data, 'accounts', 'claude-solo', '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct-s', emailAddress: 's@example.com' } }));
  }
  write(path.join(claude, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct-d', emailAddress: 'd@example.com' } }));
  await refreshAccounts({ force: true });
  const { sessions } = await listClaudeSessions({ desktopDir: path.join(root, 'none') });
  return sessions.find((x) => x.nativeId === 's1');
}

test('a Claude conversation moves only to accounts whose folder shares it', async () => {
  const s1 = await signedIn();
  const r = runAs(s1, 'claude:acct-w');
  assert.equal(r.ok, true);
  assert.equal(r.session.homeDir, path.join(data, 'accounts', 'claude-work'));
  assert.match(resumeCommand(r.session), /CLAUDE_CONFIG_DIR=\S*claude-work claude --resume s1/);
  assert.deepEqual(homeEnv(r.session), { CLAUDE_CONFIG_DIR: path.join(data, 'accounts', 'claude-work') }); // what a sent prompt runs with
  assert.match(runAs(s1, 'claude:acct-s').reason, /共有していません/);
  assert.match(runAs(s1, 'claude:nobody').reason, /フォルダがありません/);
  assert.match(runAs(s1, 'codex:cx').reason, /別の AI App/);
  assert.deepEqual(accountChoices({ ...s1, account: null }).sort(), ['claude:acct-d', 'claude:acct-w']);
  // back to the default folder's account: no folder in the environment
  const back = runAs(r.session, 'claude:acct-d');
  assert.equal(back.session.homeDir, undefined);
  assert.doesNotMatch(resumeCommand(back.session), /CLAUDE_CONFIG_DIR/);
});

test('a Codex thread stays with the folder that made it', () => {
  const t = { id: 'codex:t', agent: 'codex', nativeId: 't', account: 'codex:a', host: { local: true } };
  assert.match(runAs(t, 'codex:b').reason, /フォルダ/);
});

test('card pin wins over the last-used account; a pin that cannot apply is reported', async () => {
  const s1 = await signedIn();
  const [pinned] = applyCardAccounts([s1], { cards: { [s1.id]: { accountPin: 'claude:acct-w', lastAccount: 'claude:acct-d' } } });
  assert.equal(pinned.account, 'claude:acct-w');
  assert.equal(pinned.accountSource, 'pin');
  const [last] = applyCardAccounts([s1], { cards: { [s1.id]: { lastAccount: 'claude:acct-w' } } });
  assert.equal(last.accountSource, 'last');
  assert.ok(last.homeDir);
  const [bad] = applyCardAccounts([s1], { cards: { [s1.id]: { accountPin: 'claude:acct-s' } } });
  assert.match(bad.accountPinProblem, /共有していません/);
  assert.equal(bad.homeDir, undefined);
  const [untouched] = applyCardAccounts([s1], { cards: {} });
  assert.equal(untouched, s1);
});

test('new sessions start in the chosen account folder; auto picks the one with most room', async () => {
  await signedIn();
  write(path.join(data, 'usage', 'home-claude-work.json'), JSON.stringify({ at: Date.now(), five_hour: { used_percentage: 10, resets_at: 4102444800 }, seven_day: { used_percentage: 20, resets_at: 4102444800 } }));
  write(path.join(data, 'usage', 'home-claude-solo.json'), JSON.stringify({ at: Date.now(), five_hour: { used_percentage: 90, resets_at: 4102444800 }, seven_day: { used_percentage: 5, resets_at: 4102444800 } }));
  assert.equal(roomiest('claude', new Map()), 'claude:acct-w'); // 20% vs 90%; acct-d has no record: last
  const f = startFolderFor('claude', 'auto');
  assert.equal(f.key, 'claude:acct-w');
  assert.match(newSessionCommand('claude', { host: { local: true }, cwd: '/r/app', prompt: 'hi', homeDir: f.homeDir }), /^cd \/r\/app 2>\/dev\/null; CLAUDE_CONFIG_DIR=\S*claude-work claude hi$/);
  assert.deepEqual(startFolderFor('claude', 'claude:acct-d'), { key: 'claude:acct-d', homeDir: null });
  assert.throws(() => startFolderFor('claude', 'claude:nobody'), /フォルダがありません/);
});

test('pins are stored on the card; a session started as an account remembers it', async () => {
  const s1 = await signedIn();
  const store = new Store(fs.mkdtempSync(path.join(root, 'store-')));
  const findSession = async () => ({ session: s1, state: await store.load() });
  const r = await pinSessionAccount({ store, findSession, limits: new Map() }, { cardId: s1.id, account: 'auto' });
  assert.equal(r.account, 'claude:acct-w');
  assert.equal((await store.load()).cards[s1.id].accountPin, 'claude:acct-w');
  await assert.rejects(pinSessionAccount({ store, findSession }, { cardId: s1.id, account: 'claude:acct-s' }), /共有していません/);
  await pinSessionAccount({ store, findSession }, { cardId: s1.id, account: null });
  assert.equal((await store.load()).cards[s1.id].accountPin, undefined);
  const task = await store.createTask({ title: 't' });
  await store.resolvePending([{ taskId: task.cardId || task.id, sessionId: 'claude:new', startedAt: 1, account: 'claude:acct-w' }]);
  assert.equal((await store.load()).cards['claude:new'].lastAccount, 'claude:acct-w');
});

// ---- plan limits (phase C) --------------------------------------------------------
test('at the limit, a switch request runs as the account with room; otherwise it stays', async () => {
  const s1 = await signedIn(); // acct-d (default, no record), acct-w 20%, acct-s 90% (not sharing)
  write(path.join(data, 'usage', 'home-claude-work.json'), JSON.stringify({ at: Date.now(), five_hour: { used_percentage: 97, resets_at: 4102444800 }, seven_day: { used_percentage: 40, resets_at: 4102444800 } }));
  const [onW] = applyCardAccounts([s1], { cards: { [s1.id]: { lastAccount: 'claude:acct-w' } } });
  const sw = accountForRun(onW, { onLimit: 'switch' }, { limitAt: 95, codexLimits: new Map() });
  assert.deepEqual(sw.switched, { from: 'claude:acct-w', to: 'claude:acct-d' }); // acct-s is not sharing the conversation
  assert.equal(sw.session.homeDir, undefined);
  assert.equal(accountForRun(onW, { onLimit: 'wait' }, { limitAt: 95, codexLimits: new Map() }).switched, null);
  assert.equal(accountForRun(onW, { onLimit: 'switch' }, { limitAt: 99, codexLimits: new Map() }).switched, null); // under the threshold
  // a retry's account is applied as is
  assert.equal(accountForRun(s1, { runAccount: 'claude:acct-w' }, { codexLimits: new Map() }).session.account, 'claude:acct-w');
});

test('a turn stopped by a usage limit is retried once, as another account', async () => {
  const s1 = await signedIn();
  write(path.join(data, 'usage', 'home-claude-work.json'), JSON.stringify({ at: Date.now(), five_hour: { used_percentage: 10, resets_at: 4102444800 } }));
  const req = { onLimit: 'switch', account: 'claude:acct-d' };
  assert.equal(retryAccount(req, s1, 'Claude AI usage limit reached|1790000000', { codexLimits: new Map() }), 'claude:acct-w');
  assert.equal(retryAccount({ ...req, switchedFrom: 'req-1' }, s1, 'usage limit reached', { codexLimits: new Map() }), null); // once
  assert.equal(retryAccount({ ...req, onLimit: 'wait' }, s1, 'usage limit reached', { codexLimits: new Map() }), null);
  assert.equal(retryAccount(req, s1, 'Failed to authenticate', { codexLimits: new Map() }), null); // other errors pause as before
  for (const m of ["You've hit your usage limit", 'Rate limit reached', 'rate_limit_error', "You've hit your limit · resets 5pm"]) assert.match(m, LIMIT_ERROR);
});

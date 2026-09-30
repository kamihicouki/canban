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
import { configureAccounts, refreshAccounts, claudeHomes, accountLimits, resetAccountsForTest } from '../server/accounts.mjs';
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

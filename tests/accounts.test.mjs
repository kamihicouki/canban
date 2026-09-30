// Accounts: sessions of every account and config folder, who they belong to, and
// usage per account (Codex from the logs, Claude from the desktop profiles).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { listClaudeSessions } from '../server/sources/claude.mjs';
import { listCodexSessions } from '../server/sources/codex.mjs';
import { configureAccounts, refreshAccounts, accountsView, accountLimits, desktopAccountMismatch, homeEnv, resetAccountsForTest } from '../server/accounts.mjs';
import { noteLimits, limitsByAccount, resetLimitsForTest } from '../server/signals.mjs';
import { resumeCommand } from '../server/agents.mjs';
import { computeStats } from '../server/stats.mjs';
import { defaultState } from '../server/store.mjs';

const line = (o) => `${JSON.stringify(o)}\n`;
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const transcript = (dir, id, prompt) =>
  write(path.join(dir, 'projects', '-r-app', `${id}.jsonl`), line({ type: 'user', cwd: '/r/app', timestamp: '2026-09-29T00:00:00Z', message: { content: prompt } }));
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

let root;
const env = {};
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-acct-'));
  const support = path.join(root, 'Application Support');
  const app = path.join(support, 'Claude');
  const sessions = path.join(app, 'claude-code-sessions');
  // Desktop (default profile): signed in to acct-a. acct-b sees acct-a's org through a link,
  // and has an org of its own.
  write(path.join(app, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'acct-a', 'oauth:tokenCache': 'SECRET-DESKTOP' }));
  write(path.join(sessions, 'acct-a', 'org-a', 'local_1.json'), JSON.stringify({ sessionId: 'local_1', cliSessionId: 's1', title: 'shared', lastActivityAt: 1 }));
  fs.mkdirSync(path.join(sessions, 'acct-b'), { recursive: true });
  fs.symlinkSync(path.join(sessions, 'acct-a', 'org-a'), path.join(sessions, 'acct-b', 'org-b'));
  write(path.join(sessions, 'acct-b', 'org-c', 'local_2.json'), JSON.stringify({ sessionId: 'local_2', cliSessionId: 's2', title: 'b only', lastActivityAt: 1 }));
  write(path.join(app, 'plan-usage-history.json'), JSON.stringify({ version: 2, samples: [{ t: 1, org: 'org-a', u: { fh: 10, sd: 20 } }, { t: 2, org: 'org-a', u: { fh: 15, sd: 25 } }] }));
  // A second desktop profile beside it, signed in to acct-b (its own usage history).
  write(path.join(support, 'Claude-work', 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'acct-b' }));
  write(path.join(support, 'Claude-work', 'plan-usage-history.json'), JSON.stringify({ version: 2, samples: [{ t: 5, org: 'org-c', u: { fh: 50, sd: 97 } }, { t: 9, org: 'org-c', u: {} }] }));

  // Claude homes: the default one, and a CLAUDE_CONFIG_DIR folder signed in to acct-c.
  const claudeHome = path.join(root, 'claude');
  transcript(claudeHome, 's1', 'shared session');
  transcript(claudeHome, 's2', 'b session');
  transcript(claudeHome, 's4', 'cli only');
  const work = path.join(root, 'claude-work');
  transcript(work, 's3', 'work session');
  write(path.join(work, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct-c', emailAddress: 'c@example.com', organizationUuid: 'org-z' } }));

  // Codex: one thread with a recorded account, one without; auth.json names the account.
  const codexHome = path.join(root, 'codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, cwd TEXT, title TEXT, first_user_message TEXT, archived INTEGER, creator_account_id TEXT)');
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?)').run('x1', '', 1790000000, 1790000000, '/r/app', 'with account', 'with account', 0, 'cx-1');
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?)').run('x2', '', 1790000000, 1790000000, '/r/app', 'old thread', 'old thread', 0, null);
  db.close();
  write(path.join(codexHome, 'auth.json'), JSON.stringify({ tokens: { account_id: 'cx-1', access_token: 'SECRET-ACCESS', refresh_token: 'SECRET-REFRESH', id_token: jwt({ email: 'x@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }) } }));

  for (const [k, v] of Object.entries({ CANBAN_CLAUDE_HOME: claudeHome, CANBAN_CODEX_HOME: codexHome, CANBAN_CLAUDE_DESKTOP_DIR: sessions })) {
    env[k] = process.env[k];
    process.env[k] = v;
  }
  env.work = work;
});
after(() => {
  for (const [k, v] of Object.entries(env)) if (k.startsWith('CANBAN_')) v == null ? delete process.env[k] : (process.env[k] = v);
  fs.rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  resetAccountsForTest();
  resetLimitsForTest();
  configureAccounts({ claudeHomes: [env.work], codexHomes: [], discover: true });
});

async function everything() {
  const [claude, codex] = await Promise.all([listClaudeSessions(), listCodexSessions()]);
  assert.equal(claude.error, null);
  assert.equal(codex.error, null);
  return [...claude.sessions, ...codex.sessions];
}
const by = (sessions, nativeId) => sessions.find((s) => s.nativeId === nativeId);

test('every account and config folder is listed, each session with its account', async () => {
  const all = await everything();
  assert.deepEqual(all.map((s) => s.nativeId).sort(), ['s1', 's2', 's3', 's4', 'x1', 'x2']);
  // A folder linked into another account belongs to its real location, and says who sees it.
  assert.equal(by(all, 's1').account, 'claude:acct-a');
  assert.deepEqual(by(all, 's1').desktopReach.sort(), ['acct-a', 'acct-b']);
  assert.equal(by(all, 's2').account, 'claude:acct-b');
  // A CLI-only session in the default folder: unknown. In a profile folder: that folder's account.
  assert.equal(by(all, 's4').account, null);
  assert.equal(by(all, 's3').account, 'claude:acct-c');
  assert.equal(by(all, 's3').home, 'claude-work');
  assert.equal(by(all, 'x1').account, 'codex:cx-1');
  assert.equal(by(all, 'x2').account, null);
});

test('sessions from another config folder resume and run there', async () => {
  const s3 = by(await everything(), 's3');
  assert.match(resumeCommand(s3), /CLAUDE_CONFIG_DIR=\S*claude-work claude --resume s3$/);
  assert.deepEqual(homeEnv(s3), { CLAUDE_CONFIG_DIR: env.work });
  const s1 = by(await everything(), 's1');
  assert.doesNotMatch(resumeCommand(s1), /CLAUDE_CONFIG_DIR/);
  assert.deepEqual(homeEnv(s1), {});
});

test('the desktop app is flagged only for sessions the signed-in account cannot see', async () => {
  const all = await everything();
  assert.equal(desktopAccountMismatch(by(all, 's1')), null); // linked: visible to both accounts
  assert.deepEqual(desktopAccountMismatch(by(all, 's2')), { session: 'claude:acct-b', active: 'claude:acct-a' });
  assert.equal(desktopAccountMismatch(by(all, 's3')), null); // not a desktop session
});

test('usage per account: Claude from every desktop profile, Codex from the logs', async () => {
  const all = await everything();
  noteLimits({ at: 3, primary: { usedPercent: 40, windowMinutes: 300, resetsAt: Date.now() + 3600e3 }, secondary: null, plan: 'plus' }, 'codex:cx-1');
  const limits = new Map(accountLimits(limitsByAccount()).map((l) => [l.key, l]));
  assert.equal(limits.get('claude:acct-a').primary.usedPercent, 15); // newest sample
  assert.equal(limits.get('claude:acct-a').secondary.windowMinutes, 10080);
  assert.equal(limits.get('claude:acct-b').secondary.usedPercent, 97); // from the other profile; empty samples skipped
  assert.equal(limits.get('codex:cx-1').primary.usedPercent, 40);

  const v = accountsView({ labels: { 'claude:acct-a': '仕事' }, sessions: all, codexLimits: limitsByAccount() });
  const acct = (k) => v.accounts.find((a) => a.key === k);
  assert.equal(acct('claude:acct-a').label, '仕事');
  assert.deepEqual(acct('claude:acct-a').signedIn, ['desktop']);
  assert.deepEqual(acct('claude:acct-b').signedIn, ['desktop:Claude-work']);
  assert.equal(acct('claude:acct-b').label, 'work'); // no e-mail on disk: the desktop profile's name
  assert.equal(acct('claude:acct-c').label, 'c@example.com');
  assert.equal(acct('codex:cx-1').label, 'x@example.com');
  assert.equal(acct('codex:cx-1').plan, 'plus');
  assert.equal(acct('claude:acct-a').count, 1);
  assert.deepEqual(v.unknown, { codex: 1, claude: 1 });
  assert.deepEqual(v.homes.map((h) => [h.agent, h.id, h.source]), [['codex', 'default', 'default'], ['claude', 'default', 'default'], ['claude', 'claude-work', 'settings']]);
  // Tokens are never read into anything Canban returns.
  assert.doesNotMatch(JSON.stringify(v), /SECRET/);
});

test('analytics break down and filter by account', async () => {
  const all = await everything();
  await refreshAccounts({ force: true });
  const state = defaultState();
  const now = Date.parse('2026-09-30T00:00:00Z');
  const st = computeStats(state, all, { days: 3650, now });
  assert.ok(st.accounts.some((r) => r.name.startsWith('Claude · ') && r.sessions === 1));
  assert.equal(computeStats(state, all, { days: 3650, now, account: 'codex:cx-1' }).totals.sessions, 1);
  assert.equal(computeStats(state, all, { days: 3650, now, account: '__none' }).totals.sessions, 2);
});

test('removing a config folder drops its sessions', async () => {
  configureAccounts({ claudeHomes: [], codexHomes: [], discover: true });
  const all = await everything();
  assert.equal(by(all, 's3'), undefined);
});

test('header marks: initials and colors tell accounts apart; hidden accounts leave the header', async () => {
  const all = await everything();
  const v = accountsView({ marks: { 'claude:acct-b': { short: 'W', color: 'pink' } }, hidden: ['codex:cx-1'], sessions: all });
  const acct = (k) => v.accounts.find((a) => a.key === k);
  assert.equal(acct('claude:acct-b').short, 'W');
  assert.equal(acct('claude:acct-b').color, 'pink');
  assert.equal(acct('claude:acct-c').short, 'C'); // from c@example.com
  const colors = v.accounts.map((a) => a.color);
  assert.equal(new Set(colors).size, colors.length); // every account its own color
  assert.ok(!colors.some((c) => ['green', 'orange', 'red'].includes(c))); // those mean "how full"
  assert.equal(acct('codex:cx-1').inHeader, false);
  assert.equal(acct('claude:acct-a').inHeader, true);
});

test('account marks and header visibility are stored and validated', async () => {
  const { Store } = await import('../server/store.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-acct-store-'));
  try {
    const store = new Store(dir);
    await store.updateAccountSettings({ mark: { key: 'claude:acct-a', short: 'Main', color: 'purple' } });
    await store.updateAccountSettings({ mark: { key: 'claude:acct-b', color: 'red' } }); // not an account color
    await store.updateAccountSettings({ visible: { key: 'codex:cx-1', on: false } });
    let a = store.load().settings.accounts;
    assert.deepEqual(a.marks, { 'claude:acct-a': { short: 'Ma', color: 'purple' } });
    assert.deepEqual(a.hidden, ['codex:cx-1']);
    await store.updateAccountSettings({ visible: { key: 'codex:cx-1', on: true } });
    await store.updateAccountSettings({ mark: { key: 'claude:acct-a', short: '' } });
    a = store.load().settings.accounts;
    assert.deepEqual(a.hidden, []);
    assert.deepEqual(a.marks, { 'claude:acct-a': { color: 'purple' } });
    await assert.rejects(async () => store.updateAccountSettings({ visible: { key: '../x', on: false } }), /アカウントが不正/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

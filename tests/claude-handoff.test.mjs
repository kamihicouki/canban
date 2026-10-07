import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureAccounts, refreshAccounts } from '../server/accounts.mjs';
import { claudeExecutionSession, claudeResumeAccounts, groupClaudeResumeAccounts } from '../server/claude-handoff.mjs';
import { resumeCommand, headlessArgs } from '../server/agents.mjs';
import { Store } from '../server/store.mjs';
import { dispatcherFor } from '../server/dispatch.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-claude-handoff-'));
const source = path.join(root, 'source');
const target = path.join(root, 'second account');
const cwd = path.join(root, 'same worktree');
const log = path.join(root, 'agent.jsonl');
const transcript = path.join(source, 'projects', '-same-worktree', 'kept-id.jsonl');
const identity = (dir, id) => fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: id, emailAddress: `${id}@example.test` } }));
const session = { id: 'claude:kept-id', agent: 'claude', nativeId: 'kept-id', cwd, branch: 'codex/unchanged', sourcePath: transcript, account: 'claude:first', status: 'idle' };
const env = { ...process.env };
let snapshot;

before(async () => {
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.mkdirSync(path.join(target, 'projects'), { recursive: true });
  fs.mkdirSync(cwd);
  fs.writeFileSync(transcript, [
  { type: 'user', sessionId: 'kept-id', cwd: '/old/main-checkout', gitBranch: 'main', permissionMode: 'acceptEdits', timestamp: '2026-09-01T00:00:00Z', message: { content: 'keep this conversation' } },
  { type: 'assistant', cwd, gitBranch: session.branch, timestamp: '2026-09-01T00:00:01Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'existing reply' }] } },
  ].map(o => JSON.stringify(o) + '\n').join(''));
  fs.utimesSync(transcript, 1, 1);
  identity(source, 'first'); identity(target, 'second');
  fs.writeFileSync(path.join(source, '.credentials.json'), 'SOURCE-CREDENTIAL-FIXTURE');
  fs.writeFileSync(path.join(target, '.credentials.json'), 'TARGET-CREDENTIAL-FIXTURE');
  Object.assign(process.env, { CANBAN_CLAUDE_HOME: source, CANBAN_CLAUDE_DESKTOP_DIR: path.join(root, 'desktop'), CANBAN_CODEX_HOME: path.join(root, 'codex'), CANBAN_CLAUDE_BIN: fileURLToPath(new URL('./fake-claude.sh', import.meta.url)), FAKE_AGENT_LOG: log, ANTHROPIC_API_KEY: 'INHERITED-FIXTURE', CLAUDE_CODE_OAUTH_TOKEN: 'INHERITED-FIXTURE', CLAUDECODE: '1' });
  configureAccounts({ claudeHomes: [target], codexHomes: [], discover: false });
  homeId = (await refreshAccounts({ force: true })).homes.claude.find(h => h.dir === target).id;
  snapshot = [transcript, path.join(source, '.claude.json'), path.join(target, '.claude.json'), path.join(source, '.credentials.json'), path.join(target, '.credentials.json')].map(file => [file, fs.readFileSync(file)]);
});
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  fs.rmSync(root, { recursive: true, force: true });
});
let homeId;
const newStore = async name => {
  const store = new Store(path.join(root, name));
  await store.updateAccountSettings({ claudeHomes: [target], discover: false });
  return store;
};
const waitFor = async fn => {
  for (let i = 0; i < 100; i++) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 30)); }
  throw new Error('fake Claude did not finish');
};

test('execution accounts share canonical identities while seven CLI settings remain available', () => {
  const accounts = ['codex:first', 'codex:second', 'claude:first', 'claude:second'].map(key => ({
    key, agent: key.split(':')[0], email: `${key.split(':')[1]}@example.test`, label: `${key.split(':')[1]}@example.test`,
  }));
  const profiles = [4, 3].flatMap((count, i) => Array.from({ length: count }, (_, j) => ({
    id: i === 0 && j === 0 ? 'default' : `config-${i}-${j}`, account: `claude:${i ? 'second' : 'first'}`,
    default: i === 0 && j === 0, configKind: 'canban', dir: `/fixture/${i}/${j}`, desktop: { profile: i ? 'ppb' : 'main' },
  })));
  const saved = { account: 'claude:second', homeId: 'config-1-2' };
  const grouped = groupClaudeResumeAccounts(profiles, accounts, session, saved);
  assert.deepEqual(grouped.map(a => a.key), accounts.filter(a => a.agent === 'claude').map(a => a.key));
  assert.deepEqual(grouped.map(a => a.profiles.length), [4, 3]);
  assert.equal(grouped[0].preferredHomeId, 'default');
  assert.equal(grouped[1].preferredHomeId, saved.homeId);
  assert.equal(grouped[1].description, 'Claude Code · Desktop: ppb');
  assert.equal(grouped[0].profiles[0].label, '標準 CLI');
  assert.deepEqual(saved, { account: 'claude:second', homeId: 'config-1-2' });
  assert.deepEqual(profiles.map(p => p.id), ['default', 'config-0-1', 'config-0-2', 'config-0-3', 'config-1-0', 'config-1-1', 'config-1-2']);
});

test('grouping never merges different account IDs by email and prefers the exact source setting', () => {
  const accounts = ['claude:first', 'claude:second', 'codex:first'].map(key => ({ key, agent: key.split(':')[0], label: 'shared@example.test', email: 'shared@example.test' }));
  const profiles = [{ id: 'default', account: 'claude:first', default: true }, { id: 'source-copy', account: 'claude:first' }, { id: 'second', account: 'claude:second' }];
  const grouped = groupClaudeResumeAccounts(profiles, accounts, { ...session, home: 'source-copy' }, { account: 'claude:second', homeId: 'missing' });
  assert.deepEqual(grouped.map(a => a.key), ['claude:first', 'claude:second']);
  assert.equal(grouped[0].preferredHomeId, 'source-copy');
  assert.equal(grouped[1].preferredHomeId, 'second');
});

test('registered CLI profiles offer explicit transcript commands without exposing credentials', async () => {
  const options = await claudeResumeAccounts(session);
  assert.deepEqual(options.map(o => o.account), ['claude:first', 'claude:second']);
  assert.equal(options[1].id, homeId);
  assert.equal(options[1].label, 'second@example.test');
  assert.match(options[1].description, /Claude Code CLI · 追加設定 second account/);
  assert.equal(options[0].sameAccount, true);
  assert.equal(options[1].sameAccount, false);
  assert.match(options[1].command, /CLAUDE_CONFIG_DIR=/);
  assert.ok(options[1].command.includes(transcript));
  assert.doesNotMatch(JSON.stringify(options), /CREDENTIAL-FIXTURE|INHERITED-FIXTURE/);
  assert.deepEqual(await claudeResumeAccounts({ ...session, host: { local: false } }), []);
});

test('handoff preserves cwd, branch, ID, transcript and both auth profiles', async () => {
  const selected = await claudeExecutionSession(session, homeId);
  assert.equal(selected.nativeId, session.nativeId);
  assert.equal(selected.cwd, cwd);
  assert.equal(selected.branch, session.branch);
  assert.equal(selected.resumePath, transcript);
  assert.equal(selected.homeDir, target);
  assert.equal(selected.executionAccount, 'claude:second');
  assert.match(resumeCommand(selected), /2>\/dev\/null && env /);
  assert.deepEqual(headlessArgs(selected, { mode: 'acceptEdits' }).args, ['-p', '--resume', transcript, '--output-format', 'json', '--permission-mode', 'acceptEdits']);
  assert.strictEqual(await claudeExecutionSession(session, undefined), session);
  for (const [file, contents] of snapshot) assert.deepEqual(fs.readFileSync(file), contents);
  assert.deepEqual(fs.readdirSync(path.join(target, 'projects')), []);
});

test('unregistered, remote, missing transcripts and API auth overrides fail explicitly', async () => {
  await assert.rejects(claudeExecutionSession(session, '/arbitrary/home'), /アカウントが見つかりません/);
  await assert.rejects(claudeExecutionSession({ ...session, agent: 'codex' }, homeId), /このマシン/);
  await assert.rejects(claudeExecutionSession({ ...session, host: { local: false } }, homeId), /このマシン/);
  await assert.rejects(claudeExecutionSession({ ...session, sourcePath: '/missing.jsonl' }, homeId), /確認できません/);
  const settings = path.join(target, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ apiKeyHelper: 'do-not-run' }));
  await assert.rejects(claudeExecutionSession(session, homeId), /API 認証/);
  fs.writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'do-not-use' } }));
  await assert.rejects(claudeExecutionSession(session, homeId), /API 認証/);
  fs.unlinkSync(settings);
});

test('stale login metadata cannot resume with no login or another effective account', async () => {
  process.env.FAKE_AUTH_LOGGED_IN = '0';
  await assert.rejects(claudeExecutionSession(session, homeId), /ログインしていません/);
  delete process.env.FAKE_AUTH_LOGGED_IN;
  process.env.FAKE_AUTH_EMAIL = 'another@example.test';
  await assert.rejects(claudeExecutionSession(session, homeId), /実際の認証先/);
  delete process.env.FAKE_AUTH_EMAIL;
});

test('headless handoff runs a fake CLI in the same worktree under only the selected profile', async () => {
  const store = await newStore('dispatch-now');
  const d = dispatcherFor(store);
  const request = await d.submit({ cardId: session.id, prompt: 'continue with second account', when: 'now', claudeHome: homeId });
  const completed = await waitFor(async () => { const r = (await d.requests.list()).find(r => r.id === request.id); return r?.state === 'succeeded' && r; });
  assert.equal(completed.executionAccount, 'claude:second');
  const run = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').at(-1));
  assert.equal(run.cwd, fs.realpathSync(cwd));
  assert.equal(run.claudeHome, target);
  assert.equal(run.argv[run.argv.indexOf('--resume') + 1], transcript);
  assert.deepEqual(run.authOverrides, []);
  for (const [file, contents] of snapshot) assert.deepEqual(fs.readFileSync(file), contents);
});

test('a queued handoff keeps its target identity and blocks after a profile login changes', async () => {
  const store = await newStore('dispatch-queue');
  const d = dispatcherFor(store);
  const request = await d.submit({ cardId: session.id, prompt: 'queued continuation', when: 'queue', claudeHome: homeId });
  assert.equal(request.claudeHome, homeId);
  assert.equal(request.executionAccount, 'claude:second');
  const before = fs.readFileSync(log, 'utf8');
  identity(target, 'different-account');
  await d.tick();
  const blocked = (await d.requests.list()).find(r => r.id === request.id);
  assert.equal(blocked.state, 'blocked');
  assert.match(blocked.error, /アカウントが変わりました/);
  assert.equal(fs.readFileSync(log, 'utf8'), before);
  identity(target, 'second');
});

test('saved execution survives a new Store and implicit dispatch; changed identity fails closed', async () => {
  const { resolveSession } = await import('../server/dispatch.mjs');
  identity(target, 'second');
  const store = await newStore('persistent-choice');
  await store.setClaudeExecution({ cardId: session.id, execution: { homeId, account: 'claude:second' } });
  const reopened = new Store(store.dir);
  assert.equal((await resolveSession(reopened, session.id)).session.executionAccount, 'claude:second');
  const request = await dispatcherFor(reopened).submit({ cardId: session.id, prompt: 'use persisted selection', when: 'queue' });
  assert.equal(request.claudeHome, homeId);
  await reopened.setClaudeExecution({ cardId: session.id, execution: null });
  assert.equal((await resolveSession(reopened, session.id, request.claudeHome)).session.executionAccount, 'claude:second');
  await reopened.setClaudeExecution({ cardId: session.id, execution: { homeId, account: 'claude:second' } });
  identity(target, 'different-account');
  await assert.rejects(resolveSession(reopened, session.id), /アカウントが変わりました/);
  identity(target, 'second');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { publishTaskContexts, readTaskContext, taskContextScope } from '../server/task-context-cache.mjs';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-task-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = { settings: { accounts: { discover: false, codexHomes: [], claudeHomes: [], profiles: [] } }, remoteHosts: {}, cards: { 'task:a': { kind: 'task', links: ['codex:a', 'claude:missing'] } } };
  const sessions = [{ id: 'codex:a', agent: 'codex', title: '仕事の会話', status: 'running', statusKnown: true, lastSaid: '返答の原文\n二行目', updatedAt: 100, sourcePath: '/secret/transcript', auth: 'SECRET', launch: 'NEVER' }];
  return { dir, state, sessions };
}
test('published task-only excerpts are shared across processes, bounded, private and do not mutate original data', t => {
  const { dir, state, sessions } = setup(t), before = JSON.stringify({ state, sessions });
  assert.equal(publishTaskContexts(dir, state, sessions, { now: 1000 }), true);
  const result = readTaskContext(dir, state, 'task:a', { now: 1100 });
  assert.equal(result.coverage.state, 'fresh');
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.missingCount, 1);
  const observed = result.sessions.find(session => session.id === 'codex:a'), missing = result.sessions.find(session => session.id === 'claude:missing');
  assert.equal(observed.lastAssistant.text, '返答の原文\n二行目');
  assert.equal(observed.lastAssistant.at, null);
  assert.equal(missing.statusKnown, false);
  assert.equal(missing.status, null);
  assert.equal(result.sessions[0].source, 'board-snapshot');
  assert.equal(result.coverage.observedAt, 1000);
  assert.equal(JSON.stringify({ state, sessions }), before);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|NEVER|transcript/);
  const files = fs.readdirSync(path.join(dir, 'cache', 'task-context'));
  const file = path.join(dir, 'cache', 'task-context', files.find(name => name.endsWith('.json')));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {readTaskContext} from './server/task-context-cache.mjs'; console.log(JSON.stringify(readTaskContext(process.argv[1],JSON.parse(process.argv[2]),'task:a',{now:1100})));`, dir, JSON.stringify(state)], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), result);
});
test('missing, stale, clock anomalies and changed link/account/home/remote scopes are explicit', t => {
  const { dir, state, sessions } = setup(t);
  assert.equal(readTaskContext(dir, state, 'task:a', { now: 1000 }).coverage.state, 'unavailable');
  publishTaskContexts(dir, state, sessions, { now: 1000 });
  assert.equal(readTaskContext(dir, state, 'task:a', { now: 1000 + 300000 }).coverage.state, 'stale');
  assert.equal(readTaskContext(dir, state, 'task:a', { now: 999 }).coverage.state, 'unavailable');
  for (const mutate of [s => s.cards['task:a'].links.push('codex:new'), s => s.settings.accounts.codexHomes.push('/new/home'), s => s.settings.accounts.profiles.push({ id: 'new', key: 'codex:other', dir: '/new/profile' }), s => s.remoteHosts.host = { enabled: true }]) {
    const changed = structuredClone(state); mutate(changed);
    assert.equal(readTaskContext(dir, changed, 'task:a', { now: 1100 }).coverage.state, 'unavailable');
  }
  const env = { ...process.env, CANBAN_CODEX_HOME: '/new/environment/home' };
  assert.notEqual(taskContextScope(dir, state), taskContextScope(dir, state, { env }));
});
test('publisher/read errors and oversized payloads fail closed without throwing; concurrent snapshots remain atomic', async t => {
  const { dir, state, sessions } = setup(t);
  const blocked = path.join(dir, 'file'); fs.writeFileSync(blocked, 'x');
  assert.equal(publishTaskContexts(blocked, state, sessions), false);
  assert.equal(readTaskContext(blocked, state, 'task:a').coverage.state, 'unavailable');
  sessions[0].lastSaid = 'x'.repeat(1000000);
  publishTaskContexts(dir, state, sessions, { now: 2000 });
  const limited = readTaskContext(dir, state, 'task:a', { now: 2100 });
  assert.ok(JSON.stringify(limited).length < 6000);
  assert.equal(limited.sessions.find(session => session.id === 'codex:a').lastAssistant.truncated, true);
  publishTaskContexts(dir, state, [{ ...sessions[0], title: 'older' }], { now: 1000 });
  assert.equal(readTaskContext(dir, state, 'task:a', { now: 2100 }).sessions.find(session => session.id === 'codex:a').title, '仕事の会話');
  const file = path.join(dir, 'cache', 'task-context', fs.readdirSync(path.join(dir, 'cache', 'task-context')).find(name => name.endsWith('.json')));
  fs.writeFileSync(file, '{broken');
  assert.equal(readTaskContext(dir, state, 'task:a').coverage.state, 'unavailable');
  fs.writeFileSync(file, 'x'.repeat(200000));
  assert.equal(readTaskContext(dir, state, 'task:a').coverage.state, 'unavailable');
});

test('cache directories and files cannot redirect reads or writes through symlinks', t => {
  const { dir, state, sessions } = setup(t);
  const outside = path.join(dir, 'outside'); fs.mkdirSync(outside);
  const protectedFile = path.join(outside, 'protected'); fs.writeFileSync(protectedFile, 'private original', { mode: 0o600 });
  fs.symlinkSync(outside, path.join(dir, 'cache'));
  assert.equal(publishTaskContexts(dir, state, sessions), false);
  assert.equal(readTaskContext(dir, state, 'task:a').coverage.state, 'unavailable');
  fs.unlinkSync(path.join(dir, 'cache'));
  publishTaskContexts(dir, state, sessions, { now: 1000 });
  const cache = path.join(dir, 'cache', 'task-context');
  const file = path.join(cache, fs.readdirSync(cache).find(name => name.endsWith('.json')));
  fs.unlinkSync(file); fs.symlinkSync(protectedFile, file);
  assert.equal(publishTaskContexts(dir, state, sessions, { now: 2000 }), false);
  assert.equal(readTaskContext(dir, state, 'task:a').coverage.state, 'unavailable');
  assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'private original');
});

test('parallel processes cannot overwrite a newer snapshot with an older observation or publish partial JSON', async t => {
  const { dir, state, sessions } = setup(t);
  publishTaskContexts(dir, state, sessions, { now: 1000 });
  const jobs = Array.from({ length: 6 }, (_, i) => new Promise((resolve, reject) => {
    const at = 2000 + i;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import {publishTaskContexts} from './server/task-context-cache.mjs'; console.log(JSON.stringify({at:${at},saved:publishTaskContexts(process.argv[1],JSON.parse(process.argv[2]),JSON.parse(process.argv[3]),{now:${at}})}));`, dir, JSON.stringify(state), JSON.stringify(sessions)], { cwd: path.resolve(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { error += data; });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(Error(error)));
  }));
  const outcomes = await Promise.all(jobs);
  const result = readTaskContext(dir, state, 'task:a', { now: 3000 });
  assert.equal(result.coverage.state, 'fresh');
  assert.equal(result.coverage.observedAt, Math.max(1000, ...outcomes.filter(outcome => outcome.saved).map(outcome => outcome.at)));
  assert.equal(fs.readdirSync(path.join(dir, 'cache', 'task-context')).some(name => /\.tmp$|\.lock$/.test(name)), false);
});

test('source root symlink and identity changes invalidate scope; transcript/SQLite updates do not', t => {
  const { dir, state } = setup(t);
  const first = path.join(dir, 'first'), second = path.join(dir, 'second'), link = path.join(dir, 'source');
  fs.mkdirSync(first); fs.mkdirSync(second); fs.symlinkSync(first, link);
  const env = { ...process.env, CANBAN_CODEX_HOME: link };
  const before = taskContextScope(dir, state, { env });
  fs.writeFileSync(path.join(first, 'state_5.sqlite'), 'new state');
  fs.writeFileSync(path.join(first, 'transcript.jsonl'), 'new text');
  assert.equal(taskContextScope(dir, state, { env }), before);
  fs.writeFileSync(path.join(first, 'auth.json'), 'identity changed');
  assert.notEqual(taskContextScope(dir, state, { env }), before);
  fs.unlinkSync(link); fs.symlinkSync(second, link);
  assert.notEqual(taskContextScope(dir, state, { env }), before);
});

test('remote identity changes invalidate scope while unrelated Codex UI state does not', t => {
  const { dir, state } = setup(t);
  const root = path.join(dir, 'codex'); fs.mkdirSync(root);
  const file = path.join(root, '.codex-global-state.json'), env = { ...process.env, CANBAN_CODEX_HOME: root };
  fs.writeFileSync(file, JSON.stringify({ 'pinned-thread-ids': [] }));
  const before = taskContextScope(dir, state, { env });
  fs.writeFileSync(file, JSON.stringify({ 'pinned-thread-ids': ['new-ui-state'] }));
  assert.equal(taskContextScope(dir, state, { env }), before);
  fs.writeFileSync(file, JSON.stringify({ 'codex-managed-remote-connections': [{ hostId: 'remote', alias: 'changed-host' }] }));
  assert.notEqual(taskContextScope(dir, state, { env }), before);
});

test('observed additional source homes remain scoped without exposing paths in get_task context', t => {
  const { dir, state, sessions } = setup(t);
  const profile = path.join(dir, 'discovered-profile'); fs.mkdirSync(profile);
  sessions[0].homeDir = profile;
  publishTaskContexts(dir, state, sessions, { now: 1000 });
  const read = readTaskContext(dir, state, 'task:a', { now: 1100 });
  assert.equal(read.coverage.state, 'fresh');
  assert.doesNotMatch(JSON.stringify(read), /discovered-profile/);
  fs.writeFileSync(path.join(profile, 'auth.json'), 'changed identity');
  assert.equal(readTaskContext(dir, state, 'task:a', { now: 1100 }).coverage.state, 'unavailable');
});

test('large link sets return at most fifty bounded summaries with explicit omitted counts', t => {
  const { dir, state } = setup(t);
  const sessions = Array.from({ length: 70 }, (_, i) => ({ id: `codex:${i}`, agent: 'codex', title: 't'.repeat(20000), status: 'running', lastSaid: 'reply'.repeat(10000) }));
  state.cards['task:a'].links = sessions.map(session => session.id);
  assert.equal(publishTaskContexts(dir, state, sessions, { now: 1000 }), true);
  const result = readTaskContext(dir, state, 'task:a', { now: 1100 });
  assert.equal(result.sessions.length, 50);
  assert.equal(result.coverage.linkedCount, 70);
  assert.equal(result.coverage.truncated, true);
  assert.equal(result.coverage.complete, false);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 100000);
  assert.equal(result.sessions[0].titleTruncated, true);
});

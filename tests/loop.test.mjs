import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { RequestStore } from '../server/requests.mjs';
import { loopProgress, loopPrompt } from '../server/loop.mjs';
import { loopArtifact } from '../server/loop-artifact.mjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
const setup = async t => {
  const base = path.resolve('.local/loop-tests'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'run-')), store = new Store(dir);
  t.after(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const taskId = (await store.createTask({ title: '安定した認証', description: '既存の説明' })).cardId;
  const run = async (command, extra = {}) => store.loopCommand({ taskId, expectedRevision: (await store.getLoop({ taskId })).revision, commandId: crypto.randomUUID(), command, source: 'human', ...extra });
  const configured = await run({ type: 'configure', goal: '認証を直す', criteria: ['認証テスト', '回帰テスト'], maxRounds: 5 });
  const cycleId = configured.cycleId;
  const start = async id => run({ type: 'start', cycleId: id || cycleId, nextAction: '失敗した条件を修正' });
  const record = async (passes, extra = {}, id = cycleId) => {
    const c = (await store.getLoop({ taskId })).cycles.find(c => c.id === id), last = c.rounds.at(-1);
    return run({ type: 'record', cycleId: id, roundId: last.id, version: c.version, artifactRef: '成果物v2',
      results: c.criteria.map((x, i) => ({ criterionId: x.id, pass: passes[i], summary: 'テストの観測', ref: passes[i] === null ? '' : '.local/test.log' })), learning: '検証を先に準備' }, extra);
  };
  return { dir, store, taskId, cycleId, run, start, record };
};
test('loop observations persist separately and never rewrite card attributes or finished history', async t => {
  const { store, taskId, cycleId, start, record, run } = await setup(t);
  const before = (await store.load()).cards[taskId];
  await start(); await record([true, false]);
  assert.deepEqual((await store.load()).cards[taskId], before);
  const first = (await store.getLoop({ taskId })).cycles[0].rounds[0];
  await run({ type: 'configure', cycleId, goal: '認証と更新', criteria: ['新しい基準'] });
  const c = (await store.getLoop({ taskId })).cycles[0];
  assert.deepEqual(c.rounds[0], first); assert.equal(c.version, 2); assert.equal(c.definitions[0].criteria[0].text, '認証テスト');
  assert.equal(loopProgress(c), null);
});
test('stale revisions conflict and replaying a command cannot add another round', async t => {
  const { store, taskId, cycleId } = await setup(t);
  const args = { taskId, expectedRevision: 1, commandId: 'stable-command', command: { type: 'start', cycleId, nextAction: '修正する' } };
  const [a, b] = await Promise.all([store.loopCommand(args), store.loopCommand(args)]);
  assert.equal(a.saved, true); assert.equal(b.duplicate, true);
  assert.equal((await store.getLoop({ taskId })).cycles[0].rounds.length, 1);
  const conflict = await store.loopCommand({ ...args, commandId: 'other-command' }); assert.equal(conflict.conflict, true);
  await assert.rejects(store.loopCommand({ ...args, command: { type: 'pause', cycleId } }), /別の操作/);
});
test('an agent report cannot complete work; confirmation must refer to the same artifact', async t => {
  const { store, taskId, cycleId, start, record, run } = await setup(t);
  await start(); await record([true, true], { source: 'reported' });
  let c = (await store.getLoop({ taskId })).cycles[0]; assert.notEqual(c.status, 'completed'); assert.equal(loopProgress(c), null);
  await assert.rejects(run({ type: 'confirm', cycleId, roundId: c.rounds[0].id, artifactRef: '別の成果物' }), /成果物/);
  await assert.rejects(run({ type: 'confirm', cycleId, roundId: c.rounds[0].id, artifactRef: '成果物v2' }, { source: 'reported' }), /成果物/);
  await run({ type: 'confirm', cycleId, roundId: c.rounds[0].id, artifactRef: '成果物v2' });
  c = (await store.getLoop({ taskId })).cycles[0]; assert.equal(c.status, 'completed'); assert.equal(loopProgress(c), 1);
});
test('unknown observations remain unresolved; missing evidence and mismatched versions are rejected', async t => {
  const { store, taskId, cycleId, start, record, run } = await setup(t);
  await start(); const c = (await store.getLoop({ taskId })).cycles[0], r = c.rounds[0];
  await assert.rejects(run({ type: 'record', cycleId, roundId: r.id, version: 99, artifactRef: 'v1', results: [] }), /基準/);
  await assert.rejects(run({ type: 'record', cycleId, roundId: r.id, version: 1, artifactRef: 'v1', results: [{ criterionId: 'c1', pass: true, summary: '通った', ref: '' }, { criterionId: 'c2', pass: null, summary: '未実行' }] }), /根拠/);
  await record([true, null]); const result = (await store.getLoop({ taskId })).cycles[0];
  assert.equal(result.status, 'review'); assert.equal(loopProgress(result), .5);
  await start(); assert.equal(loopProgress((await store.getLoop({ taskId })).cycles[0]), null);
});
test('children block parent completion, and reopening a child invalidates the parent', async t => {
  const { store, taskId, cycleId, run, start, record } = await setup(t);
  const child = (await run({ type: 'configure', parentId: cycleId, goal: '小さな修正', criteria: ['型検査'] })).cycleId;
  await assert.rejects(run({ type: 'configure', parentId: child, goal: '3段目', criteria: ['条件'] }), /親/);
  await start(); await record([true, true]); assert.notEqual((await store.getLoop({ taskId })).cycles[0].status, 'completed');
  await start(child); await record([true], {}, child);
  await start(); await record([true, true]); assert.equal((await store.getLoop({ taskId })).cycles[0].status, 'completed');
  await run({ type: 'configure', cycleId: child, goal: '再調整', criteria: ['新しい型検査'] });
  assert.equal((await store.getLoop({ taskId })).cycles[0].status, 'review');
  assert.equal(loopProgress((await store.getLoop({ taskId })).cycles[0]), null);
});
test('confirming a parent observation made before child completion cannot complete the parent', async t => {
  const { store, taskId, cycleId, run, start, record } = await setup(t);
  const child = (await run({ type: 'configure', parentId: cycleId, goal: '小さな修正', criteria: ['型検査'] })).cycleId;
  await start(); await record([true, true], { source: 'reported' });
  const round = (await store.getLoop({ taskId })).cycles[0].rounds[0];
  await start(child); await record([true], {}, child);
  await run({ type: 'confirm', cycleId, roundId: round.id, artifactRef: round.artifactRef });
  const parent = (await store.getLoop({ taskId })).cycles[0];
  assert.notEqual(parent.status, 'completed'); assert.equal(loopProgress(parent), null);
  await start(); await record([true, true]);
  assert.equal((await store.getLoop({ taskId })).cycles[0].status, 'completed');
});
test('human confirmation preserves a repetition stop and is idempotent for that round', async t => {
  const { store, taskId, cycleId, run, start, record } = await setup(t);
  await start(); await record([false, false], { source: 'reported' });
  await start(); await record([false, false], { source: 'reported' });
  const last = (await store.getLoop({ taskId })).cycles[0].rounds.at(-1);
  for (let i = 0; i < 2; i++) await run({ type: 'confirm', cycleId, roundId: last.id, artifactRef: last.artifactRef });
  const c = (await store.getLoop({ taskId })).cycles[0];
  assert.equal(c.status, 'paused'); assert.match(c.reason, /2周/); assert.equal(c.confirmations.length, 1);
});
test('the next instruction includes previous observations and stays inside the dispatch limit', async t => {
  const { store, taskId, cycleId, start, record, run } = await setup(t);
  await start(); await record([true, false]); await start();
  let c = (await store.getLoop({ taskId })).cycles[0];
  assert.match(loopPrompt(taskId, c), /直近の観測/); assert.match(loopPrompt(taskId, c), /c2: 未達/);
  await run({ type: 'pause', cycleId });
  await run({ type: 'configure', cycleId, goal: 'x'.repeat(500), principles: 'x'.repeat(4000), criteria: Array(20).fill('x'.repeat(500)) });
  await start(); c = (await store.getLoop({ taskId })).cycles[0];
  c.nextAction = 'x'.repeat(4000);
  assert.ok(loopPrompt(taskId, c).length <= 20000);
});
test('repeated failures and round limits stop iteration without deleting observations', async t => {
  const { store, taskId, start, record, run, cycleId } = await setup(t);
  await start(); await record([false, false]); await start(); await record([false, false]);
  let c = (await store.getLoop({ taskId })).cycles[0]; assert.equal(c.status, 'paused'); assert.match(c.reason, /2周/);
  await assert.rejects(start(), /停止中/);
  await run({ type: 'configure', cycleId, goal: '新方針', criteria: ['テスト'], maxRounds: 1 });
  await start(); await record([false]); c = (await store.getLoop({ taskId })).cycles[0];
  assert.equal(c.status, 'paused'); assert.equal(c.rounds.length, 3);
});
test('request creation atomically binds one round once and rejects stale or unlinked sessions', async t => {
  const { dir, store, taskId, cycleId, start } = await setup(t);
  await store.linkSession({ taskId, sessionId: 'codex:one' }); await start();
  const record = await store.getLoop({ taskId });
  const requests = new RequestStore(dir), fields = { cardId: 'codex:one', agent: 'codex', prompt: '修正を検証する',
    loopContext: { taskId, cycleId, roundId: record.cycles[0].rounds[0].id, expectedRevision: record.revision } };
  await assert.rejects(requests.create({ ...fields, cardId: 'codex:unlinked' }), /紐付け/);
  await assert.rejects(requests.create({ ...fields, loopContext: { ...fields.loopContext, expectedRevision: 0 } }), /周回/);
  const [a, b] = await Promise.all([requests.create(fields), requests.create(fields)]);
  assert.equal(a.id, b.id); assert.equal((await requests.list({ cardId: 'codex:one' })).length, 1);
});
test('queued loop requests are cancelled at claim time after pause, observation, reconfiguration or unlink', async t => {
  for (const change of ['pause', 'record', 'configure', 'unlink']) {
    const { dir, store, taskId, cycleId, start, run, record } = await setup(t);
    await store.linkSession({ taskId, sessionId: 'codex:one' }); await start();
    const loop = await store.getLoop({ taskId }), requests = new RequestStore(dir);
    const req = await requests.create({ cardId: 'codex:one', agent: 'codex', hostId: 'local', prompt: '検証する', loopContext: { taskId, cycleId, roundId: loop.cycles[0].rounds[0].id, expectedRevision: loop.revision } });
    if (change === 'record') await record([true, false]);
    else if (change === 'unlink') await store.unlinkSession({ taskId, sessionId: 'codex:one' });
    else { await run({ type: 'pause', cycleId }); if (change === 'configure') await run({ type: 'configure', cycleId, goal: '新しい方針', criteria: ['新しい検証'] }); }
    assert.equal((await requests.claim(req.id)).reasonCode, 'loop_changed', change);
    assert.equal((await requests.get(req.id)).state, 'cancelled');
  }
});
test('a local artifact fingerprint changes after HEAD, tracked content or untracked content changes', async t => {
  const { dir } = await setup(t); const cwd = path.join(dir, 'artifact'); fs.mkdirSync(cwd);
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'fixture');
  fs.writeFileSync(path.join(cwd, 'file'), 'original'); git('add', '.'); git('commit', '-qm', 'fixture');
  const initial = await loopArtifact(cwd); assert.match(initial, /^git:/);
  fs.writeFileSync(path.join(cwd, 'file'), 'changed'); const changed = await loopArtifact(cwd); assert.notEqual(changed, initial);
  fs.writeFileSync(path.join(cwd, 'extra'), 'one'); const untracked = await loopArtifact(cwd); assert.notEqual(changed, untracked);
  fs.writeFileSync(path.join(cwd, 'extra'), 'two'); assert.notEqual(await loopArtifact(cwd), untracked);
  fs.mkdirSync(path.join(cwd, 'subdir')); assert.equal(await loopArtifact(path.join(cwd, 'subdir')), await loopArtifact(cwd));
  git('add', '.'); git('commit', '-qm', 'second'); const committed = await loopArtifact(cwd); assert.notEqual(committed, initial);
  git('commit', '--allow-empty', '-qm', 'head-only'); assert.notEqual(await loopArtifact(cwd), committed);
});

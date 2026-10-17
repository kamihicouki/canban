// Source readers: normalization on fixtures, and the read-only guarantee.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { listCodexSessions, codexSessionMessages } from '../server/sources/codex.mjs';
import { listClaudeSessions, claudeSessionMessages, newSummary, foldSummary, normalizeClaudeSummary } from '../server/sources/claude.mjs';
import { resumeCommand, headlessArgs } from '../server/agents.mjs';
import { queryReadOnly } from '../server/sources/readonly.mjs';

import { makeFixtures } from './helpers.mjs';

const fx = makeFixtures();
const { codexHome, claudeHome, desktopDir } = fx;
const before = fx.snapshot();
fx.lock(); // any write attempt now fails at the OS level
after(() => fx.cleanup());

test('Claude resume follows the latest main conversation worktree, preserving the session ID', () => {
  const summary = newSummary('same-session');
  const worktree = '/repo/.claude/worktrees/card-ux';
  for (const record of [
    { type: 'user', cwd: '/repo', gitBranch: 'main', message: { content: 'カードを改善して' } },
    { type: 'assistant', cwd: '/repo/prototypes/card-ux', gitBranch: 'main' },
    { type: 'assistant', cwd: worktree, gitBranch: 'worktree-card-ux' },
    { type: 'assistant', isSidechain: true, cwd: '/other-agent', gitBranch: 'other-agent' },
    { type: 'assistant', cwd: '  ', gitBranch: {} },
    { type: 'assistant', cwd: 42 },
  ]) foldSummary(summary, record);
  const session = normalizeClaudeSummary(summary, { cwd: '/repo' });
  assert.equal(session.cwd, worktree);
  assert.equal(session.branch, 'worktree-card-ux');
  assert.equal(session.nativeId, 'same-session');
  const command = resumeCommand(session);
  assert.ok(command.startsWith(`cd ${worktree} 2>/dev/null`), command);
  assert.deepEqual(headlessArgs(session, { mode: 'default' }).args.slice(0, 3), ['-p', '--resume', 'same-session']);
});

test('codex sessions are normalized from the state DB', async () => {
  const { sessions, error } = await listCodexSessions({ home: codexHome });
  assert.equal(error, null);
  const t1 = sessions.find((s) => s.nativeId === 't1');
  assert.equal(t1.id, 'codex:t1');
  assert.equal(t1.title, 'ログイン修正');
  assert.equal(t1.project, 'demo-app');
  assert.equal(t1.branch, 'fix/login');
  assert.equal(t1.updatedAt, 1790000100123);
  assert.equal(t1.subagent, false);
  assert.equal(sessions.find((s) => s.nativeId === 't2').subagent, true);
  const t3 = sessions.find((s) => s.nativeId === 't3');
  assert.equal(t3.archived, true);
  assert.equal(t3.updatedAt, 1790000000000);
});

test('codex messages skip commentary', async () => {
  const msgs = await codexSessionMessages(path.join(codexHome, 'sessions', 'rollout-a.jsonl'));
  assert.deepEqual(msgs.map((m) => [m.role, m.text]), [['user', 'ログインを直して'], ['assistant', '直しました']]);
});

test('claude sessions merge transcript and desktop metadata', async () => {
  const { sessions, error } = await listClaudeSessions({ home: claudeHome, desktopDir });
  assert.equal(error, null);
  assert.equal(sessions.length, 2);
  const c = sessions.find((x) => x.nativeId === 'c1');
  assert.equal(c.id, 'claude:c1');
  assert.equal(c.title, 'トップページ高速化');
  assert.equal(c.project, 'web');
  assert.equal(c.archived, true);
  assert.equal(c.updatedAt, 1790500000000);
  assert.equal(c.prUrl, 'https://github.com/o/r/pull/1');
  const msgs = await claudeSessionMessages(c.sourcePath);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant']);
});

test('read-only DB connection rejects writes', () => {
  assert.throws(() => queryReadOnly(path.join(codexHome, 'state_5.sqlite'), (db) => db.exec("UPDATE threads SET title='x'")));
});

test('fixtures are byte-for-byte unchanged after reading', () => {
  assert.deepEqual(fx.snapshot(), before);
});

// Real data: readers must not call any fs write API while scanning the user's sessions.
test('readers issue no writes against real session data', async () => {
  const calls = [];
  const spy = (obj, name) => {
    const orig = obj[name];
    obj[name] = function (...a) {
      calls.push(`${name}(${String(a[0])})`);
      return orig.apply(this, a);
    };
    return () => (obj[name] = orig);
  };
  const restores = [
    ...['writeFile', 'appendFile', 'rename', 'unlink', 'rm', 'truncate', 'mkdir', 'copyFile'].map((n) => spy(fsp, n)),
    ...['writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'truncateSync', 'mkdirSync', 'copyFileSync', 'createWriteStream'].map((n) => spy(fs, n)),
  ];
  const origOpen = fsp.open;
  fsp.open = function (p, flags = 'r', ...rest) {
    if (flags !== 'r') calls.push(`open(${p}, ${flags})`);
    return origOpen.call(this, p, flags, ...rest);
  };
  try {
    const codex = await listCodexSessions();
    const claude = await listClaudeSessions();
    const s1 = codex.sessions.find((s) => s.sourcePath);
    if (s1) await codexSessionMessages(s1.sourcePath);
    const s2 = claude.sessions[0];
    if (s2) await claudeSessionMessages(s2.sourcePath);
  } finally {
    restores.forEach((r) => r());
    fsp.open = origOpen;
  }
  assert.deepEqual(calls, []);
});

test('Claude sessions without desktop metadata are not claimed to be unarchived', async () => {
  const { normalizeClaudeSummary, newSummary } = await import('../server/sources/claude.mjs');
  const sum = { ...newSummary('x'), prompts: ['hi'], turns: 1, entrypoint: 'cli' };
  const s = normalizeClaudeSummary(sum, undefined);
  assert.deepEqual([s.desktopKnown, s.archived, s.entrypoint], [false, false, 'cli']);
  assert.equal(normalizeClaudeSummary(sum, { isArchived: true }).desktopKnown, true);
});

test('Claude groups keep actual account/org scope and never become named environments', async () => {
  const { sessionSourceView } = await import('../server/source-model.mjs');
  const summary = { ...newSummary('source-test'), prompts: ['hello'], turns: 1 };
  const session = normalizeClaudeSummary(summary, { _account: 'owner-a', _org: 'org-a', _sourceScope: '/desktop', _observedAt: 1000, group: { id: 'g1', name: 'dev' } });
  const source = sessionSourceView(session);
  assert.equal(source.attributes.claudeGroup.value.ref.scopeId, '["/desktop","owner-a","org-a"]');
  assert.equal(source.attributes.claudeGroup.value.ref.nativeId, 'g1');
  assert.equal(source.attributes.claudeEnvironment.status, 'unknown');
  const namelessId = normalizeClaudeSummary(summary, { _account: 'owner-a', _org: 'org-a', _sourceScope: '/desktop', group: 'dev' });
  assert.equal(sessionSourceView(namelessId).attributes.claudeGroup.status, 'unknown');
});

test('launch target metadata exposes scoped multi-root references and excludes secret values', async () => {
  const os = await import('node:os');
  const { claudeEnvironments, codexLaunchTargets } = await import('../server/sources/launch-targets.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-source-targets-'));
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'a' }));
    fs.writeFileSync(path.join(root, 'ccd-session-presets.json'), JSON.stringify({ byAccount: { a: { presets: [{ id: 'e', name: 'dev', target: { kind: 'local', cwd: '/one', additionalFolders: ['/two'], folderSettings: { '/two': { branch: 'topic', worktree: true } }, envVars: { API_KEY: 'secret-value' } } }] } } }));
    const { environments } = await claudeEnvironments(root);
    assert.equal(environments[0].sourceRef.scopeId, JSON.stringify([fs.realpathSync(root), 'a']));
    assert.deepEqual(environments[0].workingLocations.map(l => l.folder), ['/one', '/two']);
    assert.equal(environments[0].workingLocations[1].branchRequested, 'topic');
    assert.equal(environments[0].settingsPresence.environmentVariables, 'unknown');
    assert.ok(!JSON.stringify(environments).includes('secret-value'));
    fs.writeFileSync(path.join(root, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { p: { name: 'dev', rootPaths: ['/one', '/two'] } } }));
    const codex = await codexLaunchTargets({ home: root });
    assert.equal(codex.projects[0].sourceRef.scopeId, fs.realpathSync(root));
    assert.deepEqual(codex.projects[0].roots, ['/one', '/two']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an unreadable selected-account preset catalog is unknown rather than an empty known catalog', async () => {
  const os = await import('node:os');
  const { claudeEnvironments } = await import('../server/sources/launch-targets.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-source-missing-presets-'));
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'a' }));
    fs.writeFileSync(path.join(root, 'ccd-session-presets.json'), JSON.stringify({ byAccount: { other: { presets: [] } } }));
    const missing = await claudeEnvironments(root);
    assert.equal(missing.sourceObservation.status, 'unknown');
    assert.deepEqual(missing.environments, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('unknown Claude grouping does not borrow the desktop file timestamp', () => {
  const summary = { ...newSummary('unknown-group'), prompts: ['hello'], turns: 1 };
  const session = normalizeClaudeSummary(summary, { _observedAt: 9000 });
  assert.equal(session.sourceMetadata.claudeGroup.status, 'unknown');
  assert.equal(session.sourceMetadata.claudeGroup.observedAt, null);
});

test('guest or conflicting group namespaces remain unknown despite a known session owner', async () => {
  const { sessionSourceView } = await import('../server/source-model.mjs');
  const summary = { ...newSummary('guest-group'), prompts: ['hello'], turns: 1 };
  for (const patch of [{ _groupOwnerKnown: false }, { _groupConflict: true }]) {
    const s = normalizeClaudeSummary(summary, { _account: 'original', _org: 'original-org', _sourceScope: '/desktop', group: { id: 'g', name: 'host-only' }, ...patch });
    assert.equal(sessionSourceView(s).attributes.claudeGroup.status, 'unknown');
    assert.equal(sessionSourceView(s).attributes.claudeGroup.value, null);
  }
});

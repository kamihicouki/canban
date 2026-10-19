import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceKey, sessionSourceView } from '../server/source-model.mjs';

const ref = { provider: 'codex', identityDomain: 'app-storage', scopeId: '/profile/a', kind: 'project', nativeId: 'p:1' };
const metadata = (extra = {}) => ({ ref, name: 'same', product: 'Codex', surface: 'desktop', status: 'known', observedAt: 1000, source: 'codex-app', ...extra });

test('source identity is scoped and insensitive to renames and viewing surface', () => {
  assert.equal(sourceKey(ref), '[1,"codex","app-storage","/profile/a","project","p:1"]');
  assert.equal(sourceKey({ ...ref, name: 'renamed', surface: 'cli' }), sourceKey(ref));
  for (const field of ['provider', 'identityDomain', 'scopeId', 'kind', 'nativeId']) {
    assert.equal(sourceKey({ ...ref, [field]: null }), null);
    assert.notEqual(sourceKey({ ...ref, [field]: `${ref[field]}:other` }), sourceKey(ref));
  }
});

test('explicit native membership wins over cwd and exact catalog identity supplies a rename', () => {
  const session = { id: 'codex:t', agent: 'codex', cwd: '/same', project: 'same', sourceMetadata: { codexProject: metadata() } };
  const view = sessionSourceView(session, { entities: [{ ref: { ...ref, scopeId: '/other' }, name: 'wrong' }, { ref, name: 'renamed', product: 'Codex', surface: 'desktop' }] });
  assert.equal(view.attributes.codexProject.value.name, 'renamed');
  assert.equal(view.relations[0].type, 'memberOf');
  assert.equal(view.relations[0].ref.nativeId, 'p:1');
  assert.equal(view.workingLocations.value[0].folder, '/same');
  assert.equal(session.sourceMetadata.codexProject.name, 'same');
});

test('unknown scope, empty observation, unavailable source and stale values remain distinct', () => {
  const view = sessionSourceView({ agent: 'codex', sourceMetadata: {
    codexProject: metadata({ ref: { ...ref, scopeId: null } }),
    codexSection: { status: 'absent', source: 'db', observedAt: 1000 },
    claudeGroup: { status: 'unavailable', reason: '接続できません', source: 'desktop', observedAt: 1000 },
    claudeEnvironment: metadata({ ref: { ...ref, provider: 'claude', kind: 'environment' }, status: 'stale' }),
  } });
  assert.equal(view.attributes.codexProject.status, 'unknown');
  assert.equal(view.attributes.codexProject.value, null);
  assert.equal(view.attributes.codexSection.status, 'absent');
  assert.equal(view.attributes.claudeGroup.status, 'unavailable');
  assert.equal(view.attributes.claudeEnvironment.status, 'unknown');
  assert.equal(view.attributes.claudeEnvironment.observedAt, null);
  assert.deepEqual(view.relations, [], 'a catalog or stale environment does not prove a launch');
});

test('folder/name matches never invent memberships or confirmed launch settings', () => {
  const view = sessionSourceView({ id: 'claude:c', agent: 'claude', project: 'same', cwd: '/same', claudeGroup: { id: 'same', name: 'same' } }, { entities: [{ ref, name: 'same', roots: ['/same'] }] }, [
    { sessionId: 'other', status: 'confirmed', appliedRefs: [ref] },
    { sessionId: 'claude:c', status: 'requested', selectedRefs: [ref] },
  ]);
  assert.equal(view.attributes.claudeGroup.status, 'unknown');
  assert.equal(view.attributes.claudeEnvironment.status, 'unknown');
  assert.deepEqual(view.relations, []);
});

test('multiple observed folders and branch/worktree details survive without copying secrets', () => {
  const view = sessionSourceView({ agent: 'claude', workingLocations: [
    { folder: '/one', primary: true, branch: 'main', envVars: { TOKEN: 'secret' } },
    { folder: '/two', primary: false, worktree: '/two', repository: '/repo' },
  ], sourceMetadata: { claudeGroup: metadata({ ref: { ...ref, provider: 'claude', kind: 'group' }, secret: 'secret' }) } });
  assert.deepEqual(view.workingLocations.value.map(l => l.folder), ['/one', '/two']);
  assert.equal(view.workingLocations.value[1].worktree, '/two');
  assert.ok(!JSON.stringify(view).includes('secret'));
});

test('confirmed receipts attach only exact session IDs and preserve requested/applied distinction', () => {
  const environment = { ...ref, provider: 'claude', kind: 'environment' };
  const view = sessionSourceView({ id: 'claude:c', agent: 'claude' }, { entities: [{ ref: environment, name: 'dev', product: 'Claude Code', surface: 'desktop' }] }, [
    { requestId: 'r1', sessionId: 'claude:c', status: 'confirmed', selectedRefs: [environment], appliedRefs: [environment], observedAt: 1000 },
  ]);
  assert.deepEqual(view.relations.map(r => r.type), ['requestedWith', 'startedWith']);
  assert.equal(view.attributes.claudeEnvironment.value.name, 'dev');
  assert.equal(view.workingLocations.status, 'unknown');
});

test('board cards compact the same source view as full details without replacing legacy fields', async () => {
  const { expandSourceView } = await import('../server/source-model.mjs');
  const { expandCapabilities } = await import('../server/source-capabilities.mjs');
  const { makeFixtures } = await import('./helpers.mjs');
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const fx = makeFixtures();
  try {
    fs.writeFileSync(path.join(fx.codexHome, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { p: { name: 'native', rootPaths: ['/one', '/two'] } }, 'thread-project-assignments': { t1: { projectId: 'p' } } }));
    const output = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
      const { Store } = await import('./server/store.mjs');
      const { buildBoard, sessionDetail } = await import('./server/board.mjs');
      const store = new Store(process.env.CANBAN_DATA_DIR);
      const board = await buildBoard(store);
      const card = board.lists.flatMap(l => l.cards).find(c => c.id === 'codex:t1');
      const detail = await sessionDetail(store, 'codex:t1');
      console.log(JSON.stringify({ card, session: detail.session }));
      process.exit(0);
    `], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, CANBAN_DATA_DIR: path.join(fx.root, 'store'), CANBAN_CODEX_HOME: fx.codexHome, CANBAN_CLAUDE_HOME: fx.claudeHome, CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir }, encoding: 'utf8', timeout: 30000 });
    const { card, session } = JSON.parse(output);
    assert.equal(card.id, 'codex:t1');
    assert.equal(card.project, 'native');
    assert.equal(card.codexProject.id, 'p');
    assert.equal(card.sourceView.attributes.codexProject.value.ref.nativeId, 'p');
    assert.deepEqual(expandSourceView(card.sourceView), session.sourceView);
    assert.equal(session.capabilities.archive.operation, 'archive');
    assert.equal(expandCapabilities(card.capabilities).sendPrompt.status, 'unknown');
  } finally { fx.cleanup(); }
});

test('cloud locations never invent a local folder or machine from a logical cloud host', () => {
  const cloud = { agent: 'codex', sourceKind: 'codex-cloud', cwd: '/local-looking-cache', host: { id: 'codex-cloud', cloud: true, local: false } };
  assert.equal(sessionSourceView(cloud).workingLocations.status, 'unknown');
  const explicit = sessionSourceView({ ...cloud, workingLocations: [{ repository: 'cloud-repo', primary: true }] });
  assert.equal(explicit.workingLocations.value[0].folder, null);
  assert.equal(explicit.workingLocations.value[0].machineId, null);
  assert.equal(explicit.workingLocations.value[0].executionTarget, 'cloud');
});

test('acquisition time is separate from source update time and execution targets use one vocabulary', () => {
  const view = sessionSourceView({ updatedAt: 1000, sourceObservedAt: 9000, host: { local: false }, cwd: '/remote' });
  assert.equal(view.workingLocations.observedAt, 9000);
  assert.equal(view.workingLocations.sourceUpdatedAt, 1000);
  assert.equal(view.workingLocations.value[0].executionTarget, 'ssh');
  const invalid = sessionSourceView({ workingLocations: [{ executionTarget: 'invented', folder: '/x' }] });
  assert.equal(invalid.workingLocations.value[0].executionTarget, null);
});

test('environment entities preserve requested branch/worktree separately from actual session facts', () => {
  const env = { ...ref, provider: 'claude', kind: 'environment' };
  const view = sessionSourceView({ id: 'claude:env' }, { entities: [{ ref: env, workingLocations: [{ folder: '/two', branchRequested: 'topic', worktreeRequested: true }] }] }, [{ sessionId: 'claude:env', status: 'confirmed', selectedRefs: [env] }]);
  const location = view.relations[0].observation.value.workingLocations[0];
  assert.equal(location.branchRequested, 'topic');
  assert.equal(location.worktreeRequested, true);
  assert.equal(location.branch, null);
  assert.equal(location.worktree, null);
});

test('compact board source views round-trip unknown, absent, stale and receipt relations', async () => {
  const { compactSourceView, expandSourceView } = await import('../server/source-model.mjs');
  const env = { ...ref, provider: 'claude', kind: 'environment' };
  const full = sessionSourceView({ id: 'claude:c', sourceMetadata: { codexProject: metadata({ status: 'stale' }), codexSection: { status: 'absent', source: 'db' }, claudeGroup: { status: 'unavailable', source: 'desktop', reason: 'offline' } } }, {}, [{ sessionId: 'claude:c', status: 'confirmed', selectedRefs: [env], appliedRefs: [env] }]);
  const wire = compactSourceView(full);
  assert.equal(wire.compact, true);
  assert.deepEqual(expandSourceView(JSON.parse(JSON.stringify(wire))), full);
  assert.deepEqual(expandSourceView(full), full);
  const empty = compactSourceView(sessionSourceView({}));
  assert.deepEqual(empty.attributes, {});
  assert.equal(expandSourceView(empty).attributes.codexProject.status, 'unknown');
  assert.ok(JSON.stringify(wire).length < JSON.stringify(full).length);
});

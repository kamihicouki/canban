import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFilters, matchesTask } from '../server/board.mjs';
import { effectiveTaskContext } from '../server/task-context.mjs';
import { sourceRelationsForTask, sourceFacetsForCards } from '../server/source-filters.mjs';

export const ref = (scopeId = '/home/a', nativeId = 'p1') => ({ provider: 'codex', identityDomain: 'app-storage', scopeId, kind: 'project', nativeId });
export const session = (id, scopeId = '/home/a', nativeId = 'p1') => ({ id, agent: 'codex', project: 'Same', folder: 'repo', cwd: '/repo', codexProject: { id: nativeId, name: 'Same' }, sourceMetadata: { codexProject: { status: 'known', ref: ref(scopeId, nativeId), name: 'Same', source: 'fixture', observedAt: 100 } } });

test('source filters preserve scoped identity and reject malformed references', () => {
  const sourceFilters = [{ ref: ref(), relation: 'memberOf' }];
  assert.deepEqual(normalizeFilters({ sourceFilters }).sourceFilters, sourceFilters);
  assert.throws(() => normalizeFilters({ sourceFilters: [{ ref: { ...ref(), scopeId: '' } }] }), /出典/);
});

test('task source filter sees every link, without name or scope collision', () => {
  const links = [session('codex:a'), session('codex:b', '/home/b')];
  const f = r => normalizeFilters({ sourceFilters: [{ ref: r }] });
  assert.equal(matchesTask({}, links, 'idle', f(ref()), new Map(), null), true);
  assert.equal(matchesTask({}, links, 'idle', f(ref('/home/b')), new Map(), null), true);
  assert.equal(matchesTask({}, links, 'idle', f(ref('/home/c')), new Map(), null), false);
});

test('legacy context never synthesizes a project/account tuple across multiple links', () => {
  const links = [{ project: 'A', agent: 'codex', host: { id: 'one' } }, { project: 'B', account: 'claude:two', agent: 'claude', host: { id: 'two' } }];
  const context = effectiveTaskContext({}, links);
  assert.equal(context.project, null);
  assert.equal(context.account, null);
  assert.equal(context.host, null);
  assert.equal(effectiveTaskContext({ context: { project: 'Manual', account: null } }, links).project, 'Manual');
});

test('source and legacy conditions stay AND filters when observations differ', () => {
  const links = [session('codex:a')];
  assert.equal(matchesTask({}, links, 'idle', normalizeFilters({ project: 'Other', sourceFilters: [{ ref: ref() }] }), new Map(), null), false);
  assert.equal(matchesTask({}, links, 'idle', normalizeFilters({ folder: '/elsewhere', sourceFilters: [{ ref: ref() }] }), new Map(), null), false);
});

test('task relation set retains all link observations; source facets count one task once', () => {
  const links = [session('codex:a'), session('codex:b'), session('codex:c', '/home/b')];
  const sourceRelations = sourceRelationsForTask(links);
  assert.equal(sourceRelations.length, 2);
  assert.deepEqual(sourceRelations[0].sessions.map(s => s.sessionId), ['codex:a', 'codex:b']);
  assert.deepEqual(sourceFacetsForCards([{ sourceRelations }]).map(f => f.count), [1, 1]);
});

test('AND filters and full folder path preserve old search meaning', () => {
  const links = [session('codex:a'), session('codex:b', '/home/b')];
  const f = normalizeFilters({ sourceFilters: [{ ref: ref() }, { ref: ref('/home/b') }], folder: '/repo' });
  assert.equal(matchesTask({}, links, 'idle', f, new Map(), null), true);
  assert.equal(matchesTask({}, links, 'idle', { ...f, sourceFilters: [...f.sourceFilters, { ref: ref('/missing') }] }, new Map(), null), false);
});

test('planned context alone matches a source; planned and observed count one task', () => {
  const task = { sourceContext: [{ ref: ref() }] };
  const f = normalizeFilters({ sourceFilters: [{ ref: ref() }] });
  assert.equal(matchesTask(task, [], 'idle', f, new Map(), null), true);
  assert.equal(matchesTask(task, [], 'idle', normalizeFilters({ sourceFilters: [{ ref: ref(), relation: 'memberOf' }] }), new Map(), null), false);
  const facets = sourceFacetsForCards([{ ...task, sourceRelations: sourceRelationsForTask([session('codex:a')]) }]);
  assert.equal(facets.length, 1);
  assert.equal(facets[0].count, 1);
  assert.deepEqual(facets[0].origins.sort(), ['observed', 'planned']);
});

test('board source facets use the final filtered cards and card kind', async () => {
  const { makeFixtures } = await import('./helpers.mjs');
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs'); const path = await import('node:path');
  const fx = makeFixtures();
  try {
    fs.writeFileSync(path.join(fx.codexHome, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { p: { name: 'native', rootPaths: ['/one'] } }, 'thread-project-assignments': { t1: { projectId: 'p' }, t2: { projectId: 'p' } } }));
    const output = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
      const { Store } = await import('./server/store.mjs');
      const { buildBoard } = await import('./server/board.mjs');
      const { storageScope } = await import('./server/source-model.mjs');
      const store = new Store(process.env.CANBAN_DATA_DIR);
      const ref = { provider: 'codex', identityDomain: 'app-storage', scopeId: storageScope(process.env.CANBAN_CODEX_HOME), kind: 'project', nativeId: 'p' };
      const dir = await store.createDirectory({ name: 'Manual' });
      const task = await store.createTask({ title: 'fixture task', directory: dir.id, sourceContext: [{ ref }] });
      await store.linkSession({ taskId: task.cardId, sessionId: 'codex:t1' });
      await store.linkSession({ taskId: task.cardId, sessionId: 'codex:t2' });
      const filter = { sourceFilters: [{ ref }], days: 0 };
      const included = await buildBoard(store, { ...filter, directory: dir.id });
      const excluded = await buildBoard(store, { ...filter, directory: '__none' });
      const sessionsOnly = await buildBoard(store, { ...filter, cardKind: 'session' });
      const mixedUnmatched = await buildBoard(store, { ...filter, folder: '/unmatched' });
      console.log(JSON.stringify([included, excluded, sessionsOnly, mixedUnmatched].map(b => ({ facets: b.sourceFacets, count: b.totals.shown }))));
      process.exit(0);
    `], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, CANBAN_DATA_DIR: path.join(fx.root, 'store'), CANBAN_CODEX_HOME: fx.codexHome, CANBAN_CLAUDE_HOME: fx.claudeHome, CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir }, encoding: 'utf8', timeout: 30000 });
    const [included, excluded, sessionsOnly, mixedUnmatched] = JSON.parse(output);
    assert.equal(included.count, 1);
    assert.equal(included.facets[0].count, 1);
    assert.equal(excluded.count, 0); assert.deepEqual(excluded.facets, []);
    assert.equal(sessionsOnly.count, 0); assert.deepEqual(sessionsOnly.facets, []);
    assert.equal(mixedUnmatched.count, 0); assert.deepEqual(mixedUnmatched.facets, []);
  } finally { fx.cleanup(); }
});

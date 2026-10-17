import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, normalize, resolveDirectory } from '../server/store.mjs';
import { migrateSourceData, resolveCategory } from '../server/category-bindings.mjs';
import { sourceKey, sessionSourceView } from '../server/source-model.mjs';
import * as mapping from '../server/category-bindings.mjs';

const ref = scopeId => ({ provider: 'codex', identityDomain: 'app-storage', scopeId, kind: 'project', nativeId: 'p1' });
const session = (id, scopeId) => ({ id, agent: 'codex', cwd: '/work', codexProject: { id: 'p1', name: 'Old' }, ...(scopeId ? { sourceMetadata: { codexProject: { status: 'known', ref: ref(scopeId), name: 'Old', source: 'fixture' } } } : {}) });
const oldKey = JSON.stringify(['codex', 'local', 'group', 'p1']);
const fixture = () => normalize({ directories: [{ id: 'kept', name: '手動名', color: 'blue', paths: [], sourceKeys: [oldKey] }], cards: { 'codex:a': { directoryId: '__none', draft: 'keep' } } });

test('dry-run keeps ambiguous existing classification without spreading to a new scope', () => {
  const original = fixture(), before = structuredClone(original);
  const sessions = [session('codex:a', '/home/a'), session('codex:b', '/home/b')];
  const { state, report } = migrateSourceData(original, sessions);
  assert.deepEqual(original, before);
  assert.equal(report.ambiguous, 1);
  assert.equal(state.categoryMapping.bindings.length, 0);
  assert.equal(resolveDirectory(state, state.cards['codex:a'], null, sessions[0]), null);
  assert.equal(resolveDirectory(state, null, null, sessions[1]).id, 'kept');
  assert.equal(resolveDirectory(state, null, null, session('codex:new', '/home/c')), null);
  assert.deepEqual(migrateSourceData(state, sessions).state, state);
  assert.equal(state.directories[0].name, '手動名');
  assert.equal(state.directories[0].color, 'blue');
  assert.deepEqual(state.directories[0].sourceKeys, [oldKey]);
});

test('unique scoped binding survives rename; deletion suppression migrates independently', () => {
  const s = session('codex:b', '/home/a');
  const { state, report } = migrateSourceData(fixture(), [s]);
  assert.equal(report.unique, 1);
  assert.equal(state.categoryMapping.bindings[0].ref.scopeId, '/home/a');
  assert.equal(resolveDirectory(state, null, null, { ...s, codexProject: { id: 'p1', name: 'New' } }).id, 'kept');
  const input = fixture(); input.settings.ignoredCategorySources = [oldKey];
  const suppressed = migrateSourceData(input, [s]);
  assert.equal(suppressed.report.suppressed, 1);
  assert.equal(suppressed.state.categoryMapping.bindings.length, 0);
  assert.equal(suppressed.state.categoryMapping.tombstones.length, 1);
  assert.equal(resolveDirectory(suppressed.state, null, null, s), null);
});

test('unknown scope/name-only legacy remains on snapshot cards and cannot become a binding', () => {
  const s = session('codex:b');
  const { state, report } = migrateSourceData(fixture(), [s]);
  assert.equal(report.unresolved, 1);
  assert.equal(resolveDirectory(state, null, null, s).id, 'kept');
  assert.equal(resolveDirectory(state, null, null, { ...s, id: 'codex:new' }), null);
  const nameOnly = { ...session('codex:c', '/home/a'), codexProject: { name: 'Old' } };
  const input = fixture(); input.directories[0].sourceKeys = [JSON.stringify(['codex', 'local', 'group', 'Old'])];
  assert.equal(migrateSourceData(input, [nameOnly]).state.categoryMapping.bindings.length, 0);
});

test('explicit folder rules keep matching future sessions and conflict is distinct from none', () => {
  const input = fixture(); input.directories[0].paths = ['/full/repo'];
  const { state } = migrateSourceData(input, []);
  assert.equal(resolveDirectory(state, null, '/full/repo/sub', { ...session('codex:new'), cwd: '/full/repo/sub' }).id, 'kept');
  const sourceView = sessionSourceView(session('codex:b', '/home/a'));
  assert.deepEqual(resolveCategory({ sourceView, bindings: [{ categoryId: 'one', ref: ref('/home/a'), relation: 'memberOf' }, { categoryId: 'two', ref: ref('/home/a'), relation: 'memberOf' }] }), { status: 'conflict', categoryId: null, categoryIds: ['one', 'two'] });
  assert.equal(sourceKey(ref('/home/a')), sourceView.relations[0].key);
  const bindings = [{ categoryId: 'one', ref: ref('/home/a'), relation: 'memberOf' }, { categoryId: 'two', ref: ref('/home/a'), relation: 'memberOf' }];
  assert.equal(resolveCategory({ sourceView, bindings, legacy: { sessionId: 'old', cards: { old: { categoryId: 'kept' } } } }).categoryId, 'kept');
  assert.deepEqual(mapping.categoryBindingConflicts(bindings)[0].categoryIds, ['one', 'two']);
});

test('requested environment is not a classification result without startedWith receipt', () => {
  const env = { provider: 'claude', identityDomain: 'preset-account', scopeId: 'account-one', kind: 'environment', nativeId: 'env' };
  const view = sessionSourceView({ id: 'claude:one' }, {}, [{ sessionId: 'claude:one', status: 'confirmed', selectedRefs: [env] }]);
  assert.equal(resolveCategory({ sourceView: view, bindings: [{ categoryId: 'kept', ref: env, relation: 'requestedWith' }] }).categoryId, null);
});

test('binding edits before first board cannot finalize an empty legacy snapshot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-early-binding-')), store = new Store(root);
  try {
    await store.save(fixture());
    await store.updateDirectory({ directoryId: 'kept', sourceBindings: [{ ref: ref('/home/new'), relation: 'memberOf' }] });
    await store.syncSessionCategories([session('codex:old')]);
    const state = await store.load();
    assert.equal(resolveDirectory(state, null, null, session('codex:old')).id, 'kept');
    assert.equal(state.categoryMapping.bindings[0].ref.scopeId, '/home/new');
  } finally { await store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('newly observed legacy source names never auto-create or attach a category', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-source-'));
  const store = new Store(root);
  try {
    await store.createDirectory({ name: 'Same', color: 'blue' });
    await store.syncSessionCategories([{ id: 'codex:new', agent: 'codex', codexProject: { id: 'new', name: 'Same' } }]);
    const state = await store.load();
    assert.equal(state.directories[0].sourceKeys?.length || 0, 0);
    assert.equal(resolveDirectory(state, null, null, { id: 'codex:new', agent: 'codex', codexProject: { id: 'new', name: 'Same' } }), null);
  } finally { await store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('mapping payload survives normalization alongside old categories, views and drafts', () => {
  const categoryMapping = { version: 1, bindings: [], tombstones: [], legacyCards: {} };
  const state = normalize({ categoryMapping, cards: { 'codex:old': { directoryId: '__none', draft: 'keep' } }, settings: { views: [{ id: 'v', name: 'Old', filters: { folder: '/full/repo' } }] } });
  assert.deepEqual(state.categoryMapping, categoryMapping);
  assert.equal(state.cards['codex:old'].draft, 'keep');
  assert.equal(state.settings.views[0].filters.folder, '/full/repo');
});

test('explicit source bindings can be edited without changing legacy keys, and removal is suppressed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-binding-')), store = new Store(root);
  try {
    await store.save(migrateSourceData(fixture(), [session('codex:b', '/home/a')]).state);
    const sourceBindings = [{ ref: ref('/home/other'), relation: 'memberOf' }];
    await store.updateDirectory({ directoryId: 'kept', sourceBindings });
    let state = await store.load();
    assert.equal(state.categoryMapping.bindings.length, 1);
    assert.equal(state.categoryMapping.bindings[0].ref.scopeId, '/home/other');
    assert.deepEqual(state.directories[0].sourceKeys, [oldKey]);
    assert.equal(resolveDirectory(state, null, null, session('codex:b', '/home/a')), null);
    assert.equal(resolveDirectory(state, null, null, session('codex:new', '/home/other')).id, 'kept');
    await store.deleteDirectory({ directoryId: 'kept' });
    state = await store.load();
    assert.equal(state.categoryMapping.bindings.length, 0);
    assert.ok(state.categoryMapping.tombstones.some(b => b.ref.scopeId === '/home/other'));
  } finally { await store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('saved views convert only uniquely scoped native conditions and retain original filters', () => {
  const input = fixture();
  input.settings.views = [{ id: 'unique', name: 'Native', filters: { project: 'Old', days: 7 } }, { id: 'folder', name: 'Folder', filters: { folder: 'work' } }];
  const s = { ...session('codex:b', '/home/a'), project: 'Old', folder: 'work' };
  const { state, report } = migrateSourceData(input, [s]);
  assert.deepEqual(state.settings.views[0].filters, { days: 7, sourceFilters: [{ ref: ref('/home/a'), relation: 'memberOf' }] });
  assert.deepEqual(state.settings.views[0].sourceMigration.legacyFilters, { project: 'Old', days: 7 });
  assert.equal(normalize(state).settings.views[0].sourceMigration.version, 1);
  assert.deepEqual(state.settings.views[1].filters, { folder: 'work' });
  assert.equal(report.viewResolutions[1].outcome, 'unresolved');
  const ambiguous = migrateSourceData(input, [s, { ...s, id: 'codex:c', sourceMetadata: session('codex:c', '/home/b').sourceMetadata }]);
  assert.deepEqual(ambiguous.state.settings.views[0].filters, { project: 'Old', days: 7 });
  assert.equal(ambiguous.report.viewResolutions[0].outcome, 'ambiguous');
});

test('rollback restores legacy view conditions without rewinding new work and holds new-only views', () => {
  assert.equal(typeof mapping.rollbackSourceViews, 'function');
  const input = fixture(); input.settings.views = [{ id: 'old', name: 'Old', filters: { project: 'Old', days: 7 } }];
  const migrated = migrateSourceData(input, [{ ...session('codex:b', '/home/a'), project: 'Old' }]).state;
  migrated.cards['task:new'] = { kind: 'task', title: 'New work', draft: 'keep' };
  migrated.settings.views[0].filters.days = 30;
  migrated.settings.views.push({ id: 'new', name: 'New only', filters: { sourceFilters: [{ ref: ref('/other') }] } });
  const rolled = mapping.rollbackSourceViews(migrated);
  assert.deepEqual(rolled.state.settings.views[0].filters, { project: 'Old', days: 30 });
  assert.equal(rolled.state.cards['task:new'].draft, 'keep');
  assert.equal(rolled.state.settings.views.some(v => v.id === 'new'), false);
  assert.equal(rolled.report.heldViews[0].id, 'new');
  assert.ok(migrated.settings.views[0].filters.sourceFilters, 'input copy remains unchanged');
});

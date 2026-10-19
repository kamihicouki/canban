import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeFixtures } from './helpers.mjs';

function fixtureBoard(script) {
  const fx = makeFixtures();
  try {
    fs.writeFileSync(path.join(fx.codexHome, '.codex-global-state.json'), JSON.stringify({
      'local-projects': { p: { name: 'Native', rootPaths: ['/fixture'] } },
      'thread-project-assignments': { t1: { projectId: 'p' } },
    }));
    return JSON.parse(execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { Store } from './server/store.mjs';
      import { buildBoard } from './server/board.mjs';
      import { storageScope } from './server/source-model.mjs';
      const rawStore = new Store(process.env.CANBAN_DATA_DIR);
      let loadState;
      const store = new Proxy(rawStore, { get(target, key) { return key === 'load' && loadState ? loadState : target[key]; } });
      const ref = { provider: 'codex', identityDomain: 'app-storage', scopeId: storageScope(process.env.CANBAN_CODEX_HOME), kind: 'project', nativeId: 'p' };
      const cards = board => board.lists.flatMap(list => list.cards);
      ${script}
      process.exit(0);
    `], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env,
      CANBAN_DATA_DIR: path.join(fx.root, 'store'), CANBAN_CODEX_HOME: fx.codexHome,
      CANBAN_CLAUDE_HOME: fx.claudeHome, CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir,
      CANBAN_BACKGROUND: '0', CANBAN_SEARCH_INDEX: '0', CANBAN_GH: path.resolve(import.meta.dirname, 'fake-gh.sh'),
      CANBAN_GLAB: path.resolve(import.meta.dirname, 'fake-glab.sh'), FAKE_GH_DATA: '/dev/null',
    }, encoding: 'utf8', timeout: 30000 }));
  } finally { fx.cleanup(); }
}

test('linked source binding classifies the visible task, its category count and category filter', () => {
  const result = fixtureBoard(`
    const native = await store.createDirectory({ name: 'Native category' });
    const manual = await store.createDirectory({ name: 'Manual category' });
    await store.updateDirectory({ directoryId: native.id, sourceBindings: [{ ref, relation: 'memberOf' }] });
    const task = await store.createTask({ title: 'Linked' });
    await store.linkSession({ taskId: task.cardId, sessionId: 'codex:t1' });
    const options = { days: 0, dotScope: 'all' };
    const board = await buildBoard(store, options);
    const filtered = await buildBoard(store, { ...options, directory: native.id });
    const none = await buildBoard(store, { ...options, directory: '__none' });
    const visible = cards(board).find(card => card.id === task.cardId);
    const snapshot = { directory: visible.directory?.id, wanted: native.id,
      filtered: cards(filtered).map(c => c.id), none: cards(none).map(c => c.id), taskId: task.cardId,
      count: board.directories.find(d => d.id === native.id).count,
      standalone: cards(board).some(c => c.id === 'codex:t1'), relations: visible.sourceRelations };
    await store.updateTask({ cardId: task.cardId, directory: manual.id });
    snapshot.manual = cards(await buildBoard(store, options)).find(c => c.id === task.cardId).directory?.id === manual.id;
    await store.updateTask({ cardId: task.cardId, directory: '__none' });
    snapshot.explicitNone = cards(await buildBoard(store, options)).find(c => c.id === task.cardId).directory;
    const suppressed = await store.load();
    delete suppressed.cards[task.cardId].directoryId;
    suppressed.categoryMapping.tombstones.push({ categoryId: native.id, ref, relation: 'memberOf' });
    await store.save(suppressed);
    snapshot.suppressed = cards(await buildBoard(store, options)).find(c => c.id === task.cardId).directory;
    await store.updateDirectory({ directoryId: manual.id, paths: ['/Users/x'] });
    snapshot.pathFallback = cards(await buildBoard(store, options)).find(c => c.id === task.cardId).directory?.id === manual.id;
    console.log(JSON.stringify(snapshot));
  `);
  assert.equal(result.directory, result.wanted);
  assert.equal(result.count, 1);
  assert.deepEqual(result.filtered, [result.taskId]);
  assert.ok(!result.none.includes(result.taskId));
  assert.equal(result.standalone, false);
  assert.equal(result.relations[0].type, 'memberOf');
  assert.equal(result.relations[0].sessions[0].sessionId, 'codex:t1');
  assert.equal(result.manual, true);
  assert.equal(result.explicitNone, null);
  assert.equal(result.suppressed, null);
  assert.equal(result.pathFallback, true);
});

test('board and rule passes index receipt history once per loaded state, preserving exact confirmation', () => {
  const result = fixtureBoard(`
    let reads = 0, loads = 0;
    const load = store.load.bind(store);
    loadState = async () => {
      loads++;
      const state = await load();
      state.cards.history = { launchReceipts: [{ status: 'confirmed', get sessionId() { reads++; return 'missing-session'; } }] };
      return state;
    };
    const environment = { provider: 'claude', identityDomain: 'preset-account', scopeId: 'fixture', kind: 'environment', nativeId: 'env' };
    const state = await load();
    state.cards.receipts = { launchReceipts: [
      { requestId: 'confirmed', sessionId: 'claude:c2', status: 'confirmed', selectedRefs: [environment], appliedRefs: [environment] },
      { requestId: 'unresolved', sessionId: 'claude:c2', status: 'unresolved', selectedRefs: [ref], appliedRefs: [ref] },
      { requestId: 'other', sessionId: 'claude:missing', status: 'confirmed', appliedRefs: [ref] },
    ] };
    await store.save(state);
    const board = await buildBoard(store, { days: 0, dotScope: 'all' });
    const matched = cards(board).find(c => c.id === 'claude:c2');
    const unrelated = cards(board).find(c => c.id === 'codex:t1');
    console.log(JSON.stringify({ reads, loads, relations: matched.sourceView.relations,
      unrelated: unrelated.sourceView.relations }));
  `);
  assert.ok(result.reads > 0);
  assert.ok(result.reads <= result.loads, `${result.reads} receipt scans for ${result.loads} state loads`);
  assert.deepEqual(result.relations.map(r => [r.type, r.requestId]), [['requestedWith', 'confirmed'], ['startedWith', 'confirmed']]);
  assert.ok(!result.unrelated.some(r => r.requestId));
});

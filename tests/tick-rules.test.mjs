import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { makeFixtures } from './helpers.mjs';

test('background tick evaluates enabled rules and pending tasks without board filters', () => {
  const fx = makeFixtures();
  try {
    const output = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
      import { Store } from './server/store.mjs';
      import { tickRules, buildBoard } from './server/board.mjs';
      const store = new Store(process.env.CANBAN_DATA_DIR);
      const state = await store.load();
      state.settings.rules[0].enabled = true;
      state.settings.views = [{ id: 'old', name: 'Old', filters: { project: 'web' } }];
      await store.save(state);
      const task = await store.createTask({ title: 'pending' });
      await store.addPending({ taskId: task.cardId, pending: { agent: 'codex', hostId: 'local', startedAt: Date.now(), prompt: 'future' } });
      const moves = await tickRules(store);
      await buildBoard(store, { days: 0 }); await buildBoard(store, { days: 0 });
      const after = await store.load();
      console.log(JSON.stringify({ moves, mapping: after.categoryMapping || null, views: after.settings.views }));
      process.exit(0);
    `], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, CANBAN_DATA_DIR: path.join(fx.root, 'store'), CANBAN_CODEX_HOME: fx.codexHome, CANBAN_CLAUDE_HOME: fx.claudeHome, CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir }, encoding: 'utf8', timeout: 30000 });
    const result = JSON.parse(output);
    assert.ok(Array.isArray(result.moves));
    assert.equal(result.mapping, null);
    assert.deepEqual(result.views[0].filters, { project: 'web' });
  } finally { fx.cleanup(); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeFixtures } from './helpers.mjs';

test('a task projects its child wait details and activity without changing linked IDs or compact fields', () => {
  const fx = makeFixtures();
  try {
    const stamp = new Date().toISOString();
    fs.writeFileSync(path.join(fx.claudeHome, 'projects', '-r-web', 'c1.jsonl'), [
      { type: 'user', sessionId: 'c1', cwd: '/r/web', gitBranch: 'main', timestamp: stamp, message: { content: '決済を確認する' } },
      { type: 'assistant', timestamp: stamp, message: { content: [{ type: 'text', text: '入力を待っています' }, { type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: { questions: [{ question: 'Luhn 検証を追加しますか？', options: [{ label: '追加する' }, { label: '今はしない' }] }] } }] } },
    ].map(o => JSON.stringify(o)).join('\n') + '\n');
    const output = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
      const { Store } = await import('./server/store.mjs');
      const { buildBoard } = await import('./server/board.mjs');
      const store = new Store(process.env.CANBAN_DATA_DIR);
      const { cardId } = await store.createTask({ title: '決済フォーム' });
      await store.linkSession({ taskId: cardId, sessionId: 'claude:c1' });
      const board = await buildBoard(store, { days: 0, includeArchived: true });
      console.log(JSON.stringify(board.lists.flatMap(l => l.cards).find(c => c.id === cardId)));
      process.exit(0);
    `], {
      cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, CANBAN_DATA_DIR: path.join(fx.root, 'store'), CANBAN_CODEX_HOME: fx.codexHome, CANBAN_CLAUDE_HOME: fx.claudeHome, CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir },
    });
    const card = JSON.parse(output);
    assert.deepEqual(card.linkedSessionIds, ['claude:c1']);
    const child = card.links[0];
    assert.equal(child.cwd, '/r/web');
    assert.equal(child.branch, 'main');
    assert.equal(typeof child.createdAt, 'number');
    assert.equal(child.id, 'claude:c1');
    assert.equal(child.status, 'waiting');
    assert.equal(child.statusKnown, true);
    assert.equal(child.signals.waitText, 'Luhn 検証を追加しますか？');
    assert.deepEqual(child.signals.waitOptions, ['追加する', '今はしない']);
    assert.equal(typeof child.activity, 'string');
    assert.equal(child.signals.files?.paths, undefined);
    assert.equal(child.agent, 'claude');
    assert.equal(typeof child.updatedAt, 'number');
  } finally { fx.cleanup(); }
});

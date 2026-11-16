import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { makeFixtures } from './helpers.mjs';

test('ローカルセッションの元リポジトリと明示カテゴリをボードまで渡し、存在しないパスにも対応する', () => {
  const fx = makeFixtures();
  try {
    const repo = path.join(fx.root, 'pair-match');
    const gitdir = path.join(repo, '.git', 'worktrees', 'feature');
    const worktree = path.join(fx.root, '別の作業場所');
    fs.mkdirSync(gitdir, { recursive: true });
    fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(gitdir, 'HEAD'), 'ref: refs/heads/feature\n');
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitdir}\n`);
    const db = new DatabaseSync(path.join(fx.codexHome, 'state_5.sqlite'));
    db.prepare('UPDATE threads SET cwd = ? WHERE id = ?').run(worktree, 't1');
    db.close();
    const claudeFile = path.join(fx.claudeHome, 'projects', '-r-web', 'c2.jsonl');
    fs.writeFileSync(claudeFile, fs.readFileSync(claudeFile, 'utf8').replace('/r/web', worktree));
    const gemini = path.join(fx.root, 'gemini');
    const chats = path.join(gemini, 'tmp', 'project', 'chats');
    fs.mkdirSync(chats, { recursive: true });
    fs.writeFileSync(path.join(chats, 'session-gem.json'), JSON.stringify({
      sessionId: 'gem', cwd: worktree,
      messages: [{ role: 'user', content: '元リポジトリを確認', timestamp: '2026-11-13T00:00:00Z' }],
    }));
    const result = JSON.parse(execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
      import { Store } from './server/store.mjs';
      import { buildBoard } from './server/board.mjs';
      const store = new Store(process.env.CANBAN_DATA_DIR);
      await store.updateCard({ cardId: 'codex:t1', directory: '__none' });
      const board = await buildBoard(store, { days: 0, includeArchived: true });
      console.log(JSON.stringify(board.lists.flatMap(list => list.cards)));
      await store.close();
      process.exit(0);
    `], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 30000,
      env: { ...process.env, CANBAN_DATA_DIR: path.join(fx.root, 'store'),
        CANBAN_CODEX_HOME: fx.codexHome, CANBAN_CLAUDE_HOME: fx.claudeHome,
        CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir, CANBAN_GEMINI_HOME: gemini,
        CANBAN_ANTIGRAVITY_DIR: path.join(fx.root, 'antigravity'),
        CANBAN_CURSOR_HOME: path.join(fx.root, 'cursor'), CANBAN_CURSOR_WORKSPACE_DIR: path.join(fx.root, 'cursor-workspaces'),
        CANBAN_CHATGPT_DIR: path.join(fx.root, 'chatgpt'), CANBAN_GROK_HOME: path.join(fx.root, 'grok'),
        CANBAN_BACKGROUND: '0', CANBAN_SEARCH_INDEX: '0',
        CANBAN_GH: path.resolve(import.meta.dirname, 'fake-gh.sh'),
        CANBAN_GLAB: path.resolve(import.meta.dirname, 'fake-glab.sh'), FAKE_GH_DATA: '/dev/null',
      } }));
    for (const id of ['codex:t1', 'claude:c2', 'gemini:gem']) {
      const card = result.find(card => card.id === id);
      assert.ok(card, id);
      assert.equal(card.repoRoot, repo, id);
      assert.equal(card.repoName, 'pair-match', id);
      assert.equal(card.worktreeName, 'feature', id);
      assert.equal(card.branch, id === 'codex:t1' ? 'fix/login' : 'feature', id);
      assert.equal(card.directoryId, id === 'codex:t1' ? '__none' : null, id);
    }
    const missing = result.find(card => card.id === 'claude:c1');
    assert.equal(missing.repoRoot, '/r/web');
    assert.equal(missing.repoName, 'web');
    assert.equal(missing.worktreeName, null);
    assert.equal(missing.branch, 'main');
  } finally { fx.cleanup(); }
});

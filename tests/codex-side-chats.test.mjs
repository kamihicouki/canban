// Codex side conversations (threads.attached_thread_parent_id): listed under their parent, not as board cards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { makeFixtures } from './helpers.mjs';
import { listCodexSessions, findCodexSession } from '../server/sources/codex.mjs';
import { staticProblem } from '../server/dispatch.mjs';
import { RemotePool } from '../server/remote/pool.mjs';

const here = import.meta.dirname;

function withSideChat(run) {
  const fx = makeFixtures();
  const db = new DatabaseSync(path.join(fx.codexHome, 'state_5.sqlite'));
  db.exec('ALTER TABLE threads ADD COLUMN attached_thread_parent_id TEXT');
  db.prepare(`INSERT INTO threads (id, rollout_path, created_at, updated_at, updated_at_ms, source, thread_source, cwd, title, name, archived, first_user_message, preview, is_pinned, attached_thread_parent_id)
    VALUES ('side1', '', 1790000000, 1790000000, ?, 'vscode', 'user', ?, '# Selected text:', 'この処理の確認', 0, '# Selected text:', '', 0, 't1')`).run(Date.now(), here);
  db.close();
  return Promise.resolve(run(fx)).finally(() => fx.cleanup());
}

test('a side conversation is a child of its parent but keeps its own kind', () => withSideChat(async (fx) => {
  const { sessions, error } = await listCodexSessions({ home: fx.codexHome });
  assert.equal(error, null);
  const side = sessions.find((s) => s.nativeId === 'side1');
  assert.equal(side.subagent, true);
  assert.equal(side.sideChat, true);
  assert.equal(side.parentId, 'codex:t1');
  assert.deepEqual(sessions.find((s) => s.nativeId === 't1').children, ['codex:side1']);
  assert.equal(sessions.find((s) => s.nativeId === 't2').sideChat, false);
}));

test('a follow-up can still be sent to a side conversation, but not to a sub-agent', () => withSideChat(async (fx) => {
  const side = await findCodexSession('side1', { home: fx.codexHome });
  assert.equal(staticProblem({ ...side, host: { local: true } }), null);
  const sub = await findCodexSession('t2', { home: fx.codexHome });
  assert.match(staticProblem({ ...sub, cwd: here, host: { local: true } }), /サブエージェント/);
}));

test('a schema without the column keeps working', async () => {
  const fx = makeFixtures();
  try {
    const { sessions, error } = await listCodexSessions({ home: fx.codexHome });
    assert.equal(error, null);
    assert.equal(sessions.find((s) => s.nativeId === 't1').sideChat, false);
  } finally { fx.cleanup(); }
});

test('collect.py links a side conversation like the local reader', () => withSideChat(async (fx) => {
  const pool = new RemotePool({ ssh: path.join(here, 'fake-ssh.sh'), extraArgs: { codexHome: fx.codexHome, claudeHome: fx.claudeHome, desktopDir: fx.desktopDir } });
  const host = { id: 'remote-ssh-discovered:fx', alias: 'fx', label: 'fx', local: false, sshArgs: [] };
  const remote = await pool.sessions([host]);
  const side = remote.find((s) => s.nativeId === 'side1');
  assert.equal(side.sideChat, true);
  assert.equal(side.parentId, 'codex@fx:t1');
  assert.deepEqual(remote.find((s) => s.nativeId === 't1').children, ['codex@fx:side1']);
}));

test('the board shows the parent with a count and the detail lists the side conversation', () => withSideChat((fx) => {
  const out = JSON.parse(execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
    import { Store } from './server/store.mjs';
    import { buildBoard, sessionDetail } from './server/board.mjs';
    const store = new Store(process.env.CANBAN_DATA_DIR);
    const cards = (b) => b.lists.flatMap((l) => l.cards);
    const board = await buildBoard(store, { days: 0 });
    const shown = await buildBoard(store, { days: 0, includeSubagents: true });
    const detail = await sessionDetail(store, 'codex:t1');
    process.stdout.write(JSON.stringify({
      ids: cards(board).map((c) => c.id), shown: cards(shown).map((c) => c.id),
      parent: cards(board).find((c) => c.id === 'codex:t1'), children: detail.children,
    }));
    process.exit(0);
  `], { cwd: path.resolve(here, '..'), encoding: 'utf8', env: { ...process.env,
    CANBAN_DATA_DIR: path.join(fx.root, 'store'), CANBAN_CODEX_HOME: fx.codexHome,
    CANBAN_CLAUDE_HOME: fx.claudeHome, CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir,
    CANBAN_BACKGROUND: '0', CANBAN_SEARCH_INDEX: '0', CANBAN_GH: path.join(here, 'fake-gh.sh'),
    CANBAN_GLAB: path.join(here, 'fake-glab.sh'), FAKE_GH_DATA: '/dev/null' }, timeout: 30000 }));
  assert.ok(!out.ids.includes('codex:side1'));
  assert.ok(out.shown.includes('codex:side1'));
  assert.deepEqual(out.parent.sideChats, { total: 1, running: 0 });
  assert.equal(out.parent.subagents, null);
  assert.equal(out.children.length, 1);
  assert.equal(out.children[0].sideChat, true);
}));

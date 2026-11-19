import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import { buildBoard, sessionDetail, sessionSideChat } from '../server/board.mjs';
import { findCodexSession, listCodexSessions } from '../server/sources/codex.mjs';
import { Store } from '../server/store.mjs';
import { configureAccounts } from '../server/accounts.mjs';
import { makeFixtures } from './helpers.mjs';

const at = '2026-11-19T00:00:00Z';
const record = (type, payload) => ({ timestamp: at, type, payload });
const message = (role, text, phase) => record('response_item', {
  type: 'message', role, phase, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
});
const boundary = message('user', 'Side conversation boundary.\n\nEverything before this boundary is inherited history from the parent thread.');
const writeRollout = (filepath, records) => {
  const content = records.map(x => JSON.stringify(x)).join('\n') + '\n';
  if (zlib.zstdCompressSync) fs.writeFileSync(filepath + '.zst', zlib.zstdCompressSync(content));
  else fs.writeFileSync(filepath, content);
};

test('保存されたCodexサイド会話は親の詳細だけに現れ、引き継いだ履歴を返さない', async (t) => {
  const fixture = makeFixtures();
  t.after(() => fixture.cleanup());
  for (const [key, value] of Object.entries({
    CANBAN_CODEX_HOME: fixture.codexHome, CANBAN_CLAUDE_HOME: fixture.claudeHome,
    CANBAN_CLAUDE_DESKTOP_DIR: fixture.desktopDir,
    ...Object.fromEntries(['ANTIGRAVITY_DIR', 'GEMINI_HOME', 'CURSOR_HOME', 'CURSOR_WORKSPACE_DIR', 'CHATGPT_DIR', 'GROK_HOME']
      .map(key => ['CANBAN_' + key, path.join(fixture.root, 'empty')])),
  })) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    process.env[key] = value;
  }
  const side = path.join(fixture.codexHome, 'sessions', 'side.jsonl');
  const unknown = path.join(fixture.codexHome, 'sessions', 'unknown.jsonl');
  writeRollout(side, [
    record('session_meta', { id: 'side', attached_thread: true }),
    message('user', '親から引き継いだ質問'), boundary,
    message('user', '<environment_context>自動追加</environment_context>'),
    message('user', 'サイド会話でだけ聞いた質問'),
    message('assistant', '確認中', 'commentary'),
    message('assistant', 'サイド会話でだけ見える回答', 'final_answer'),
  ]);
  writeRollout(unknown, [record('session_meta', { id: 'unknown', attached_thread: true }), message('user', '境界未確認の質問')]);
  const db = new DatabaseSync(path.join(fixture.codexHome, 'state_5.sqlite'));
  db.exec('ALTER TABLE threads ADD COLUMN attached_thread_parent_id TEXT');
  const insert = db.prepare('INSERT INTO threads (id,rollout_path,title,updated_at,archived,thread_source,attached_thread_parent_id) VALUES (?,?,?,1795000000,1,\'user\',?)');
  insert.run('side', side, '保存済みサイド会話', 't1');
  insert.run('orphan', '', '親がないサイド会話', 'missing');
  insert.run('unknown', unknown, '境界未確認', 't1');
  db.close();
  const store = new Store(path.join(fixture.root, 'data'));
  const board = await buildBoard(store, { includeSubagents: true, includeArchived: true, days: 0 }, { readOnly: true, includeLinkedSessions: true });
  const ids = board.lists.flatMap(list => list.cards.map(card => card.id));
  assert.ok(ids.includes('codex:t1'));
  for (const id of ['side', 'orphan', 'unknown']) {
    assert.ok(!ids.includes('codex:' + id), 'attached sessions never become independent cards');
  }
  const parent = await sessionDetail(store, 'codex:t1');
  assert.deepEqual(parent.sideChats.map(chat => chat.id).sort(), ['codex:side', 'codex:unknown']);
  assert.equal(parent.sideChats.find(chat => chat.id === 'codex:side').sourcePath, undefined);
  assert.equal(await findCodexSession('side', { home: fixture.codexHome }), null);
  await assert.rejects(sessionDetail(store, 'codex:side'), /見つかりません/);
  await assert.rejects(sessionSideChat(store, 'codex:t2', 'codex:side'), /見つかりません/);
  await assert.rejects(sessionSideChat(store, 'codex:t1', 'codex:unknown'), /境界/);
  const snapshot = fixture.snapshot();
  assert.deepEqual(await sessionSideChat(store, 'codex:t1', 'codex:side'), {
    messages: [
      { role: 'user', text: 'サイド会話でだけ聞いた質問', at },
      { role: 'assistant', text: 'サイド会話でだけ見える回答', at },
    ],
    truncated: false,
  });
  assert.deepEqual(fixture.snapshot(), snapshot);
});

test('別のCodex設定フォルダーの添付関係を古いコピーより優先する', async (t) => {
  const fixture = makeFixtures();
  const previous = process.env.CANBAN_CODEX_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.CANBAN_CODEX_HOME;
    else process.env.CANBAN_CODEX_HOME = previous;
    configureAccounts({});
    fixture.cleanup();
  });
  process.env.CANBAN_CODEX_HOME = fixture.codexHome;
  const second = path.join(fixture.root, 'codex-secondary');
  fs.mkdirSync(second);
  const primaryDb = new DatabaseSync(path.join(fixture.codexHome, 'state_5.sqlite'));
  primaryDb.exec("INSERT INTO threads (id, title, updated_at) VALUES ('side-copy', '古いコピー', 1795000000)");
  primaryDb.close();
  const secondaryDb = new DatabaseSync(path.join(second, 'state_5.sqlite'));
  secondaryDb.exec(`
    CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, updated_at INTEGER, attached_thread_parent_id TEXT);
    INSERT INTO threads VALUES ('t1', '親のコピー', 1795000001, NULL);
    INSERT INTO threads VALUES ('side-copy', '保存済みの子', 1795000000, 't1');
  `);
  secondaryDb.close();
  configureAccounts({ codexHomes: [second], discover: false });
  const { sessions, error } = await listCodexSessions();
  assert.equal(error, null);
  assert.ok(sessions.every(x => x.nativeId !== 'side-copy'));
  const parent = sessions.find(x => x.nativeId === 't1');
  assert.equal(parent.title, 'ログイン修正');
  assert.deepEqual(parent.sideChats.map(chat => chat.title), ['保存済みの子']);
  assert.equal(await findCodexSession('side-copy'), null);
  assert.deepEqual((await findCodexSession('t1')).sideChats, parent.sideChats);
});

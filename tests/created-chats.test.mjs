import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import {
  extractCreatedChatParent,
  parseCreatedParentFromHistoryItem,
  readCreatedParentFromRolloutHead,
  resolveCreatedChatParents,
  attachCreatedChatEdges,
  resetCreatedChatCache,
} from '../server/sources/codex-created-chats.mjs';
import { listCodexSessions } from '../server/sources/codex.mjs';
import { Store } from '../server/store.mjs';
import { buildBoard, sessionDetail } from '../server/board.mjs';

const modelSource = () => fs.readFileSync(new URL('../ui/created-chats-model.js', import.meta.url), 'utf8');
const uiModel = () => vm.runInNewContext(`${modelSource()}\n({ CREATED_FAMILY_TONES, createdFamilyTone, createdFamilyIdOf, createdChatsSummaryText, groupListWithCreatedChats })`);

const envelope = (sourceId, input = '調査して') => `<codex_delegation>\n<source_thread_id>${sourceId}</source_thread_id>\n<input>${input}</input>\n</codex_delegation>`;

test('extractCreatedChatParent は完全な codex_delegation 封筒のみを許容し、引用・壊れたタグ・自己参照を拒否する', () => {
  assert.equal(extractCreatedChatParent(envelope('p-1'), 'c-1'), 'p-1');
  assert.equal(extractCreatedChatParent(envelope('a &lt; b &amp; c'), 'c-1'), 'a < b & c');
  assert.equal(extractCreatedChatParent(`引用: ${envelope('p-1')}`, 'c-1'), null);
  assert.equal(extractCreatedChatParent('<codex_delegation><source_thread_id>p-1</source_thread_id></codex_delegation>', 'c-1'), null);
  assert.equal(extractCreatedChatParent(envelope('c-1'), 'c-1'), null);
  assert.equal(extractCreatedChatParent(envelope('x'.repeat(161)), 'c-1'), null);
});

test('parseCreatedParentFromHistoryItem は create_thread の functionCallOutput と userMessage を扱う', () => {
  const fco = JSON.stringify({ type: 'functionCallOutput', namespace: 'codex_app', name: 'create_thread', output: envelope('parent-a') });
  const otherTool = JSON.stringify({ type: 'functionCallOutput', namespace: 'other_ns', name: 'create_thread', output: envelope('parent-a') });
  const um = JSON.stringify({ type: 'userMessage', content: [{ type: 'text', text: envelope('parent-b') }] });
  assert.equal(parseCreatedParentFromHistoryItem(fco, 'child-1'), 'parent-a');
  assert.equal(parseCreatedParentFromHistoryItem(otherTool, 'child-1'), null);
  assert.equal(parseCreatedParentFromHistoryItem(um, 'child-1'), 'parent-b');
  assert.equal(parseCreatedParentFromHistoryItem('not-json', 'child-1'), null);
});

test('resolveCreatedChatParents は thread_history と rollout 先頭フォールバックの両方から親を解決し、サブエージェントとは独立を保つ', async () => {
  resetCreatedChatCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-created-'));
  try {
    const codexHome = path.join(root, 'codex');
    fs.mkdirSync(codexHome, { recursive: true });
    const rolloutChild2 = path.join(codexHome, 'rollout-c2.jsonl');
    fs.writeFileSync(rolloutChild2, [
      JSON.stringify({ timestamp: '2026-11-18T00:00:00Z', type: 'session_meta', payload: { id: 'c2' } }),
      JSON.stringify({ timestamp: '2026-11-18T00:00:01Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FunctionCallOutput', namespace: 'codex_app', name: 'create_thread', output: envelope('p1') } } }),
    ].join('\n') + '\n');

    assert.equal(readCreatedParentFromRolloutHead(rolloutChild2, 'c2'), 'p1');

    const sdb = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
    sdb.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, thread_source TEXT, cwd TEXT, title TEXT, name TEXT, archived INTEGER, git_branch TEXT, model TEXT, first_user_message TEXT, preview TEXT, agent_role TEXT, is_pinned INTEGER, thread_section_id TEXT)`);
    sdb.exec(`CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL)`);
    const ins = sdb.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    ins.run('p1', '', 1790000000, 1790000100, 'vscode', 'user', '/r/app', '親チャット', null, 0, 'main', null, '', '', null, 0, null);
    ins.run('c1', '', 1790000010, 1790000110, 'vscode', 'agent_created_thread', '/r/app', '作成された子1', null, 0, 'main', null, '', '', null, 0, null);
    ins.run('c2', rolloutChild2, 1790000020, 1790000120, 'vscode', 'agent_created_thread', '/r/app', '作成された子2', null, 0, 'main', null, '', '', null, 0, null);
    ins.run('sub1', '', 1790000030, 1790000130, '{"subagent":{}}', 'subagent', '/r/app', 'サブ1', null, 0, 'main', null, '', '', 'explorer', 0, null);
    sdb.prepare('INSERT INTO thread_spawn_edges VALUES (?,?,?)').run('p1', 'sub1', 'completed');
    sdb.close();

    const hdb = new DatabaseSync(path.join(codexHome, 'thread_history_1.sqlite'));
    hdb.exec(`CREATE TABLE thread_items (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, item_type TEXT NOT NULL DEFAULT '', updated_at_ordinal INTEGER NOT NULL DEFAULT 0, item_json TEXT NOT NULL, PRIMARY KEY (thread_id, turn_id, item_id))`);
    hdb.prepare('INSERT INTO thread_items VALUES (?,?,?,?,?,?,?,?)').run(
      'c1', 'turn-1', 'item-1', 12, 1790000010000, 'functionCallOutput', 12,
      JSON.stringify({ type: 'functionCallOutput', namespace: 'codex_app', name: 'create_thread', output: envelope('p1') }),
    );
    hdb.close();

    const { sessions, error } = await listCodexSessions({ home: codexHome });
    assert.equal(error, null);
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const p1 = byId.get('codex:p1');
    const c1 = byId.get('codex:c1');
    const c2 = byId.get('codex:c2');
    const sub1 = byId.get('codex:sub1');

    assert.equal(c1.subagent, false);
    assert.equal(c1.createdParentId, 'codex:p1');
    assert.equal(c2.createdParentId, 'codex:p1');
    assert.equal(c1.parentId, undefined);
    assert.deepEqual(p1.createdChildren.sort(), ['codex:c1', 'codex:c2']);
    assert.deepEqual(p1.children, ['codex:sub1']);
    assert.equal(sub1.parentId, 'codex:p1');
    assert.equal(sub1.createdParentId, undefined);

    // thread_history DB が無くても rollout フォールバックとキャッシュが動くこと
    const direct = await resolveCreatedChatParents(codexHome, sessions);
    assert.equal(direct.get('c1'), 'p1');
    assert.equal(direct.get('c2'), 'p1');
  } finally {
    resetCreatedChatCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('attachCreatedChatEdges は循環する辺を無視し、親欠損の子も createdParentId を保つ', () => {
  const sA = { id: 'codex:a', nativeId: 'a', agent: 'codex' };
  const sB = { id: 'codex:b', nativeId: 'b', agent: 'codex' };
  const sOrphan = { id: 'codex:orphan', nativeId: 'orphan', agent: 'codex' };
  const map = new Map([['a', 'b'], ['b', 'a'], ['orphan', 'missing-parent']]);
  attachCreatedChatEdges([sA, sB, sOrphan], map);
  assert.equal(sA.createdParentId, undefined);
  assert.equal(sB.createdParentId, undefined);
  assert.equal(sOrphan.createdParentId, 'codex:missing-parent');
});

test('buildBoard と sessionDetail は createdChats / createdParent / createdSiblings を正しく返す', async () => {
  resetCreatedChatCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-created-board-'));
  const prevCodex = process.env.CANBAN_CODEX_HOME;
  const prevClaude = process.env.CANBAN_CLAUDE_HOME;
  const prevDesktop = process.env.CANBAN_CLAUDE_DESKTOP_DIR;
  try {
    const codexHome = path.join(root, 'codex');
    const claudeHome = path.join(root, 'claude');
    const desktopDir = path.join(root, 'desktop');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.mkdirSync(desktopDir, { recursive: true });
    process.env.CANBAN_CODEX_HOME = codexHome;
    process.env.CANBAN_CLAUDE_HOME = claudeHome;
    process.env.CANBAN_CLAUDE_DESKTOP_DIR = desktopDir;

    const nowSec = Math.floor(Date.now() / 1000);
    const rolloutC1 = path.join(codexHome, 'c1.jsonl');
    const rolloutC2 = path.join(codexHome, 'c2.jsonl');
    const rolloutOrphan = path.join(codexHome, 'orphan.jsonl');
    for (const [file, id, parent] of [[rolloutC1, 'c1', 'p1'], [rolloutC2, 'c2', 'p1'], [rolloutOrphan, 'c3', 'deleted-parent']]) {
      fs.writeFileSync(file, [
        JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id } }),
        JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FunctionCallOutput', namespace: 'codex_app', name: 'create_thread', output: envelope(parent) } } }),
      ].join('\n') + '\n');
    }

    const sdb = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
    sdb.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, thread_source TEXT, cwd TEXT, title TEXT, name TEXT, archived INTEGER, git_branch TEXT, model TEXT, first_user_message TEXT, preview TEXT, agent_role TEXT, is_pinned INTEGER, thread_section_id TEXT)`);
    const ins = sdb.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    ins.run('p1', '', nowSec - 100, nowSec - 10, 'vscode', 'user', '/r/app', '本番リリース準備', null, 0, 'main', null, '', '', null, 0, null);
    ins.run('c1', rolloutC1, nowSec - 90, nowSec - 5, 'vscode', 'agent_created_thread', '/r/app', '同列の子', null, 0, 'main', null, '', '', null, 0, null);
    ins.run('c2', rolloutC2, nowSec - 80, nowSec - 20, 'vscode', 'agent_created_thread', '/r/app', '別列の子', null, 0, 'main', null, '', '', null, 0, null);
    ins.run('c3', rolloutOrphan, nowSec - 70, nowSec - 30, 'vscode', 'agent_created_thread', '/r/app', '親欠損の子', null, 0, 'main', null, '', '', null, 0, null);
    sdb.close();

    const store = new Store(dataDir);
    const createdList = await store.createList({ title: '完了リスト', color: 'blue' });
    await store.moveCard({ cardId: 'codex:c2', toListId: createdList.id, order: 1 });
    const board = await buildBoard(store, { days: 0 });
    const allCards = board.lists.flatMap((l) => l.cards);
    const parentCard = allCards.find((c) => c.id === 'codex:p1');
    const child1 = allCards.find((c) => c.id === 'codex:c1');
    const orphanCard = allCards.find((c) => c.id === 'codex:c3');

    assert.equal(parentCard.createdChats.total, 2);
    assert.deepEqual(parentCard.createdChats.children.map((c) => c.id).sort(), ['codex:c1', 'codex:c2']);
    assert.equal(child1.createdParent.id, 'codex:p1');
    assert.equal(child1.createdParent.available, true);
    assert.equal(orphanCard.createdParent.id, 'codex:deleted-parent');
    assert.equal(orphanCard.createdParent.available, false);

    const detailP = await sessionDetail(store, 'codex:p1');
    assert.equal(detailP.createdChats.length, 2);
    assert.equal(detailP.createdParent, null);

    const detailC = await sessionDetail(store, 'codex:c1');
    assert.equal(detailC.createdParent.id, 'codex:p1');
    assert.deepEqual(detailC.createdSiblings.map((s) => s.id), ['codex:c2']);
    await store.close();
  } finally {
    if (prevCodex === undefined) delete process.env.CANBAN_CODEX_HOME; else process.env.CANBAN_CODEX_HOME = prevCodex;
    if (prevClaude === undefined) delete process.env.CANBAN_CLAUDE_HOME; else process.env.CANBAN_CLAUDE_HOME = prevClaude;
    if (prevDesktop === undefined) delete process.env.CANBAN_CLAUDE_DESKTOP_DIR; else process.env.CANBAN_CLAUDE_DESKTOP_DIR = prevDesktop;
    resetCreatedChatCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('UI モデル: 同列の親子を重複なくネストし、別リストと休眠の件数を正しく集計する', () => {
  const { createdFamilyTone, createdFamilyIdOf, createdChatsSummaryText, groupListWithCreatedChats } = uiModel();
  assert.equal(createdFamilyTone('codex:p1'), createdFamilyTone('codex:p1'));

  const parent = {
    id: 'codex:p1',
    kind: 'session',
    status: 'running',
    createdChats: {
      total: 4,
      running: 1,
      waiting: 0,
      completed: 3,
      aborted: 0,
      children: [
        { id: 'codex:c1', status: 'running' },
        { id: 'codex:c2', status: 'completed' },
        { id: 'codex:c3', status: 'completed' },
        { id: 'codex:dorm', status: 'completed' },
      ],
    },
  };
  const c1 = { id: 'codex:c1', kind: 'session', createdParent: { id: 'codex:p1', title: '親' } };
  const c2 = { id: 'codex:c2', kind: 'session', createdParent: { id: 'codex:p1', title: '親' } };
  const c3 = { id: 'codex:c3', kind: 'session', createdParent: { id: 'codex:p1', title: '親' } };
  const standalone = { id: 'codex:other', kind: 'session' };

  assert.equal(createdFamilyIdOf(parent), 'codex:p1');
  assert.equal(createdFamilyIdOf(c1), 'codex:p1');
  assert.equal(createdFamilyIdOf(standalone), null);
  assert.match(createdChatsSummaryText(parent.createdChats), /4件.*実行中 1.*応答済 3/);

  const groups = groupListWithCreatedChats([parent, c1, standalone], {
    listId: 'doing',
    allLists: [
      { id: 'doing', title: '進行中', cards: [parent, c1, standalone] },
      { id: 'done', title: '完了', cards: [c2, c3] },
    ],
    dormantIds: new Set(['codex:dorm']),
    collapsedParents: new Set(),
  });

  assert.equal(groups.length, 2);
  assert.equal(groups[0].card.id, 'codex:p1');
  assert.deepEqual(JSON.parse(JSON.stringify(groups[0].nestedChildren.map((c) => c.id))), ['codex:c1']);
  assert.deepEqual(JSON.parse(JSON.stringify(groups[0].remoteGroups)), [{ listId: 'done', listTitle: '完了', count: 2 }]);
  assert.equal(groups[0].dormantCount, 1);
  assert.equal(groups[1].card.id, 'codex:other');
});

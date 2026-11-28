import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.mjs';
import { buildBoard, sessionDetail, dropLocalCache } from '../server/board.mjs';
import { LiveHub } from '../server/live.mjs';
import { createWatch } from '../server/watch.mjs';
import { readFeed, readFeedDelta } from '../server/feed.mjs';
import {
  listAntigravitySessions,
  listGeminiSessions,
  listCursorSessions,
  listChatGptSessions,
  resetMultiAgentCaches,
} from '../server/sources/multi-agents.mjs';

const jline = (o) => `${JSON.stringify(o)}\n`;

test('readFeedDelta detects sourcePath switch even when the new log is larger than the old offset', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-log-switch-'));
  try {
    const logA = path.join(dir, 'rollout-a.jsonl');
    const logB = path.join(dir, 'rollout-b.jsonl');
    fs.writeFileSync(
      logA,
      jline({ timestamp: '2026-11-28T00:00:00Z', type: 'session_meta', payload: { id: 't1' } }) +
        jline({ timestamp: '2026-11-28T00:00:01Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: '旧ログの依頼' }] } } }),
    );
    // Make logB larger than logA so size >= oldOffset would NOT trigger byte-size reset without sourcePath check
    fs.writeFileSync(
      logB,
      jline({ timestamp: '2026-11-28T00:01:00Z', type: 'session_meta', payload: { id: 't1', history_mode: 'paginated', history_base: { thread_id: 't1', end_ordinal_exclusive: 1, end_byte_offset: 100 } } }) +
        jline({ timestamp: '2026-11-28T00:01:01Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u2', content: [{ type: 'text', text: '巻き戻し後の依頼 ' + 'x'.repeat(200) }] } } }) +
        jline({ timestamp: '2026-11-28T00:01:02Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'a2', phase: 'final', content: [{ type: 'text', text: '巻き戻し後の応答 ' + 'y'.repeat(200) }] } } }),
    );

    const initial = await readFeed({ agent: 'codex', sourcePath: logA });
    assert.equal(initial.sourcePath, logA);
    assert.ok(fs.statSync(logB).size > initial.offset, 'new log must exceed old offset to test cursor identity');

    const delta = await readFeedDelta({ agent: 'codex', sourcePath: logB }, initial.offset, {
      codexItems: initial.codexItems,
      sourcePath: initial.sourcePath,
    });
    assert.equal(delta.reset, true);
    assert.equal(delta.sourcePath, logB);
    assert.equal(delta.items[0].text.startsWith('巻き戻し後の依頼'), true);

    const missingDelta = await readFeedDelta({ agent: 'codex', sourcePath: path.join(dir, 'missing.jsonl') }, initial.offset, {
      codexItems: initial.codexItems,
      sourcePath: logB,
    });
    assert.equal(missingDelta.reset, true);
    assert.deepEqual(missingDelta.items, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watch detects Codex rollout_path switch on an open card and sessionDetail reports missing rollout accurately', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-watch-switch-'));
  const prevCodex = process.env.CANBAN_CODEX_HOME;
  const prevClaude = process.env.CANBAN_CLAUDE_HOME;
  const prevDesktop = process.env.CANBAN_CLAUDE_DESKTOP_DIR;
  let hub, store;
  try {
    const codexHome = path.join(root, 'codex');
    const claudeHome = path.join(root, 'claude');
    const desktopDir = path.join(root, 'desktop');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.mkdirSync(desktopDir, { recursive: true });
    process.env.CANBAN_CODEX_HOME = codexHome;
    process.env.CANBAN_CLAUDE_HOME = claudeHome;
    process.env.CANBAN_CLAUDE_DESKTOP_DIR = desktopDir;
    dropLocalCache();

    const logA = path.join(codexHome, 'sessions', 'rollout-2026-11-28T10-00-00-t1.jsonl');
    const logB = path.join(codexHome, 'sessions', 'rollout-2026-11-28T10-05-00-t1_rev.jsonl');
    fs.writeFileSync(
      logA,
      jline({ timestamp: '2026-11-28T10:00:00Z', type: 'session_meta', payload: { id: 't1' } }) +
        jline({ timestamp: '2026-11-28T10:00:01Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: '最初の依頼' }] } } }),
    );
    fs.writeFileSync(
      logB,
      jline({ timestamp: '2026-11-28T10:05:00Z', type: 'session_meta', payload: { id: 't1', history_mode: 'paginated', history_base: { thread_id: 't1', end_ordinal_exclusive: 1, end_byte_offset: 80 } } }) +
        jline({ timestamp: '2026-11-28T10:05:01Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u2', content: [{ type: 'text', text: '巻き戻し後の依頼 ' + 'z'.repeat(240) }] } } }),
    );

    const dbPath = path.join(codexHome, 'state_5.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, updated_at_ms INTEGER,
      source TEXT, thread_source TEXT, cwd TEXT, title TEXT, name TEXT, archived INTEGER, git_branch TEXT, model TEXT,
      first_user_message TEXT, preview TEXT, agent_role TEXT, is_pinned INTEGER, thread_section_id TEXT)`);
    db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('t1', logA, 1790000000, 1790000100, 1790000100000, 'vscode', 'user', '/r/app', '会話テスト', null, 0, 'main', 'gpt-5', '最初の依頼', '最初の依頼', null, 0, null);
    db.close();

    store = new Store(dataDir);
    hub = new LiveHub({ dataDir, codexHome, claudeProjects: path.join(claudeHome, 'projects'), claudeDesktop: desktopDir });
    const watch = createWatch(hub);

    await buildBoard(store, { days: 0 });
    const d1 = await sessionDetail(store, 'codex:t1');
    assert.equal(d1.feed.sourcePath, logA);

    const init = await watch({ since: null, feeds: [{ cardId: 'codex:t1', offset: d1.feed.offset, size: d1.feed.size, codexItems: d1.feed.codexItems, sourcePath: d1.feed.sourcePath }] });

    // Simulate Codex reverting the thread to logB in state_5.sqlite
    const db2 = new DatabaseSync(dbPath);
    db2.prepare('UPDATE threads SET rollout_path = ?, updated_at = ?, updated_at_ms = ? WHERE id = ?')
      .run(logB, 1790000200, 1790000200000, 't1');
    db2.close();
    hub.emit('codex', dbPath);

    const update = await watch({
      since: init.seq,
      feeds: [{ cardId: 'codex:t1', offset: d1.feed.offset, size: d1.feed.size, codexItems: d1.feed.codexItems, sourcePath: d1.feed.sourcePath }],
      timeoutMs: 2000,
    });
    assert.equal(update.reload, true);
    assert.equal(update.feeds['codex:t1']?.reset, true);
    assert.equal(update.feeds['codex:t1']?.sourcePath, logB);
    assert.equal(hub.focusPaths.has(logB), true, 'watcher focus switches to the new rollout path');

    // Now test missing rollout file reporting in sessionDetail
    const missingPath = path.join(codexHome, 'sessions', 'rollout-missing.jsonl');
    const db3 = new DatabaseSync(dbPath);
    db3.prepare('UPDATE threads SET rollout_path = ?, updated_at = ?, updated_at_ms = ? WHERE id = ?')
      .run(missingPath, 1790000300, 1790000300000, 't1');
    db3.close();
    dropLocalCache();

    const dMissing = await sessionDetail(store, 'codex:t1');
    assert.equal(dMissing.feed, null);
    assert.match(dMissing.messagesError || '', /会話ログが見つかりません/);
  } finally {
    hub?.close();
    await store?.close();
    if (prevCodex === undefined) delete process.env.CANBAN_CODEX_HOME; else process.env.CANBAN_CODEX_HOME = prevCodex;
    if (prevClaude === undefined) delete process.env.CANBAN_CLAUDE_HOME; else process.env.CANBAN_CLAUDE_HOME = prevClaude;
    if (prevDesktop === undefined) delete process.env.CANBAN_CLAUDE_DESKTOP_DIR; else process.env.CANBAN_CLAUDE_DESKTOP_DIR = prevDesktop;
    dropLocalCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('UI: renderPaneKeepingDrafts drops stale conversation when switched log is unreadable while preserving request editor', () => {
  const src = fs.readFileSync('ui/card-overlay.js', 'utf8');
  const body = src.slice(src.indexOf('function renderPaneKeepingDrafts('), src.indexOf('async function changeSessionCardState('));
  const conv = { kids: ['old-feed-node'], replaceChildren(...kids) { this.kids = kids; } };
  const el = { querySelector: (q) => (q === '.req-row textarea' ? { value: '編集中の依頼' } : null) };
  const feeds = new Map([['codex:t1', { sourcePath: '/a.jsonl' }]]);
  const ctx = {
    live: { feeds },
    $: (q) => (q === '.th-conv' ? conv : null),
    h: (_tag, props) => props,
    renderFeed: () => 'new-feed',
    paintWorkspaceContext() {},
  };
  const renderPaneKeepingDrafts = vm.runInNewContext(`${body}\nrenderPaneKeepingDrafts`, ctx);
  renderPaneKeepingDrafts(
    { id: 'codex:t1', el, d: { session: { sourcePath: '/a.jsonl' } } },
    { session: { sourcePath: '/b.jsonl' }, feed: null, messagesError: '会話ログが見つかりません' },
  );
  assert.equal(feeds.has('codex:t1'), false, 'stale feed entry is removed');
  assert.equal(conv.kids.length, 1);
  assert.match(conv.kids[0].text, /切り替え後の会話を取得できませんでした.*会話ログが見つかりません/);
});

test('UI: syncStatusModel and kickLive coalescing report sync failures accurately and collapse bursts', async () => {
  const brSrc = fs.readFileSync('ui/board-render.js', 'utf8');
  const modelFn = brSrc.slice(brSrc.indexOf('function syncStatusModel('), brSrc.indexOf('function paintSyncStatus('));
  const syncStatusModel = vm.runInNewContext(`${modelFn}\nsyncStatusModel`, { fmtClock: () => '15:30' });

  assert.equal(syncStatusModel({ board: null, boardError: '失敗' }).hidden, true, 'initial failure uses #board, not duplicate #errbar');
  assert.equal(syncStatusModel({ board: { errors: [], generatedAt: 1000 }, boardError: null }).hidden, true);

  const stale = syncStatusModel({
    board: { errors: ['SSH タイムアウト'], generatedAt: 1700000000000 },
    boardError: 'Native 切断',
    liveSyncError: 'watch 失敗',
  });
  assert.equal(stale.hidden, false);
  assert.equal(stale.canRetry, true);
  assert.equal(stale.messages.length, 3);
  assert.match(stale.messages[0], /15:30 時点の表示を保持中.*Native 切断/);
  assert.match(stale.messages[1], /リアルタイム更新が中断しています.*watch 失敗/);
  assert.match(stale.messages[2], /一部のデータを取得できませんでした.*SSH タイムアウト/);

  // Verify kickLive coalesces synchronous bursts into a single watchOnce(0) call
  const rtSrc = fs.readFileSync('ui/realtime.js', 'utf8');
  const kickSlice = rtSrc.slice(rtSrc.indexOf('let kickQueued = false;'), rtSrc.indexOf('function noteCall('));
  let watchCalls = 0;
  const rtCtx = vm.createContext({
    live: { on: true, seq: 5 },
    queueMicrotask,
    watchOnce: async (ms) => { watchCalls += ms === 0 ? 1 : 100; return true; },
  });
  vm.runInContext(`${kickSlice}\nglobalThis.kickLive = kickLive;`, rtCtx);
  rtCtx.kickLive();
  rtCtx.kickLive();
  rtCtx.kickLive();
  await new Promise((r) => queueMicrotask(r));
  assert.equal(watchCalls, 1, 'three synchronous kickLive calls coalesce into one watchOnce(0)');
});

test('Multi-agent readers skip unchanged streams and fold appended JSONL lines incrementally', async () => {
  resetMultiAgentCaches();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-ma-cache-'));
  let streamCount = 0;
  const origStream = fs.createReadStream;
  fs.createReadStream = function (...args) {
    streamCount++;
    return origStream.apply(this, args);
  };
  try {
    const agyDir = path.join(root, 'agy');
    const gemDir = path.join(root, 'gem');
    const curDir = path.join(root, 'cur');
    const cgptDir = path.join(root, 'cgpt');
    const convLogDir = path.join(agyDir, 'brain', 'c1', '.system_generated', 'logs');
    fs.mkdirSync(convLogDir, { recursive: true });
    fs.mkdirSync(path.join(gemDir, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(curDir, 'workspaceStorage', 'w1'), { recursive: true });
    fs.mkdirSync(path.join(cgptDir, 'conversations'), { recursive: true });

    const agyTranscript = path.join(convLogDir, 'transcript.jsonl');
    fs.writeFileSync(agyTranscript, jline({ step_index: 0, type: 'USER_INPUT', created_at: 1790000000, content: '<USER_REQUEST>初回依頼</USER_REQUEST>' }));
    const gemFile = path.join(gemDir, 'sessions', 'g1.jsonl');
    fs.writeFileSync(gemFile, jline({ role: 'user', text: 'Gemini初回', timestamp: 1790000000 }));

    const vscdb = new DatabaseSync(path.join(curDir, 'workspaceStorage', 'w1', 'state.vscdb'));
    vscdb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    vscdb.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('composer.composerData', JSON.stringify({
      allComposers: [{ composerId: 'comp1', name: 'Comp1', subtitle: 'init', filesChangedCount: 1, createdAt: 1790000000000 }],
    }));
    vscdb.close();

    fs.writeFileSync(
      path.join(cgptDir, 'conversations', 'conv.json'),
      JSON.stringify([{ id: 'cg1', title: 'CG1', create_time: 1790000000, messages: [{ role: 'user', content: 'hi' }] }]),
    );

    await listAntigravitySessions(agyDir);
    await listGeminiSessions(gemDir);
    await listCursorSessions(curDir);
    await listChatGptSessions(cgptDir);
    assert.equal(streamCount, 2, 'cold read streams both JSONL files once');

    streamCount = 0;
    await listAntigravitySessions(agyDir);
    await listGeminiSessions(gemDir);
    await listCursorSessions(curDir);
    await listChatGptSessions(cgptDir);
    assert.equal(streamCount, 0, 'unchanged files perform zero stream reads');

    // Append to JSONL files and verify incremental fold updates turn counts and latest replies
    const firstByteLen = fs.statSync(gemFile).size;
    let lastStartOffset = -1;
    fs.createReadStream = function (p, opts) {
      streamCount++;
      if (p === gemFile) lastStartOffset = opts?.start ?? 0;
      return origStream.call(this, p, opts);
    };
    fs.appendFileSync(gemFile, jline({ role: 'assistant', text: '追記された応答', timestamp: 1790000050 }) + jline({ role: 'user', text: '2回目の依頼', timestamp: 1790000060 }));
    const gemAfter = await listGeminiSessions(gemDir);
    assert.equal(streamCount, 1);
    assert.equal(lastStartOffset, firstByteLen, 'incremental fold starts at previous EOF offset');
    assert.equal(gemAfter.sessions[0].turns, 2);
    assert.equal(gemAfter.sessions[0].lastMessage, '追記された応答');
    assert.equal(gemAfter.sessions[0].lastPrompt, '2回目の依頼');
  } finally {
    fs.createReadStream = origStream;
    resetMultiAgentCaches();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

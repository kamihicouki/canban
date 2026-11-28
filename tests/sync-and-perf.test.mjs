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
import { resolveCreatedChatParents, resetCreatedChatCache } from '../server/sources/codex-created-chats.mjs';
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
        jline({ timestamp: '2026-11-28T00:00:01Z', type: 'event_msg', payload: { type: 'UserMessage', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: '旧ログの依頼' }] } } }).replace('"type":"UserMessage","item"', '"type":"item_completed","item"'),
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

test('UI: applyFeed reset and renderPaneKeepingDrafts clear stale feed cursors to prevent infinite watch loops', () => {
  const rtSrc = fs.readFileSync('ui/realtime.js', 'utf8');
  const applySlice = rtSrc.slice(rtSrc.indexOf('function applyFeed('), rtSrc.indexOf('// ---- the long poll ----'));
  const opened = [];
  const feeds = new Map([['codex:t1', { cardId: 'codex:t1', offset: 120, sourcePath: '/a.jsonl' }]]);
  const applyFeed = vm.runInNewContext(`${applySlice}\napplyFeed`, {
    live: { feeds },
    openCard: (id) => opened.push(id),
  });
  applyFeed(feeds.get('codex:t1'), { reset: true, sourcePath: '/missing.jsonl' });
  assert.equal(feeds.has('codex:t1'), false, 'applyFeed deletes stale cursor before openCard so missing log cannot tight-loop');
  assert.deepEqual(opened, ['codex:t1']);

  const overlaySrc = fs.readFileSync('ui/card-overlay.js', 'utf8');
  const body = overlaySrc.slice(overlaySrc.indexOf('function renderPaneKeepingDrafts('), overlaySrc.indexOf('async function changeSessionCardState('));
  const conv = { kids: ['old-feed-node'], replaceChildren(...kids) { this.kids = kids; } };
  const el = { querySelector: (q) => (q === '.req-row textarea' ? { value: '編集中の依頼' } : null) };
  const feeds2 = new Map([['codex:t1', { sourcePath: '/a.jsonl' }]]);
  const ctx = {
    live: { feeds: feeds2 },
    $: (q) => (q === '.th-conv' ? conv : null),
    h: (_tag, props) => props,
    renderFeed: () => 'new-feed',
    paintWorkspaceContext() {},
  };
  const renderPaneKeepingDrafts = vm.runInNewContext(`${body}\nrenderPaneKeepingDrafts`, ctx);

  // Case 1: Switched log is unreadable
  renderPaneKeepingDrafts(
    { id: 'codex:t1', el, d: { session: { sourcePath: '/a.jsonl' } } },
    { session: { sourcePath: '/b.jsonl' }, feed: null, messagesError: '会話ログが見つかりません' },
  );
  assert.equal(feeds2.has('codex:t1'), false);
  assert.match(conv.kids[0].text, /切り替え後の会話を取得できませんでした.*会話ログが見つかりません/);

  // Case 2: Same-path log deleted/unreadable while editing queued request
  feeds2.set('codex:t1', { sourcePath: '/b.jsonl' });
  conv.kids = ['old-feed-node'];
  renderPaneKeepingDrafts(
    { id: 'codex:t1', el, d: { session: { sourcePath: '/b.jsonl' } } },
    { session: { sourcePath: '/b.jsonl' }, feed: null, messagesError: '会話ログが見つかりません' },
  );
  assert.equal(feeds2.has('codex:t1'), false, 'same-path unreadable log also removes stale feed cursor');
  assert.match(conv.kids[0].text, /^会話を取得できませんでした: 会話ログが見つかりません/);
});

test('UI: syncStatusModel, single-entry errbar, unified refreshBoard, and kickLive coalescing work accurately', async () => {
  const brSrc = fs.readFileSync('ui/board-render.js', 'utf8');
  const syncSlice = brSrc.slice(brSrc.indexOf('function syncStatusModel('), brSrc.indexOf('// Part of board.html:'));
  const errbarChildren = [];
  const errbarEl = {
    hidden: true,
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    replaceChildren(...kids) { errbarChildren.splice(0, errbarChildren.length, ...kids.filter(Boolean)); },
  };
  const syncCtx = vm.createContext({
    fmtClock: () => '15:30',
    state: { board: { errors: ['SSH タイムアウト'], generatedAt: 1700000000000 }, boardError: 'Native 切断' },
    live: { syncError: 'watch 失敗', off: false },
    $: (q) => (q === '#errbar' ? errbarEl : null),
    h: (tag, props) => ({ tag, ...props }),
  });
  vm.runInContext(`${syncSlice}\nglobalThis.syncStatusModel = syncStatusModel; globalThis.paintSyncStatus = paintSyncStatus;`, syncCtx);

  assert.equal(syncCtx.syncStatusModel({ board: null, boardError: '失敗' }).hidden, true, 'initial failure uses #board, not duplicate #errbar');
  syncCtx.paintSyncStatus();
  assert.equal(errbarEl.hidden, false);
  assert.equal(errbarChildren.some((c) => c.tag === 'button'), false, '#errbar must not render a duplicate refresh button');
  assert.equal(errbarChildren.some((c) => c.class === 'errbar-hint'), true, '#errbar points to the single appbar refresh button');

  // Verify unified refreshBoard reports honest status when live.syncError persists vs recovers, and skips busy panes
  const loadSrc = fs.readFileSync('ui/load.js', 'utf8');
  const toasts = [];
  const reloadedSessions = [];
  const loadCtx = vm.createContext({
    state: { board: null, boardError: 'old', filters: {} },
    panes: [
      { id: 'codex:idle', kind: 'session', busy: false },
      { id: 'codex:typing', kind: 'session', busy: true },
    ],
    live: { syncError: 'watch 切断' },
    bridge: { callTool: async () => ({ lists: [] }) },
    decodeSourceBoard: (b) => b,
    render() {}, reconcileCards() {}, paintCardListControls() {}, refreshShortcutHints() {}, refreshViews() {},
    paneBusyForReload: (p) => p.busy,
    loadSession: async (p) => { reloadedSessions.push(p.id); },
    watchOnce: async () => { throw new Error('still disconnected'); },
    toast: (msg, err) => toasts.push([msg, !!err]),
    h: (_tag, props) => props,
    $: () => ({ replaceChildren() {} }),
  });
  vm.runInContext(`${loadSrc}\nglobalThis.refreshBoard = refreshBoard;`, loadCtx);

  await loadCtx.refreshBoard();
  assert.deepEqual(reloadedSessions, ['codex:idle'], 'busy session pane is protected during refresh');
  assert.deepEqual(toasts, [['ボードを更新しました（リアルタイム更新は再接続中です）', false]], 'does not falsely claim full sync while watch is broken');

  toasts.length = 0;
  reloadedSessions.length = 0;
  loadCtx.watchOnce = async () => { loadCtx.live.syncError = null; return true; };
  await loadCtx.refreshBoard();
  assert.deepEqual(toasts, [['最新の状態に更新しました', false]], 'announces full sync once watch also recovers');

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

test('UI: workspace origin and latest controls mark aria-disabled and report missing-log reason accurately', async () => {
  const wsSrc = fs.readFileSync('ui/card-workspace.js', 'utf8');
  const slice = wsSrc.slice(wsSrc.indexOf('function paintWorkspaceContext('), wsSrc.indexOf('function focusWorkspaceRelated('));
  const attrs = { origin: {}, compactOrigin: {}, latest: {}, compactLatest: {} };
  const btn = (bucket) => ({ disabled: false, setAttribute: (k, v) => { bucket[k] = v; } });
  const toasts = [];
  const ctx = vm.createContext({
    live: { feeds: new Map() },
    T: { taskCard: 'タスクカード' },
    STATUS_LABELS: { idle: '待機' },
    WORKSPACE_ORIGIN_REVERTED: '最初の依頼は巻き戻し前の会話にあります',
    sessionKindLabel: () => 'Codex',
    fmtDate: () => '2026/11/28',
    toast: (msg, err) => toasts.push([msg, !!err]),
    workspacePane: () => null,
  });
  vm.runInContext(`${fs.readFileSync('ui/card-overlay-model.js', 'utf8')}\n${slice}\nglobalThis.paintWorkspaceContext = paintWorkspaceContext; globalThis.jumpWorkspaceOrigin = jumpWorkspaceOrigin; globalThis.jumpWorkspaceLatest = jumpWorkspaceLatest;`, ctx);

  const pane = {
    id: 'codex:missing',
    kind: 'session',
    d: { session: { title: '欠損ログ', status: 'idle', sourcePath: '/missing.jsonl' }, feed: null, messagesError: '会話ログが見つかりません' },
    workspaceFrame: {
      identityTitle: { textContent: '', title: '' },
      identityState: { textContent: '' },
      origin: { button: btn(attrs.origin), text: { textContent: '' }, meta: { textContent: '' } },
      latest: { button: btn(attrs.latest), text: { textContent: '' }, meta: { textContent: '' } },
      compactOrigin: btn(attrs.compactOrigin),
      compactLatest: btn(attrs.compactLatest),
    },
  };
  ctx.paintWorkspaceContext(pane);
  assert.equal(attrs.origin['aria-disabled'], 'true');
  assert.equal(attrs.compactOrigin['aria-disabled'], 'true');
  assert.equal(attrs.latest['aria-disabled'], 'true');
  assert.equal(attrs.compactLatest['aria-disabled'], 'true');

  await ctx.jumpWorkspaceOrigin(pane);
  ctx.jumpWorkspaceLatest(pane);
  assert.deepEqual(toasts, [
    ['会話を取得できないため起点の原文は取得できません: 会話ログが見つかりません', true],
    ['最新の発言へ移動できません: 会話ログが見つかりません', true],
  ]);
});

test('Multi-agent readers skip unchanged streams, fold appended JSONL lines, and re-parse from byte 0 on overwrite', async () => {
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

    // Overwrite file via O_TRUNC to a larger payload with different prefix -> must re-read from byte 0, not incremental append
    streamCount = 0;
    lastStartOffset = -1;
    fs.writeFileSync(
      gemFile,
      jline({ role: 'user', text: '上書き後の新しい先頭依頼 ' + 'w'.repeat(240), timestamp: 1790000100 }),
    );
    const gemRewritten = await listGeminiSessions(gemDir);
    assert.equal(streamCount, 1);
    assert.equal(lastStartOffset, 0, 'O_TRUNC rewrite invalidates incremental cursor via header prefix check');
    assert.equal(gemRewritten.sessions[0].turns, 1);
    assert.match(gemRewritten.sessions[0].firstPrompt, /^上書き後の新しい先頭依頼/);
  } finally {
    fs.createReadStream = origStream;
    resetMultiAgentCaches();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex-created-chats does not negative-cache when thread_history read fails transiently', async () => {
  resetCreatedChatCache();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-cc-transient-'));
  try {
    const dbPath = path.join(home, 'thread_history_1.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE thread_items (thread_id TEXT, item_type TEXT, rollout_ordinal INTEGER, item_json TEXT)');
    const delegation = '<codex_delegation><source_thread_id>parent-1</source_thread_id><input>依頼</input></codex_delegation>';
    db.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?)').run(
      'child-1',
      'userMessage',
      0,
      JSON.stringify({ type: 'userMessage', content: [{ type: 'text', text: delegation }] }),
    );
    db.close();

    const validBytes = fs.readFileSync(dbPath);
    const origStat = fs.statSync(dbPath);
    // Corrupt in-place with identical inode, size, and mtimeMs so histSig stays identical
    fs.writeFileSync(dbPath, Buffer.alloc(validBytes.length, 0x58));
    fs.utimesSync(dbPath, origStat.atime, origStat.mtime);

    const sessions = [{ agent: 'codex', nativeId: 'child-1', threadSource: 'agent_created_thread', sourcePath: path.join(home, 'missing-rollout.jsonl'), updatedAt: 1790000000000 }];
    const first = await resolveCreatedChatParents(home, sessions);
    assert.equal(first.size, 0, 'corrupt DB fails gracefully without throwing');

    // Restore valid bytes in-place with the exact same inode, size, and mtimeMs
    fs.writeFileSync(dbPath, validBytes);
    fs.utimesSync(dbPath, origStat.atime, origStat.mtime);

    const second = await resolveCreatedChatParents(home, sessions);
    assert.equal(second.get('child-1'), 'parent-1', 'transient failure was not negative-cached under identical histSig');
  } finally {
    resetCreatedChatCache();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

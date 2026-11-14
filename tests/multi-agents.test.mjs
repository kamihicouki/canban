import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  listAntigravitySessions,
  listGeminiSessions,
  listCursorSessions,
  listChatGptSessions,
  listGrokSessions,
  readMultiAgentRecords,
  multiAgentSessionMessages,
} from '../server/sources/multi-agents.mjs';
import { itemsFor } from '../server/feed.mjs';
import { localStatus } from '../server/status.mjs';
import { sessionSourceView } from '../server/source-model.mjs';
import { capabilitiesFor } from '../server/source-capabilities.mjs';
import { inferSurface } from '../server/board.mjs';
import { boardHtml } from '../server/ui.mjs';

test('Antigravity brain transcript.jsonl と task.md からセッション・計画・会話・フィードを読み取る', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-agy-test-'));
  const convId = '11111111-2222-3333-4444-555555555555';
  const logsDir = path.join(tmp, convId, '.system_generated', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const transcriptPath = path.join(logsDir, 'transcript.jsonl');
  const lines = [
    JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-04-15T10:00:00Z',
      content: 'Command Working Directory: /Users/test/repo/myapp\n<USER_REQUEST>\nマルチエージェント対応を実装してください\n</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-04-15T10:01:00Z',
      thinking: 'まずはデータ構造を調査します。',
      content: '調査を開始します。',
      tool_calls: [{ id: 'tc1', name: 'read_file', args: { Path: '/Users/test/repo/myapp/README.md' } }],
    }),
    JSON.stringify({
      step_index: 2,
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-04-15T10:01:05Z',
      content: 'Created At: 2026-04-15\nShowing lines 1-10',
    }),
    JSON.stringify({
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-04-15T10:02:00Z',
      content: '実装が完了しました。',
    }),
  ];
  fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');
  fs.writeFileSync(
    path.join(tmp, convId, 'task.md'),
    '# タスク\n- [x] リーダーの実装\n- [/] UIの統合\n- [ ] テスト追加\n',
  );

  const { sessions } = await listAntigravitySessions(tmp);
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.id, `antigravity:${convId}`);
  assert.equal(s.agent, 'antigravity');
  assert.equal(s.surface, 'ide');
  assert.equal(s.cwd, '/Users/test/repo/myapp');
  assert.equal(s.project, 'myapp');
  assert.match(s.firstPrompt, /マルチエージェント対応を実装してください/);
  assert.equal(s.sourceMetadata.planSteps.length, 3);
  assert.equal(s.sourceMetadata.planSteps[0].status, 'completed');
  assert.equal(s.sourceMetadata.planSteps[1].status, 'in_progress');
  assert.equal(s.sourceMetadata.planSteps[2].status, 'pending');

  // 会話メッセージとフィードアイテムの検証
  const msgs = await multiAgentSessionMessages(s);
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].text, 'マルチエージェント対応を実装してください');
  assert.equal(msgs[2].role, 'assistant');
  assert.equal(msgs[2].text, '実装が完了しました。');

  const records = await readMultiAgentRecords(s);
  const items = itemsFor('antigravity', records);
  assert.ok(items.some(i => i.k === 'user'));
  assert.ok(items.some(i => i.k === 'thinking'));
  assert.ok(items.some(i => i.k === 'tool' && i.name === 'read_file'));

  // ステータスと計画シグナルの検証
  const st = await localStatus(s, Date.now());
  assert.equal(st, 'completed');
  assert.equal(s.signals.plan.total, 3);
  assert.equal(s.signals.plan.done, 1);
  assert.equal(s.signals.plan.current, 'UIの統合');

  // sourceView と capabilities の検証
  const sv = sessionSourceView(s);
  assert.ok(sv.attributes.antigravityBrain);
  assert.equal(sv.attributes.antigravityBrain.status, 'known');
  const caps = capabilitiesFor({ session: s });
  assert.equal(caps.sendPrompt.status, 'unsupported');
});

test('Cursor workspaceStorage state.vscdb と agent-transcripts からセッションを読み取る', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-cursor-test-'));
  const wsDir = path.join(tmp, 'workspaceStorage', 'ws-hash-1');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(
    path.join(wsDir, 'workspace.json'),
    JSON.stringify({ folder: 'file:///Users/test/repo/cursor-proj' }),
  );
  const dbPath = path.join(wsDir, 'state.vscdb');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
    'composer.composerData',
    JSON.stringify({
      allComposers: [
        {
          type: 'head',
          composerId: 'comp-123',
          name: 'Cursor Composer テスト',
          subtitle: 'src/index.ts を編集',
          createdAt: 1776000000000,
          lastUpdatedAt: 1776000060000,
          totalLinesAdded: 42,
          totalLinesRemoved: 10,
          filesChangedCount: 2,
          unifiedMode: 'agent',
        },
      ],
    }),
  );
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
    'aiService.prompts',
    JSON.stringify([{ text: 'Cursor Composer テストの依頼内容' }]),
  );
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
    'aiService.generations',
    JSON.stringify([{ unixMs: 1776000030000, textDescription: 'src/index.ts を更新しました' }]),
  );
  db.close();

  const cursorHome = path.join(tmp, 'dot-cursor');
  const transDir = path.join(cursorHome, 'projects', 'cursor-proj', 'chats');
  fs.mkdirSync(transDir, { recursive: true });
  fs.writeFileSync(
    path.join(transDir, 'cli-session-1.jsonl'),
    [
      JSON.stringify({ role: 'user', content: 'Cursor CLI での質問', timestamp: '2026-04-15T11:00:00Z', cwd: '/Users/test/repo/cursor-proj' }),
      JSON.stringify({ role: 'assistant', content: 'Cursor CLI からの回答', timestamp: '2026-04-15T11:00:10Z' }),
    ].join('\n') + '\n',
  );

  const { sessions } = await listCursorSessions(cursorHome, path.join(tmp, 'workspaceStorage'));
  assert.equal(sessions.length, 2);

  const ideSession = sessions.find(s => s.id === 'cursor:comp-123');
  assert.ok(ideSession);
  assert.equal(ideSession.surface, 'ide');
  assert.equal(ideSession.cwd, '/Users/test/repo/cursor-proj');
  assert.equal(ideSession.project, 'cursor-proj');
  assert.equal(ideSession.sourceMetadata.cursorStats.linesAdded, 42);
  assert.equal(ideSession.sourceMetadata.cursorStats.linesRemoved, 10);
  const ideMsgs = await multiAgentSessionMessages(ideSession);
  assert.ok(ideMsgs.length >= 1);

  const cliSession = sessions.find(s => s.id === 'cursor:cli-session-1');
  assert.ok(cliSession);
  assert.equal(cliSession.surface, 'cli');
  const cliMsgs = await multiAgentSessionMessages(cliSession);
  assert.equal(cliMsgs.length, 2);
  assert.equal(cliMsgs[0].text, 'Cursor CLI での質問');
  assert.equal(cliMsgs[1].text, 'Cursor CLI からの回答');
});

test('Gemini CLI・ChatGPT Desktop・Grok CLI のセッションを正規化して読み取る', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-others-test-'));

  // Gemini CLI
  const geminiDir = path.join(tmp, 'gemini', 'tmp', 'proj-hash', 'chats');
  fs.mkdirSync(geminiDir, { recursive: true });
  fs.writeFileSync(
    path.join(geminiDir, 'session-gem-1.json'),
    JSON.stringify({
      sessionId: 'gem-1',
      cwd: '/Users/test/repo/gem-app',
      messages: [
        { role: 'user', content: 'Gemini CLI でテストを実行して', timestamp: '2026-04-15T12:00:00Z' },
        { role: 'model', content: 'テストを実行しました。すべて成功です。', timestamp: '2026-04-15T12:01:00Z' },
      ],
    }),
  );
  const { sessions: gemSessions } = await listGeminiSessions(path.join(tmp, 'gemini'));
  assert.equal(gemSessions.length, 1);
  assert.equal(gemSessions[0].id, 'gemini:gem-1');
  assert.equal(gemSessions[0].surface, 'cli');
  assert.equal((await multiAgentSessionMessages(gemSessions[0])).length, 2);

  // ChatGPT Desktop
  const chatgptDir = path.join(tmp, 'chatgpt');
  fs.mkdirSync(chatgptDir, { recursive: true });
  fs.writeFileSync(
    path.join(chatgptDir, 'conversations.json'),
    JSON.stringify([
      {
        id: 'cgpt-1',
        title: 'アーキテクチャ設計の相談',
        create_time: 1776000000,
        update_time: 1776000120,
        messages: [
          { role: 'user', content: 'マイクロサービスの分割案を出して' },
          { role: 'assistant', content: '3つの境界づけられたコンテキストを提案します。' },
        ],
      },
    ]),
  );
  const { sessions: cgptSessions } = await listChatGptSessions(chatgptDir);
  assert.equal(cgptSessions.length, 1);
  assert.equal(cgptSessions[0].id, 'chatgpt:cgpt-1');
  assert.equal(cgptSessions[0].surface, 'desktop');
  assert.equal(inferSurface(cgptSessions[0]), 'desktop');
  assert.equal((await multiAgentSessionMessages(cgptSessions[0])).length, 2);

  // Grok CLI
  const grokDir = path.join(tmp, 'grok', 'sessions');
  fs.mkdirSync(grokDir, { recursive: true });
  fs.writeFileSync(
    path.join(grokDir, 'grok-1.jsonl'),
    [
      JSON.stringify({ role: 'user', content: 'Grok CLI テスト', timestamp: '2026-04-15T13:00:00Z', cwd: '/Users/test/repo/grok-bot' }),
      JSON.stringify({ role: 'assistant', content: 'Grok 応答完了', timestamp: '2026-04-15T13:00:20Z' }),
    ].join('\n') + '\n',
  );
  const { sessions: grokSessions } = await listGrokSessions(path.join(tmp, 'grok'));
  assert.equal(grokSessions.length, 1);
  assert.equal(grokSessions[0].id, 'grok:grok-1');
  assert.equal(grokSessions[0].surface, 'cli');
  assert.equal((await multiAgentSessionMessages(grokSessions[0])).length, 2);
});

test('Antigravity conversation_summaries.db と projects/*.json から正式タイトル・プロジェクト・環境を解決する', async () => {
  const tmpGemini = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-agy-full-'));
  const agyDir = path.join(tmpGemini, 'antigravity');
  const configProjectsDir = path.join(tmpGemini, 'config', 'projects');
  const annotationsDir = path.join(agyDir, 'annotations');
  const brainDir = path.join(agyDir, 'brain');
  fs.mkdirSync(agyDir, { recursive: true });
  fs.mkdirSync(configProjectsDir, { recursive: true });
  fs.mkdirSync(annotationsDir, { recursive: true });
  fs.mkdirSync(brainDir, { recursive: true });

  const projId = '73bb22cf-235e-42d5-8a58-40d0e0e0bbc4';
  fs.writeFileSync(
    path.join(configProjectsDir, `${projId}.json`),
    JSON.stringify({
      id: projId,
      name: 'field-finder',
      projectResources: {
        resources: [{ gitFolder: { folderUri: 'file:///Users/test/ChatGPT/field-finder', defaultBranch: 'main' } }],
      },
      environments: {
        environments: [
          {
            id: 'env-1',
            name: 'refactor_scraping_architecture',
            resources: { resources: [{ folderUri: 'file:///Users/test/.gemini/antigravity/worktrees/field-finder/refactor_scraping_architecture' }] },
          },
        ],
      },
    }),
  );

  const convId = '0cd0a3eb-f78e-4d35-b4b0-bdd616662467';
  fs.writeFileSync(
    path.join(annotationsDir, `${convId}.pbtxt`),
    'title:"Admin Dashboard Architecture Redesign"  last_user_view_time:{seconds:1794306123}\n',
  );

  const dbPath = path.join(agyDir, 'conversation_summaries.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id text PRIMARY KEY,
      title text NOT NULL DEFAULT "",
      preview text NOT NULL DEFAULT "",
      step_count integer NOT NULL DEFAULT 0,
      last_modified_time datetime NOT NULL,
      workspace_uris text NOT NULL,
      status text NOT NULL DEFAULT "",
      project_id text NOT NULL DEFAULT "",
      agent_name text NOT NULL DEFAULT "",
      killed numeric NOT NULL DEFAULT 0,
      not_fully_idle numeric NOT NULL DEFAULT 0,
      last_user_input_time datetime NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, project_id, agent_name, killed, not_fully_idle, last_user_input_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    convId,
    'Admin Dashboard Architecture Redesign',
    'スクレイピングの高速化を行いました',
    12,
    '2026-11-10 10:19:15+00:00',
    JSON.stringify(['file:///Users/test/.gemini/antigravity/worktrees/field-finder/refactor_scraping_architecture']),
    'CASCADE_RUN_STATUS_IDLE',
    projId,
    '',
    0,
    0,
    '2026-11-10 10:18:00+00:00',
  );
  db.close();

  const { sessions } = await listAntigravitySessions(agyDir);
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.nativeId, convId);
  assert.equal(s.title, 'Admin Dashboard Architecture Redesign');
  assert.equal(s.project, 'field-finder');
  assert.equal(s.branch, 'refactor_scraping_architecture');
  assert.equal(s.cwd, '/Users/test/.gemini/antigravity/worktrees/field-finder/refactor_scraping_architecture');
  assert.equal(s.surface, 'ide');
});

test('UI バンドルにマルチエージェントメタデータと利用面バッジ・動的 AI Apps フィルタが含まれる', () => {
  const html = boardHtml();
  assert.match(html, /AGENT_META/);
  assert.match(html, /SURFACE_META/);
  assert.match(html, /aiAppsFilterNodes/);
  assert.match(html, /session-more-apps/);
  assert.match(html, /antigravityBrain/);
  assert.match(html, /cursorWorkspace/);
});

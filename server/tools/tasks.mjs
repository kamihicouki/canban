// Task card tools: create, update, link sessions, and session card lifecycle.
import { allSessions, findSession, dropLocalCache } from '../board.mjs';
import { taskContextSchema } from '../task-context.mjs';
import { sourceSelectionSchema } from '../category-bindings.mjs';
import { codexLifecycle } from '../session-actions.mjs';
import { appOnly, appAndModel, appTool, resolveList } from './shared.mjs';
import { taskHandoffRecord } from '../task-handoff.mjs';

export function createTaskTools({ store }) {
  return [
  {
    name: 'canban_create_task',
    title: 'タスクカードを追加',
    description: 'セッションに紐づかないタスクカードを作る（Trello のカードと同じ）。list はリスト ID か名前（省略時は既定のリスト）。',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, list: { type: 'string' }, directory: { type: ['string', 'null'] }, labels: { type: 'array', items: { type: 'string' } }, context: taskContextSchema, sourceContext: { anyOf: [sourceSelectionSchema, { type: 'null' }] }, clientRequestId: { type: 'string', maxLength: 128 }, slackSource: { type: 'string', maxLength: 120 } }, required: ['title'], additionalProperties: false },
    _meta: appAndModel,
    handler: async ({ title, description, list, directory, labels, context, sourceContext, clientRequestId, slackSource }) => {
      const l = list ? resolveList((await store.load()).lists, list) : null;
      const res = await store.createTask({ title, description, listId: l?.id || list, directory, labels, context, sourceContext, clientRequestId, slackSource });
      return { text: `タスクカード「${res.title}」を作成しました（${res.cardId}）`, structured: res };
    },
  },
  ];
}

export function taskTools({ store }) {
  return [
  {
    name: 'canban_get_task', title: 'タスクと引継ぎを読む',
    description: '保存済みのタスク目的・所属・紐付けと追記報告を読み取り専用で取得する。セッション本文や実行状態は取得しない。nextActionは報告者の提案で、人による確認ではない。',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, after: { type: 'string', description: '直前ページのnextCursor' }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 } }, required: ['taskId'], additionalProperties: false },
    annotations: { readOnlyHint: true }, _meta: appAndModel,
    handler: async args => ({ text: 'タスクと引継ぎ（報告・提案）', structured: taskHandoffRecord(await store.load(), args) }),
  },
  {
    name: 'canban_append_task_note', title: 'タスクに引継ぎ報告を追記',
    description: '報告を原文で追記する。既存の説明・メモ・会話・完了確認は変更しない。報告元IDは指定値であり認証済み作者ではない。次の行動は提案として保存し、更新・解除には取得したrevisionを指定する。同じclientRequestIdで再送可能。',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, text: { type: 'string', minLength: 1, maxLength: 20000 }, sourceSessionId: { type: 'string' }, nextAction: { type: ['string', 'null'], minLength: 1, maxLength: 2000 }, expectedRevision: { type: 'integer', minimum: 0 }, clientRequestId: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['taskId', 'text', 'clientRequestId'], additionalProperties: false },
    _meta: appAndModel,
    handler: async args => { const result = await store.appendTaskNote(args); return { text: result.conflict ? '引継ぎが更新されています。再取得してください' : result.duplicate ? '保存済みの報告です' : '引継ぎ報告を追記しました', structured: result }; },
  },
  {
    name: 'canban_link_session',
    title: 'セッションをタスクカードに紐付け',
    description: '既存のセッションをタスクカードに紐付ける（紐付いたセッションはタスクカードの中に表示される）。',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, sessionId: { type: 'string' }, expectedTaskId: { type: ['string', 'null'], description: '操作前に確認した所属。異なる場合は変更しない' } }, required: ['taskId', 'sessionId'], additionalProperties: false },
    _meta: appAndModel,
    handler: async (a) => {
      const { sessions } = await allSessions(await store.load());
      const session = sessions.find(s => s.id === a.sessionId);
      if (!session) throw new Error('セッションが見つかりません');
      if (session.subagent) throw new Error('タスクには通常のセッションを紐付けてください。サブエージェントは親セッションから参照できます。');
      return { text: '紐付けました', structured: await store.linkSession(a) };
    },
  },
  appTool('canban_unlink_session', 'セッションの紐付けを解除', { taskId: { type: 'string' }, sessionId: { type: 'string' }, expectedTaskId: { type: ['string', 'null'], description: '操作前に確認した所属。異なる場合は変更しない' } }, ['taskId', 'sessionId'], (a) => store.unlinkSession(a)),
  appTool('canban_update_task', 'タスクカードを更新', { cardId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, context: taskContextSchema, sourceContext: { anyOf: [sourceSelectionSchema, { type: 'null' }] }, directory: { type: ['string', 'null'] }, labels: { type: 'array', items: { type: 'string' } } }, ['cardId'], (a) => store.updateTask(a)),
  {
    name: 'canban_set_session_card_state',
    title: 'セッションカードを整理',
    description: 'エージェント本体のセッションをアーカイブ・復元・削除する。削除は会話履歴と関連情報も永久に削除する。対応するAPIがない場合は失敗し、Canbanだけの状態変更は行わない。',
    inputSchema: { type: 'object', properties: { cardId: { type: 'string' }, action: { type: 'string', enum: ['archive', 'restore', 'delete'] } }, required: ['cardId', 'action'], additionalProperties: false },
    _meta: appAndModel,
    handler: async (a) => {
      const { session, state } = await findSession(store, a.cardId);
      const before = a.action === 'delete' ? (await allSessions(state)).sessions : [];
      const affected = new Set([a.cardId]);
      if (a.action === 'delete') {
        for (let added = true; added;) {
          added = false;
          for (const s of before) if (affected.has(s.parentId) && !affected.has(s.id)) { affected.add(s.id); added = true; }
        }
      }
      let result;
      try { result = await codexLifecycle(session, a.action, { dataDir: store.dir }); }
      finally { dropLocalCache(); }
      if (a.action === 'delete') {
        const remaining = new Set((await allSessions(state, { force: true })).sessions.map(s => s.id));
        for (const id of affected) if (!remaining.has(id)) await store.removeSessionMetadata(id);
      }
      return { text: 'エージェントのセッションを操作しました', structured: result };
    },
  },
  appTool('canban_delete_task', 'タスクカードを削除', { cardId: { type: 'string' }, expectedTask: { type: 'object', description: '作成時のタスク内容。変更されていれば削除しない' } }, ['cardId'], (a) => store.deleteTask(a)),
  appTool('canban_clear_pending', '開始待ちを取り消す', { taskId: { type: 'string' } }, ['taskId'], (a) => store.clearPending(a)),
  {
    name: 'canban_get_task_dashboard',
    title: 'タスクの画面設定を取得',
    description: 'タスクごとに保存したカードダッシュボードの配置と、明示的に紐付いたセッションIDを返す。会話や実行状態は含まない。',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false },
    annotations: { readOnlyHint: true },
    _meta: appOnly,
    handler: async (a) => {
      const record = await store.getTaskDashboard(a);
      const { sessions } = await allSessions(await store.load());
      const members = new Set(record.links);
      return { text: 'タスクの画面設定', structured: { ...record, sessions: sessions.filter(s => members.has(s.id)).map(s => ({ id: s.id, title: s.title, agent: s.agent, status: s.status || 'idle', subagent: !!s.subagent })) } };
    },
  },
  appTool('canban_save_task_dashboard', 'タスクの画面設定を保存', {
    taskId: { type: 'string' }, expectedRevision: { type: 'integer', minimum: 0 }, state: { type: 'object' },
  }, ['taskId', 'expectedRevision', 'state'], (a) => store.saveTaskDashboard(a)),
  ];
}

// Board tools: the board, search, session detail, card moves, stats, and lists / labels / categories / rules / views.
import { buildBoard, sessionDetail, allSessions, effectiveOrder, runRules, sessionExchanges } from '../board.mjs';
import { RULE_TRIGGERS } from '../store.mjs';
import { computeStats } from '../stats.mjs';
import { sourceSelectionSchema } from '../category-bindings.mjs';
import { appOnly, appAndModel, filterProps, appTool, resolveList } from './shared.mjs';

export function boardTools({ store, ICONS, UI_URI }) {
  return [
  {
    name: 'open_canban',
    title: 'Canban',
    description:
      'Codex / Claude Code のセッション（このマシンと、有効化したリモート接続）を Trello 風カンバン Canban で開く。セッションのファイルは直接変更せず、リスト・ラベル・メモなどはカンバン側に別保存される。指示はエージェント公式 CLI 経由で 1 ターンずつ送れる。',
    icons: ICONS,
    inputSchema: { type: 'object', properties: { agent: filterProps.agent, project: filterProps.project }, additionalProperties: false },
    annotations: { readOnlyHint: true, title: 'Canban' },
    _meta: {
      ui: { resourceUri: UI_URI, visibility: ['model', 'app'] },
      'ui/resourceUri': UI_URI,
      'openai/outputTemplate': UI_URI,
      'openai/ui': { entrypoints: [{ type: 'global' }], preferredModelDisplayMode: 'fullscreen' },
      'openai/widgetAccessible': true,
      'openai/toolInvocation/invoking': 'カンバンを開いています…',
      'openai/toolInvocation/invoked': 'カンバンを開きました',
    },
    handler: async (args) => {
      const board = await buildBoard(store, { ...args, days: 30 });
      const summary = board.lists.map((l) => `- ${l.title}: ${l.count} 件`).join('\n');
      return {
        text: `Canban（表示 ${board.totals.shown} / 全 ${board.totals.sessions} セッション）\n${summary}`,
        structured: {
          view: 'board',
          initialFilters: board.filters,
          lists: board.lists.map((l) => ({ id: l.id, title: l.title, count: l.count, top: l.cards.slice(0, 5).map((c) => ({ id: c.id, title: c.title })) })),
          totals: board.totals,
        },
      };
    },
  },
  {
    name: 'canban_get_board',
    title: 'ボードを取得',
    description: 'カンバンボード全体（リスト・カード・ラベル）を取得する（UI 用）。',
    inputSchema: { type: 'object', properties: { ...filterProps, refresh: { type: 'boolean' } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
    _meta: appOnly,
    handler: async (args) => {
      const board = await buildBoard(store, args, { force: !!args.refresh });
      return { text: `${board.totals.shown} cards`, structured: board };
    },
  },
  {
    name: 'canban_search',
    title: 'セッションを検索',
    description: 'カンバン上のセッションを検索し、cardId・現在のリスト・タイトルを返す。カード移動の前に cardId を調べるのに使う。',
    inputSchema: { type: 'object', properties: { ...filterProps, list: { type: 'string', description: 'リスト ID または名前' }, limit: { type: 'number' } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
    _meta: appAndModel,
    handler: async (args) => {
      const board = await buildBoard(store, { days: 0, ...args });
      const wanted = args.list ? resolveList(board.lists, args.list)?.id : null;
      const rows = [];
      for (const l of board.lists) {
        if (wanted && l.id !== wanted) continue;
        for (const c of l.cards) rows.push({ cardId: c.id, list: l.title, listId: l.id, agent: c.agent, title: c.title, project: c.project, directory: c.directory?.name || null, updatedAt: new Date(c.updatedAt || 0).toISOString() });
      }
      rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      const limited = rows.slice(0, Math.min(Number(args.limit) || 30, 200));
      return {
        text: limited.map((r) => `${r.cardId} [${r.list}] (${r.agent}/${r.directory ? `📂${r.directory}` : r.project ?? '-'}) ${r.title}`).join('\n') || '該当なし',
        structured: { results: limited, total: rows.length, lists: board.lists.map((l) => ({ id: l.id, title: l.title })) },
      };
    },
  },
  {
    name: 'canban_exchanges',
    title: 'セッション間のやり取り',
    description: '取得済みのCodexセッション間メッセージと、確認できたMulti Agentの起動関係を読み取る。既読化・送信・カードの移動は行わない。',
    inputSchema: { type: 'object', properties: { cardId: { type: 'string' } }, required: ['cardId'], additionalProperties: false },
    annotations: { readOnlyHint: true },
    _meta: appOnly,
    handler: async ({ cardId }) => {
      const result = await sessionExchanges(store, cardId);
      return { text: `やり取り: ${result.events.length} 件`, structured: result };
    },
  },
  {
    name: 'canban_get_session',
    title: 'セッション詳細',
    description: '1 セッションの詳細（メタ情報・直近のやりとり・カンバン上のメモ・送信時の権限・依頼のキュー）を返す。',
    inputSchema: { type: 'object', properties: { cardId: { type: 'string' }, messages: { type: 'number' } }, required: ['cardId'], additionalProperties: false },
    annotations: { readOnlyHint: true },
    _meta: appAndModel,
    handler: async ({ cardId, messages }) => {
      const d = await sessionDetail(store, cardId, { messages: Math.min(Number(messages) || 12, 40) });
      await store.markSeen({ cardId });
      const s = d.session;
      const text = [
        `${s.title} (${s.agent}, ${s.status || 'idle'})`,
        `リスト: ${d.list?.title ?? '-'} / プロジェクト: ${s.project ?? '-'} / ブランチ: ${s.branch ?? '-'}`,
        s.account ? `アカウント: ${s.accountLabel}${s.home ? `（設定フォルダ: ${s.homeDir}）` : ''}` : null,
        `更新: ${new Date(s.updatedAt || 0).toISOString()}`,
        d.card.note ? `メモ: ${d.card.note}` : null,
        d.dispatch.permission ? `送信時の権限: ${d.dispatch.permission.label}${d.dispatch.permission.elevated ? '（制限なし）' : ''}` : null,
        d.dispatch.queue.length || d.dispatch.active.length ? `依頼: 待機 ${d.dispatch.queue.length} / 実行中 ${d.dispatch.active.length}${d.dispatch.paused ? `（一時停止: ${d.dispatch.paused.reason}）` : ''}` : null,
        ...d.recentMessages.map((m) => `${m.role === 'user' ? 'User' : 'Agent'}: ${m.text.slice(0, 300)}`),
      ]
        .filter(Boolean)
        .join('\n');
      return { text, structured: d };
    },
  },
  {
    name: 'canban_move_card',
    title: 'カードを移動',
    description: 'セッションのカードを別のリストへ移動する。toList はリスト ID か名前。order を省略すると position（top/bottom、既定 top）に置く。',
    inputSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string' },
        toList: { type: 'string' },
        order: { type: 'number', description: 'UI が計算した並び順の値' },
        position: { type: 'string', enum: ['top', 'bottom'] },
      },
      required: ['cardId', 'toList'],
      additionalProperties: false,
    },
    _meta: appAndModel,
    handler: async ({ cardId, toList, order, position }) => {
      const state = (await store.load());
      const list = resolveList(state.lists, toList);
      if (!list) throw new Error(`リストが見つかりません: ${toList}`);
      const { sessions } = await allSessions(state);
      const isTask = state.cards[cardId]?.kind === 'task';
      if (!isTask && !sessions.some((s) => s.id === cardId)) throw new Error(`カードが見つかりません: ${cardId}`);
      if (typeof order !== 'number') order = edgeOrder(state, sessions, list.id, cardId, position || 'top');
      const res = await store.moveCard({ cardId, toListId: list.id, order });
      return { text: `${cardId} を「${list.title}」へ移動しました`, structured: res };
    },
  },
  {
    name: 'canban_update_card',
    title: 'カード属性を更新',
    description: 'カードのラベル（ID 配列）・カテゴリ（引数名 directory。ID、null で自動、__none で所属なし）・メモ・優先度（high/medium/low）・期限（ISO 日付）・非表示を更新する。セッション本体は変更しない。',
    inputSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
        directory: { type: ['string', 'null'] },
        note: { type: 'string' },
        priority: { type: ['string', 'null'], enum: ['high', 'medium', 'low', null] },
        due: { type: ['string', 'null'] },
      },
      required: ['cardId'],
      additionalProperties: false,
    },
    _meta: appAndModel,
    handler: async (args) => ({ text: 'カードを更新しました', structured: await store.updateCard(args) }),
  },
  ];
}

export function statsTools({ store }) {
  return [
  {
    name: 'canban_get_stats',
    title: '分析',
    description: 'セッション数・トークン量の推移、プロジェクト／カテゴリ／マシン別の内訳、リストの滞留時間、完了までのサイクルタイムを返す。',
    inputSchema: { type: 'object', properties: { days: { type: 'number' }, agent: filterProps.agent, host: filterProps.host, account: filterProps.account, project: filterProps.project, directory: filterProps.directory, includeSubagents: { type: 'boolean' }, dotScope: filterProps.dotScope }, additionalProperties: false },
    annotations: { readOnlyHint: true },
    _meta: appAndModel,
    handler: async (args) => {
      let state = (await store.load());
      const { sessions } = await allSessions(state);
      if (await store.syncSessionCategories(sessions)) state = await store.load();
      const days = Math.min(Math.max(Number(args.days) || 30, 1), 365);
      const st = computeStats(state, sessions, { ...args, days });
      return { text: `直近 ${days} 日: ${st.totals.sessions} セッション / ${st.totals.tokens.toLocaleString()} トークン`, structured: st };
    },
  },
  ];
}

export function boardConfigTools({ store }) {
  return [
  appTool('canban_save_view', 'ビューを保存', { id: { type: 'string' }, name: { type: 'string' }, filters: { type: 'object' } }, ['name', 'filters'], (a) => store.saveView(a)),
  appTool('canban_delete_view', 'ビューを削除', { viewId: { type: 'string' } }, ['viewId'], (a) => store.deleteView(a)),
  appTool('canban_set_rule', '自動化（カードの自動移動）を保存', {
    id: { type: 'string' },
    enabled: { type: 'boolean' },
    trigger: { type: 'string', description: `${RULE_TRIGGERS.join(' / ')}、または section:<Codex のセクション ID>` },
    fromListId: { type: 'string' },
    toListId: { type: 'string' },
  }, ['trigger', 'toListId'], (a) => store.setRule(a)),
  appTool('canban_delete_rule', '自動化（カードの自動移動）を削除', { ruleId: { type: 'string' } }, ['ruleId'], (a) => store.deleteRule(a)),
  appTool('canban_run_rule', '自動化を今すぐ実行', { ruleId: { type: 'string' } }, ['ruleId'], async ({ ruleId }) => {
    const state = await store.load();
    if (!state.settings.rules.some((r) => r.id === ruleId)) throw new Error('自動化が見つかりません');
    const { sessions, errors } = await allSessions(state, { force: true });
    const moves = await runRules(store, state, sessions, Date.now(), { ruleId });
    return { ruleId, moved: moves.length, moves, errors };
  }),
  appTool('canban_undo_move', '自動移動を元に戻す', { cardId: { type: 'string' } }, ['cardId'], (a) => store.undoAutoMove(a)),
  appTool('canban_mark_all_seen', 'すべて既読にする', {}, [], () => store.markAllSeen()),
  appTool('canban_create_list', 'リストを追加', { title: { type: 'string' }, color: { type: 'string' }, afterListId: { type: 'string' } }, ['title'], (a) => store.createList(a)),
  appTool('canban_update_list', 'リストを更新', { listId: { type: 'string' }, title: { type: 'string' }, color: { type: ['string', 'null'] }, wipLimit: { type: ['number', 'null'] } }, ['listId'], (a) => store.updateList(a)),
  appTool('canban_delete_list', 'リストを削除', { listId: { type: 'string' }, moveCardsTo: { type: 'string' } }, ['listId'], (a) => store.deleteList(a)),
  appTool('canban_reorder_lists', 'リストを並べ替え', { listIds: { type: 'array', items: { type: 'string' } } }, ['listIds'], (a) => store.reorderLists(a)),
  appTool('canban_set_default_list', '既定リストを設定', { listId: { type: 'string' } }, ['listId'], (a) => store.setDefaultList(a)),
  appTool('canban_create_label', 'ラベルを追加', { name: { type: 'string' }, color: { type: 'string' } }, ['name'], (a) => store.createLabel(a)),
  appTool('canban_update_label', 'ラベルを更新', { labelId: { type: 'string' }, name: { type: 'string' }, color: { type: 'string' } }, ['labelId'], (a) => store.updateLabel(a)),
  appTool('canban_delete_label', 'ラベルを削除', { labelId: { type: 'string' } }, ['labelId'], (a) => store.deleteLabel(a)),
  appTool('canban_create_directory', 'カテゴリを追加', { name: { type: 'string' }, color: { type: ['string', 'null'] }, paths: { type: 'array', items: { type: 'string' } } }, ['name'], (a) => store.createDirectory(a)),
  appTool('canban_update_directory', 'カテゴリを更新', { sourceBindings: sourceSelectionSchema, directoryId: { type: 'string' }, name: { type: 'string' }, color: { type: ['string', 'null'] }, paths: { type: 'array', items: { type: 'string' } } }, ['directoryId'], (a) => store.updateDirectory(a)),
  appTool('canban_delete_directory', 'カテゴリを削除', { directoryId: { type: 'string' } }, ['directoryId'], (a) => store.deleteDirectory(a)),
  appTool('canban_get_ui_state', '共有画面状態を取得', {}, [], () => store.getUiState()),
  appTool('canban_save_ui_state', '共有画面状態を保存', {
    expectedRevision: { type: 'integer', minimum: 0 },
    state: { type: 'object' },
  }, ['expectedRevision', 'state'], ({ expectedRevision, state }) => store.saveUiState({ expectedRevision, state })),
  ];
}

function edgeOrder(state, sessions, listId, cardId, position) {
  const orders = [];
  for (const s of sessions) {
    if (s.id === cardId) continue;
    const card = state.cards[s.id];
    const lid = card?.listId && state.lists.some((l) => l.id === card.listId) ? card.listId : state.defaultListId;
    if (lid === listId) orders.push(effectiveOrder(s, card));
  }
  if (!orders.length) return 0;
  return position === 'bottom' ? Math.max(...orders) + 1000 : Math.min(...orders) - 1000;
}

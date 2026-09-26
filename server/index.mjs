#!/usr/bin/env node
// Canban MCP server (stdio, newline-delimited JSON-RPC 2.0).
// Exposes an MCP App whose `openai/ui` global entrypoint shows up as a Codex sidebar destination.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { buildBoard, sessionDetail, allSessions, findSession, hostsWithState, effectiveOrder, tickRules } from './board.mjs';
import { RULE_TRIGGERS } from './store.mjs';
import { desktopLink, resumeCommand } from './agents.mjs';
import { openUrl, runInTerminal, installedTerminals, setRunner, TERMINAL_LABELS } from './launcher.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(here, '..', '.codex-plugin', 'plugin.json'), 'utf8'));
const UI_URI = 'ui://canban/board.html';
const UI_MIME = 'text/html;profile=mcp-app';
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#0079BF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 7v7M12 7v4M16 7v9"/></svg>';
const ICONS = [{ src: `data:image/svg+xml;base64,${Buffer.from(ICON_SVG).toString('base64')}`, mimeType: 'image/svg+xml', sizes: ['any'] }];

const store = new Store();
const log = (...a) => process.stderr.write(`[canban] ${a.join(' ')}\n`);

// CANBAN_LAUNCH_DRYRUN=1 logs launches instead of opening apps (development / demos).
if (process.env.CANBAN_LAUNCH_DRYRUN === '1') setRunner(async (file, args) => log('dry-run:', file, ...args));

// ---- tool definitions ----------------------------------------------------
const appOnly = { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true, 'openai/visibility': 'private' };
const appAndModel = { ui: { visibility: ['model', 'app'] }, 'openai/widgetAccessible': true };

const filterProps = {
  agent: { type: 'string', enum: ['all', 'codex', 'claude'], description: 'エージェントで絞り込み' },
  host: { type: 'string', description: "マシンで絞り込み（'local' またはリモート接続の hostId）" },
  project: { type: 'string', description: 'プロジェクト名（cwd のディレクトリ名）で絞り込み' },
  status: { type: 'string', enum: ['running', 'waiting', 'completed', 'aborted', 'idle'], description: '実行状態で絞り込み' },
  q: { type: 'string', description: 'タイトル・最初の依頼・メモ・ラベルの部分一致検索' },
  includeArchived: { type: 'boolean' },
  includeSubagents: { type: 'boolean' },
  includeHidden: { type: 'boolean' },
  days: { type: 'number', description: '未配置セッションの表示期間（日）。0 で無制限。既定 30' },
};

const TOOLS = [
  {
    name: 'open_canban',
    title: 'Canban',
    description:
      'Codex / Claude Code のセッション（このマシンと、有効化したリモート接続）を Trello 風カンバン Canban で開く。セッション本体は読み取り専用で、リスト・ラベル・メモなどはカンバン側に別保存される。',
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
        for (const c of l.cards) rows.push({ cardId: c.id, list: l.title, listId: l.id, agent: c.agent, title: c.title, project: c.project, updatedAt: new Date(c.updatedAt || 0).toISOString() });
      }
      rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      const limited = rows.slice(0, Math.min(Number(args.limit) || 30, 200));
      return {
        text: limited.map((r) => `${r.cardId} [${r.list}] (${r.agent}/${r.project ?? '-'}) ${r.title}`).join('\n') || '該当なし',
        structured: { results: limited, total: rows.length, lists: board.lists.map((l) => ({ id: l.id, title: l.title })) },
      };
    },
  },
  {
    name: 'canban_get_session',
    title: 'セッション詳細',
    description: '1 セッションの詳細（メタ情報・直近のやりとり・カンバン上のメモ等）を読み取り専用で返す。',
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
        `更新: ${new Date(s.updatedAt || 0).toISOString()}`,
        d.card.note ? `メモ: ${d.card.note}` : null,
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
      const state = store.load();
      const list = resolveList(state.lists, toList);
      if (!list) throw new Error(`リストが見つかりません: ${toList}`);
      const { sessions } = await allSessions(state);
      if (!sessions.some((s) => s.id === cardId)) throw new Error(`セッションが見つかりません: ${cardId}`);
      if (typeof order !== 'number') order = edgeOrder(state, sessions, list.id, cardId, position || 'top');
      const res = await store.moveCard({ cardId, toListId: list.id, order });
      return { text: `${cardId} を「${list.title}」へ移動しました`, structured: res };
    },
  },
  {
    name: 'canban_update_card',
    title: 'カード属性を更新',
    description: 'カードのラベル（ID 配列）・メモ・優先度（high/medium/low）・期限（ISO 日付）・非表示を更新する。セッション本体は変更しない。',
    inputSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
        note: { type: 'string' },
        priority: { type: ['string', 'null'], enum: ['high', 'medium', 'low', null] },
        due: { type: ['string', 'null'] },
        hidden: { type: 'boolean' },
      },
      required: ['cardId'],
      additionalProperties: false,
    },
    _meta: appAndModel,
    handler: async (args) => ({ text: 'カードを更新しました', structured: await store.updateCard(args) }),
  },
  {
    name: 'canban_open_session',
    title: 'セッションを再開',
    description:
      'セッションを再開する。route=desktop はエージェントのデスクトップアプリ（Codex / Claude）で開き、route=terminal は再開コマンドをターミナルで実行する。省略時はユーザー設定に従う。target は new-window / new-tab / split / current。',
    inputSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string' },
        route: { type: 'string', enum: ['desktop', 'terminal'] },
        terminal: { type: 'string', enum: ['ghostty', 'terminal', 'iterm'] },
        target: { type: 'string', enum: ['new-window', 'new-tab', 'split', 'current'] },
      },
      required: ['cardId'],
      additionalProperties: false,
    },
    _meta: appAndModel,
    handler: async ({ cardId, route, terminal, target }) => {
      const { session, state } = await findSession(store, cardId);
      await store.markSeen({ cardId });
      const prefs = state.settings.launch;
      let useRoute = route || prefs.route;
      const link = desktopLink(session);
      if (useRoute === 'desktop' && !link) {
        if (route === 'desktop') throw new Error('このセッションはデスクトップアプリでは開けません。ターミナルで再開してください。');
        useRoute = 'terminal';
      }
      if (useRoute === 'desktop') {
        await openUrl(link.url);
        return { text: `${link.label}: ${link.url}`, structured: { route: 'desktop', url: link.url, exact: link.exact, note: link.note || null } };
      }
      const term = terminal || prefs.terminal;
      if (!installedTerminals().some((t) => t.id === term)) throw new Error(`${TERMINAL_LABELS[term] || term} が見つかりません。設定でターミナルを選んでください。`);
      const command = resumeCommand(session);
      const res = await runInTerminal({ terminal: term, target: target || prefs.target, command });
      return { text: `${TERMINAL_LABELS[term]} で再開: ${command}`, structured: { route: 'terminal', command, ...res } };
    },
  },
  {
    name: 'canban_list_hosts',
    title: 'マシン一覧',
    description: 'このマシンと、Codex アプリに登録済みのリモート接続（SSH）の一覧と読み取り状態を返す。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    _meta: appAndModel,
    handler: async () => {
      const hosts = await hostsWithState(store.load());
      return {
        text: hosts.map((h) => `${h.id} ${h.label} ${h.enabled ? 'on' : 'off'} ${h.status.state}${h.status.error ? ` (${h.status.error})` : ''}`).join('\n') || 'リモート接続は登録されていません',
        structured: { hosts: hosts.map(({ sshArgs, ...h }) => h) },
      };
    },
  },
  appTool('canban_set_remote_host', 'リモート接続の読み取りを切り替え', { hostId: { type: 'string' }, enabled: { type: 'boolean' } }, ['hostId', 'enabled'], async (a) => {
    const hosts = await hostsWithState(store.load());
    if (!hosts.some((h) => h.id === a.hostId)) throw new Error('Codex に登録されていない接続です');
    return store.setRemoteHost(a);
  }),
  appTool('canban_update_settings', '再開方法の既定を変更', {
    route: { type: 'string', enum: ['desktop', 'terminal'] },
    terminal: { type: 'string', enum: ['ghostty', 'terminal', 'iterm'] },
    target: { type: 'string', enum: ['new-window', 'new-tab', 'split', 'current'] },
  }, [], (a) => store.updateLaunchSettings(a)),
  appTool('canban_set_rule', '自動移動ルールを保存', {
    id: { type: 'string' },
    enabled: { type: 'boolean' },
    trigger: { type: 'string', enum: RULE_TRIGGERS },
    fromListId: { type: 'string' },
    toListId: { type: 'string' },
  }, ['trigger', 'toListId'], (a) => store.setRule(a)),
  appTool('canban_delete_rule', '自動移動ルールを削除', { ruleId: { type: 'string' } }, ['ruleId'], (a) => store.deleteRule(a)),
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
];

function appTool(name, title, properties, required, fn) {
  return {
    name,
    title,
    description: `${title}（カンバン UI 用）`,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    _meta: appOnly,
    handler: async (args) => ({ text: `${title}: OK`, structured: { result: await fn(args) } }),
  };
}

function resolveList(lists, key) {
  if (!key) return null;
  const k = String(key).trim();
  return lists.find((l) => l.id === k) || lists.find((l) => l.title === k) || lists.find((l) => l.title.toLowerCase() === k.toLowerCase()) || null;
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

const toolsByName = new Map(TOOLS.map((t) => [t.name, t]));

// ---- JSON-RPC ------------------------------------------------------------
function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function uiHtml() {
  return fs.readFileSync(path.join(here, '..', 'ui', 'board.html'), 'utf8').replaceAll('__CANBAN_VERSION__', PKG.version);
}

async function handle(method, params = {}) {
  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      return {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[1],
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: 'canban', title: 'Canban', version: PKG.version, icons: ICONS },
        instructions:
          'Canban: Codex / Claude Code のセッションを Trello 風カンバンで管理する。セッション本体は読み取り専用。カードの移動や再開は canban_search で cardId を調べてから canban_move_card / canban_open_session を使う。',
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS.map(({ handler, ...t }) => t) };
    case 'tools/call': {
      const tool = toolsByName.get(params.name);
      if (!tool) throw rpcError(-32602, `Unknown tool: ${params.name}`);
      try {
        const { text, structured } = await tool.handler(params.arguments || {});
        return { content: [{ type: 'text', text }], structuredContent: structured, _meta: tool.name === 'open_canban' ? tool._meta : undefined };
      } catch (err) {
        return { content: [{ type: 'text', text: err.message || String(err) }], isError: true };
      }
    }
    case 'resources/list':
      return {
        resources: [{ uri: UI_URI, name: 'canban-board', title: 'Canban', mimeType: UI_MIME, icons: ICONS }],
      };
    case 'resources/templates/list':
      return { resourceTemplates: [] };
    case 'resources/read': {
      if (params.uri !== UI_URI) throw rpcError(-32002, `Resource not found: ${params.uri}`);
      return {
        contents: [
          {
            uri: UI_URI,
            mimeType: UI_MIME,
            text: uiHtml(),
            _meta: {
              ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } },
              'openai/widgetPrefersBorder': false,
              'openai/widgetDescription': 'Codex / Claude セッションのカンバンボード',
            },
          },
        ],
      };
    }
    default:
      throw rpcError(-32601, `Method not found: ${method}`);
  }
}

function rpcError(code, message) {
  const e = new Error(message);
  e.rpcCode = code;
  return e;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = new Set();
rl.on('line', (line) => {
  const p = onLine(line).finally(() => pending.delete(p));
  pending.add(p);
});
rl.on('close', async () => {
  await Promise.allSettled([...pending]);
  // Exit only after stdout has flushed; large responses are written asynchronously to pipes.
  process.stdout.write('', () => process.exit(0));
});

async function onLine(line) {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (msg.id === undefined || msg.id === null) return; // notification
  try {
    const result = await handle(msg.method, msg.params);
    send({ jsonrpc: '2.0', id: msg.id, result });
  } catch (err) {
    log('error', msg.method, err.stack || err.message);
    send({ jsonrpc: '2.0', id: msg.id, error: { code: err.rpcCode || -32603, message: err.message } });
  }
}
// Rules keep working while the board is closed (the server lives as long as Codex does).
const RULE_TICK_MS = Number(process.env.CANBAN_RULE_TICK_MS) || 60000;
setInterval(() => tickRules(store).catch((e) => log('rules:', e.message)), RULE_TICK_MS).unref();

log(`started v${PKG.version}`);

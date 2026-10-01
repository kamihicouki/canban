#!/usr/bin/env node
// Canban MCP server (stdio, newline-delimited JSON-RPC 2.0).
// Exposes an MCP App whose `openai/ui` global entrypoint shows up as a Codex sidebar destination.
// Other MCP Apps hosts (Claude Desktop) render the same `ui.resourceUri` inline in the conversation.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { leaderFor } from './leader.mjs';
import { perf } from './perf.mjs';
import { dispatcherFor, tickDispatch, setSpawner, dryRunSpawner } from './dispatch.mjs';
import { buildBoard, sessionDetail, allSessions, findSession, hostsWithState, effectiveOrder, tickRules, tickSearch } from './board.mjs';
import { RULE_TRIGGERS } from './store.mjs';
import { computeStats } from './stats.mjs';
import { desktopLink, resumeCommand, newSessionLink, newSessionCommand } from './agents.mjs';
import { LOCAL_HOST } from './sources/util.mjs';
import { openUrl, runInTerminal, installedTerminals, setRunner, TERMINAL_LABELS } from './launcher.mjs';
import { LiveHub } from './live.mjs';
import { createWatch } from './watch.mjs';
import { Presence, appLabel } from './presence.mjs';
import { codexHome } from './sources/codex.mjs';
import { claudeHome, claudeDesktopSessionsDir } from './sources/claude.mjs';
import { accountTools, accountFilterProp, accountDesktopNote, extraWatchRoots } from './accounts-mcp.mjs';
import { boardHtml } from './ui.mjs';
import { taskContextSchema } from './task-context.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// The Codex plugin manifest is absent when installed another way (Claude Desktop extension, a bare copy).
const PKG = readManifest(['.codex-plugin', 'plugin.json'], ['package.json']);
const UI_URI = 'ui://canban/board.html';
const UI_MIME = 'text/html;profile=mcp-app';
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#0079BF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 7v7M12 7v4M16 7v9"/></svg>';
const ICONS = [{ src: `data:image/svg+xml;base64,${Buffer.from(ICON_SVG).toString('base64')}`, mimeType: 'image/svg+xml', sizes: ['any'] }];

function readManifest(...candidates) {
  for (const parts of candidates) {
    try {
      return JSON.parse(fs.readFileSync(path.join(here, '..', ...parts), 'utf8'));
    } catch {}
  }
  return { version: '0.0.0' };
}

const store = new Store();
// Realtime: watches nothing until a board calls canban_watch (see server/live.mjs).
const live = process.env.CANBAN_LIVE === '0' ? null : new LiveHub({ dataDir: store.dir, codexHome: codexHome(), claudeProjects: path.join(claudeHome(), 'projects'), claudeDesktop: claudeDesktopSessionsDir(), extraRoots: extraWatchRoots(store) });
const watch = live ? createWatch(live, { presence: new Presence(store.dir, { app: () => appLabel(client) }) }) : null;
let client = null; // clientInfo from initialize: which host started this server
const log = (...a) => process.stderr.write(`[canban] ${a.join(' ')}\n`);

// CANBAN_LAUNCH_DRYRUN=1 logs launches instead of opening apps (development / demos).
if (process.env.CANBAN_LAUNCH_DRYRUN === '1') {
  setRunner(async (file, args) => log('dry-run:', file, ...args));
  setSpawner(dryRunSpawner(log));
}

// ---- tool definitions ----------------------------------------------------
const appOnly = { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true, 'openai/visibility': 'private' };
const appAndModel = { ui: { visibility: ['model', 'app'] }, 'openai/widgetAccessible': true };

const filterProps = {
  agent: { type: 'string', enum: ['all', 'codex', 'claude'], description: 'AI App（codex / claude）で絞り込み' },
  host: { type: 'string', description: "マシンで絞り込み（'local' またはリモート接続の hostId）" },
  account: accountFilterProp,
  project: { type: 'string', description: 'プロジェクトで絞り込み（Codex のプロジェクト名。Codex のプロジェクトに入っていないセッションは作業フォルダ名）' },
  folder: { type: 'string', description: '作業フォルダ名（cwd の末尾）で絞り込み' },
  section: { type: 'string', description: "Codex のセクション ID で絞り込み。'__none' でセクションなし" },
  directory: { type: 'string', description: "Canban のカテゴリ（ユーザーが作る、1 枚に 1 つのまとまり。API 上の名前は directory）の ID で絞り込み。'__none' でカテゴリなし" },
  label: { type: 'string', description: "ラベル IDで絞り込み。'__none' でラベルなし" },
  status: { type: 'string', enum: ['running', 'waiting', 'completed', 'aborted', 'idle'], description: '実行状態で絞り込み' },
  q: { type: 'string', description: 'タイトル・最初の依頼・メモ・ラベルの部分一致検索' },
  includeArchived: { type: 'boolean' },
  includeSubagents: { type: 'boolean' },
  includeHidden: { type: 'boolean' },
  pinnedOnly: { type: 'boolean', description: 'Codex アプリでピン留めしたスレッドだけ' },
  groupBranch: { type: 'boolean', description: '同じリポジトリ＋ブランチのセッションをまとめる' },
  fulltext: { type: 'boolean', description: 'q を会話の本文でも検索する（3 文字以上）' },
  days: { type: 'number', description: '未配置セッションの表示期間（日）。0 で無制限。既定 30' },
};

const TOOLS = [
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
      'セッションを再開する。route=desktop は AI App のデスクトップアプリ（Codex / Claude）で開き、route=terminal は再開コマンドをターミナルで実行する。省略時はユーザー設定に従う。target は new-window / new-tab / split / current。',
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
      // Claude desktop signed in to another account would not find the session: the
      // default route resumes it in the terminal instead (an explicit desktop still opens).
      const accountNote = accountDesktopNote(session, state.settings.accounts.labels);
      if (useRoute === 'desktop' && accountNote && !route) useRoute = 'terminal';
      if (useRoute === 'desktop') {
        await openUrl(link.url);
        const note = accountNote || link.note || null;
        return { text: `${link.label}: ${link.url}${accountNote ? `\n${note}` : ''}`, structured: { route: 'desktop', url: link.url, exact: link.exact, note } };
      }
      const term = terminal || prefs.terminal;
      if (!installedTerminals().some((t) => t.id === term)) throw new Error(`${TERMINAL_LABELS[term] || term} が見つかりません。設定でターミナルを選んでください。`);
      const command = resumeCommand(session);
      const res = await runInTerminal({ terminal: term, target: target || prefs.target, command });
      return { text: `${TERMINAL_LABELS[term]} で再開: ${command}`, structured: { route: 'terminal', command, ...res } };
    },
  },
  {
    name: 'canban_send_prompt',
    title: 'セッションに指示を送る',
    description:
      '既存の Codex / Claude Code セッションにプロンプトを 1 ターン分送る（Codex / Claude Code 公式 CLI のヘッドレス再開。権限はそのセッションの設定を引き継ぎ、昇格しない）。when=now はすぐ送る（セッションが実行中・入力待ち・直前に更新された場合は理由を返して送らない）、queue はセッションが空いたら順に送る。結果は canban_list_requests で確認する。制限なし（danger-full-access / bypassPermissions）のセッションには送れない。',
    inputSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string', description: 'canban_search で調べたセッションの cardId' },
        prompt: { type: 'string' },
        when: { type: 'string', enum: ['now', 'queue'], description: '既定 queue' },
      },
      required: ['cardId', 'prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    _meta: appAndModel,
    handler: async ({ cardId, prompt, when = 'queue' }) => {
      const r = await dispatcherFor(store).submit({ cardId, prompt, when, origin: 'model' });
      return { text: `${r.state === 'queued' ? 'キューに追加しました' : '送信しました'}（${r.id}）`, structured: requestView(r) };
    },
  },
  {
    name: 'canban_list_requests',
    title: '依頼の一覧',
    description: 'セッションに送った／待機中の依頼と、その状態・結果（エージェントの最終メッセージ先頭）を返す。',
    inputSchema: {
      type: 'object',
      properties: { cardId: { type: 'string' }, state: { type: 'string', enum: ['queued', 'starting', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'blocked'] }, limit: { type: 'number' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    _meta: appAndModel,
    handler: async ({ cardId, state, limit }) => {
      const d = dispatcherFor(store);
      await d.tick().catch(() => {});
      const rows = (await d.requests.list({ cardId, state })).sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.min(Number(limit) || 20, 100)).map(requestView);
      return {
        text: rows.map((r) => `${r.id} [${r.state}] ${r.cardId}: ${r.prompt.slice(0, 60)}${r.resultText ? ` → ${r.resultText.slice(0, 120)}` : ''}${r.error ? ` ✗ ${r.error}` : ''}`).join('\n') || '依頼はありません',
        structured: { requests: rows, paused: (await d.requests.load()).paused },
      };
    },
  },
  {
    name: 'canban_cancel_request',
    title: '待機中の依頼を取り消す',
    description: 'キューで待機中の依頼を取り消す（実行中のものは取り消せない）。',
    inputSchema: { type: 'object', properties: { requestId: { type: 'string' } }, required: ['requestId'], additionalProperties: false },
    _meta: appAndModel,
    handler: async ({ requestId }) => ({ text: '取り消しました', structured: requestView((await dispatcherFor(store).requests.cancel(requestId))) }),
  },
  {
    name: 'canban_dispatch',
    title: '指示を送る（UI）',
    description: '指示を送る（カンバン UI 用）',
    inputSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string' },
        prompt: { type: 'string' },
        when: { type: 'string', enum: ['now', 'queue'] },
        expectedUpdatedAt: { type: ['number', 'null'] },
        allowElevated: { type: 'boolean' },
      },
      required: ['cardId', 'prompt', 'when'],
      additionalProperties: false,
    },
    _meta: appOnly,
    handler: async (a) => {
      const r = await dispatcherFor(store).submit({ ...a, origin: 'ui' });
      return { text: r.state === 'queued' ? 'キューに追加しました' : '送信しました', structured: requestView(r) };
    },
  },
  appTool('canban_stop_request', '実行中の依頼を停止', { requestId: { type: 'string' } }, ['requestId'], (a) => dispatcherFor(store).stop(a.requestId)),
  appTool('canban_update_request', '待機中の依頼を編集', { requestId: { type: 'string' }, prompt: { type: 'string' }, order: { type: 'number' } }, ['requestId'], async (a) => (await dispatcherFor(store).requests.update(a.requestId, a))),
  appTool('canban_resume_queue', 'キューを再開', { cardId: { type: 'string' } }, ['cardId'], (a) => dispatcherFor(store).resume(a.cardId)),
  appTool('canban_update_dispatch_settings', '指示の送信の設定を変更', {
    enabled: { type: 'boolean' },
    maxLocal: { type: 'number' },
    maxPerHost: { type: 'number' },
    allowModel: { type: 'boolean' },
    allowModelElevated: { type: 'boolean' },
    modelPerHour: { type: 'number' },
  }, [], (a) => store.updateDispatchSettings(a)),
  {
    name: 'canban_watch',
    title: '変更を待つ',
    description: 'ボードや開いているセッションに変化があるまで待ち、差分を返す（カンバン UI 用のロングポーリング）。',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: ['number', 'null'], description: '前回の seq。null で現在の seq だけ返す' },
        cardId: { type: ['string', 'null'], description: '詳細を開いているセッション（1 件のとき）' },
        offset: { type: ['number', 'null'], description: 'そのセッションのログの読み取り位置' },
        size: { type: ['number', 'null'], description: '前回見たログのサイズ' },
        codexItems: { type: 'boolean' },
        feeds: {
          type: 'array', maxItems: 8, description: '詳細を開いているセッションが複数あるとき。cardId / offset / size / codexItems の組',
          items: { type: 'object', properties: { cardId: { type: 'string' }, offset: { type: ['number', 'null'] }, size: { type: ['number', 'null'] }, codexItems: { type: 'boolean' } }, required: ['cardId'], additionalProperties: false },
        },
        timeoutMs: { type: 'number' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    _meta: appOnly,
    handler: async (args) => {
      if (!watch) return { text: 'live off', structured: { off: true } };
      const r = await watch(args);
      return { text: `seq ${r.seq}${r.reload ? ' reload' : ''} ${r.patches.length} patches${Object.keys(r.feeds || {}).length ? ` ${Object.values(r.feeds).reduce((n, f) => n + f.items.length, 0)} items` : ''}`, structured: r };
    },
  },
  {
    name: 'canban_get_perf',
    title: '動作の重さ',
    description: 'Canban 自身の処理時間（p50 / p95 / 予算）、イベントループ遅延、メモリ、背景処理のリーダーかどうかを返す（カンバン UI 用）',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    _meta: appOnly,
    handler: async () => {
      const p = perf.summary({ leader: leader.isLeader, leaderPid: await leader.owner(), client, live: live ? { active: live.active, seq: live.seq, ...live.counters } : null });
      return { text: `rss ${p.rssMB}MB, loop p99 ${p.loop?.p99 ?? '-'}ms, slow ${p.slow.length}`, structured: p };
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
      const hosts = await hostsWithState((await store.load()));
      return {
        text: hosts.map((h) => `${h.id} ${h.label} ${h.enabled ? 'on' : 'off'} ${h.status.state}${h.status.error ? ` (${h.status.error})` : ''}`).join('\n') || 'リモート接続は登録されていません',
        structured: { hosts: hosts.map(({ sshArgs, ...h }) => h) },
      };
    },
  },
  appTool('canban_set_remote_host', 'リモート接続の読み取りを切り替え', { hostId: { type: 'string' }, enabled: { type: 'boolean' } }, ['hostId', 'enabled'], async (a) => {
    const hosts = await hostsWithState((await store.load()));
    if (!hosts.some((h) => h.id === a.hostId)) throw new Error('Codex に登録されていない接続です');
    return store.setRemoteHost(a);
  }),
  ...accountTools({ store, allSessions, appTool, meta: appAndModel, getLive: () => live }),
  appTool('canban_update_settings', '再開方法の既定を変更', {
    route: { type: 'string', enum: ['desktop', 'terminal'] },
    terminal: { type: 'string', enum: ['ghostty', 'terminal', 'iterm'] },
    target: { type: 'string', enum: ['new-window', 'new-tab', 'split', 'current'] },
  }, [], (a) => store.updateLaunchSettings(a)),
  {
    name: 'canban_create_task',
    title: 'タスクカードを追加',
    description: 'セッションに紐づかないタスクカードを作る（Trello のカードと同じ）。list はリスト ID か名前（省略時は既定のリスト）。',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, list: { type: 'string' }, directory: { type: ['string', 'null'] }, labels: { type: 'array', items: { type: 'string' } }, context: taskContextSchema, clientRequestId: { type: 'string', maxLength: 128 } }, required: ['title'], additionalProperties: false },
    _meta: appAndModel,
    handler: async ({ title, description, list, directory, labels, context, clientRequestId }) => {
      const l = list ? resolveList((await store.load()).lists, list) : null;
      const res = await store.createTask({ title, description, listId: l?.id || list, directory, labels, context, clientRequestId });
      return { text: `タスクカード「${res.title}」を作成しました（${res.cardId}）`, structured: res };
    },
  },
  {
    name: 'canban_start_session',
    title: 'タスクカードからセッションを開始',
    description:
      'タスクカードから Codex / Claude Code の新しいセッションを開始し、開始したセッションを自動でカードに紐付ける。route=desktop はデスクトップアプリ、terminal はターミナル。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        agent: { type: 'string', enum: ['codex', 'claude'] },
        hostId: { type: 'string', description: "'local' またはリモート接続の hostId" },
        cwd: { type: 'string', description: '作業フォルダ（そのマシン上の絶対パス）' },
        prompt: { type: 'string' },
        route: { type: 'string', enum: ['desktop', 'terminal'] },
        terminal: { type: 'string', enum: ['ghostty', 'terminal', 'iterm'] },
        target: { type: 'string', enum: ['new-window', 'new-tab', 'split', 'current'] },
      },
      required: ['taskId', 'agent'],
      additionalProperties: false,
    },
    _meta: appAndModel,
    handler: async ({ taskId, agent, hostId = 'local', cwd = '', prompt, route, terminal, target }) => {
      const state = (await store.load());
      const task = state.cards[taskId];
      if (task?.kind !== 'task') throw new Error('タスクカードが見つかりません');
      let host = LOCAL_HOST;
      let remoteEnabled = true;
      if (hostId && hostId !== 'local') {
        const h = (await hostsWithState(state)).find((x) => x.id === hostId);
        if (!h) throw new Error('Codex に登録されていない接続です');
        host = { id: h.id, alias: h.alias, label: h.label, local: false, sshPort: h.sshPort };
        remoteEnabled = h.enabled;
      }
      const text = String(prompt ?? [task.title, task.description].filter(Boolean).join('\n\n')).slice(0, 8000);
      const prefs = state.settings.launch;
      const useRoute = route || prefs.route;
      let detail;
      if (useRoute === 'desktop') {
        const link = newSessionLink(agent, { host, cwd, prompt: text });
        await openUrl(link.url);
        detail = { route: 'desktop', url: link.url };
      } else {
        const term = terminal || prefs.terminal;
        if (!installedTerminals().some((t) => t.id === term)) throw new Error(`${TERMINAL_LABELS[term] || term} が見つかりません。設定でターミナルを選んでください。`);
        const command = newSessionCommand(agent, { host, cwd, prompt: text });
        detail = { route: 'terminal', command, ...(await runInTerminal({ terminal: term, target: target || prefs.target, command })) };
      }
      await store.updateTask({ cardId: taskId, target: { agent, hostId: host.local === false ? host.id : 'local', cwd } });
      await store.addPending({ taskId, pending: { agent, hostId: host.local === false ? host.id : 'local', cwd, prompt: text.slice(0, 200), startedAt: Date.now() } });
      const note = remoteEnabled ? null : `${host.label} の読み取りがオフのため自動では紐付きません。「マシン」でオンにしてください。`;
      return { text: `${agent === 'codex' ? 'Codex' : 'Claude'} でセッションを開始しました`, structured: { ...detail, note } };
    },
  },
  {
    name: 'canban_link_session',
    title: 'セッションをタスクカードに紐付け',
    description: '既存のセッションをタスクカードに紐付ける（紐付いたセッションはタスクカードの中に表示される）。',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, sessionId: { type: 'string' } }, required: ['taskId', 'sessionId'], additionalProperties: false },
    _meta: appAndModel,
    handler: async (a) => ({ text: '紐付けました', structured: await store.linkSession(a) }),
  },
  appTool('canban_unlink_session', 'セッションの紐付けを解除', { taskId: { type: 'string' }, sessionId: { type: 'string' } }, ['taskId', 'sessionId'], (a) => store.unlinkSession(a)),
  appTool('canban_update_task', 'タスクカードを更新', { cardId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, context: taskContextSchema, directory: { type: ['string', 'null'] }, labels: { type: 'array', items: { type: 'string' } } }, ['cardId'], (a) => store.updateTask(a)),
  appTool('canban_delete_task', 'タスクカードを削除', { cardId: { type: 'string' } }, ['cardId'], (a) => store.deleteTask(a)),
  appTool('canban_clear_pending', '開始待ちを取り消す', { taskId: { type: 'string' } }, ['taskId'], (a) => store.clearPending(a)),
  {
    name: 'canban_get_stats',
    title: '分析',
    description: 'セッション数・トークン量の推移、プロジェクト／カテゴリ／マシン別の内訳、リストの滞留時間、完了までのサイクルタイムを返す。',
    inputSchema: { type: 'object', properties: { days: { type: 'number' }, agent: filterProps.agent, host: filterProps.host, account: filterProps.account, project: filterProps.project, directory: filterProps.directory, includeSubagents: { type: 'boolean' } }, additionalProperties: false },
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
  appTool('canban_update_directory', 'カテゴリを更新', { directoryId: { type: 'string' }, name: { type: 'string' }, color: { type: ['string', 'null'] }, paths: { type: 'array', items: { type: 'string' } } }, ['directoryId'], (a) => store.updateDirectory(a)),
  appTool('canban_delete_directory', 'カテゴリを削除', { directoryId: { type: 'string' } }, ['directoryId'], (a) => store.deleteDirectory(a)),
  appTool('canban_get_ui_state', '共有画面状態を取得', {}, [], () => store.getUiState()),
  appTool('canban_save_ui_state', '共有画面状態を保存', {
    expectedRevision: { type: 'integer', minimum: 0 },
    state: { type: 'object' },
  }, ['expectedRevision', 'state'], ({ expectedRevision, state }) => store.saveUiState({ expectedRevision, state })),
];

// Requests as returned to the UI / model (the prompt is kept; log paths only locally).
function requestView(r) {
  if (!r) return null;
  const { owner, ownerUuid, leaseGeneration, argv, ...rest } = r;
  return { ...rest, logPath: r.hostId === 'local' ? r.logPath ?? null : null };
}

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
  return boardHtml({ version: PKG.version });
}

async function handle(method, params = {}) {
  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      if (params.clientInfo?.name) {
        client = { name: String(params.clientInfo.name), version: String(params.clientInfo.version || '') };
        log('client', client.name, client.version);
      }
      return {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[1],
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: 'canban', title: 'Canban', version: PKG.version, icons: ICONS },
        instructions:
          'Canban: Codex / Claude Code のセッションを Trello 風カンバンで管理する。ボードを見せるときは open_canban を呼ぶ（Codex ではサイドバー、Claude デスクトップでは会話内に表示される）。セッションのファイルは直接変更しない。カードの移動や再開は canban_search で cardId を調べてから canban_move_card / canban_open_session を使う。既存セッションへの指示は canban_send_prompt（エージェント公式 CLI で 1 ターンずつ、権限はそのセッションのまま）で送り、結果は canban_list_requests で確認する。',
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
        return { content: [{ type: 'text', text: err.message || String(err) }], isError: true, structuredContent: err.code ? { error: err.message, code: err.code } : undefined };
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
// ---- background work (leader only) ------------------------------------------
// Codex starts a server per thread and Claude Desktop one more; only one of them (the leader) runs the ticks.
// CANBAN_BACKGROUND=1 forces this process to lead, 0 disables background work.
const RULE_TICK_MS = Number(process.env.CANBAN_RULE_TICK_MS) || 60000;
const DISPATCH_TICK_MS = Number(process.env.CANBAN_DISPATCH_TICK_MS) || 10000;
const bgMode = process.env.CANBAN_BACKGROUND === '1' ? 'always' : process.env.CANBAN_BACKGROUND === '0' ? 'never' : 'auto';
const background = [];
const leader = leaderFor(store.dir, {
  mode: bgMode,
  onChange(isLeader) {
    for (const t of background.splice(0)) clearTimeout(t); // clears intervals too
    if (!isLeader) return;
    log('background leader');
    // Rules keep working while the board is closed (the server lives as long as its host app does).
    background.push(setInterval(() => leader.run(() => tickRules(store)).catch((e) => log('rules:', e.message)), RULE_TICK_MS));
    // Full-text index: first pass shortly after taking the lead, then incremental steps.
    if (process.env.CANBAN_SEARCH_INDEX !== '0') {
      const indexStep = () => leader.run(() => tickSearch(store)).catch((e) => log('search:', e.message));
      background.push(setTimeout(indexStep, 15000), setInterval(indexStep, 60000));
    }
    // Requests: settle finished runs and start queued prompts (idle ticks only stat a file).
    background.push(setInterval(() => leader.run(() => tickDispatch(store)).catch((e) => log('dispatch:', e.message)), DISPATCH_TICK_MS));
    for (const t of background) t.unref();
  },
});
perf.startLoopMonitor();
await leader.start();

log(`started v${PKG.version}`);

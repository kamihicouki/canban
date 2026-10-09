#!/usr/bin/env node
// Canban MCP server (stdio, newline-delimited JSON-RPC 2.0).
// Exposes an MCP App whose `openai/ui` global entrypoint shows up as a Codex sidebar destination.
// Other MCP Apps hosts (Claude Desktop) render the same `ui.resourceUri` inline in the conversation.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { codexLifecycle } from './session-actions.mjs';
import { startDesktopBridge } from './codex-desktop-bridge.mjs';
import { Store } from './store.mjs';
import { leaderFor } from './leader.mjs';
import { perf } from './perf.mjs';
import { dispatcherFor, tickDispatch, setSpawner, dryRunSpawner } from './dispatch.mjs';
import { buildBoard, sessionDetail, allSessions, findSession, hostsWithState, effectiveOrder, dropLocalCache, runRules, tickRules, tickSearch, pool } from './board.mjs';
import { isCloudSession, CLOUD_OPERATION_REASON } from './sources/codex-dots.mjs';
import { RULE_TRIGGERS } from './store.mjs';
import { computeStats } from './stats.mjs';
import { desktopLink, resumeCommand, newSessionLink, newSessionCommand } from './agents.mjs';
import { LOCAL_HOST } from './sources/util.mjs';
import { openUrl, openExternal, runInTerminal, installedTerminals, setRunner, TERMINAL_LABELS } from './launcher.mjs';
import { LiveHub } from './live.mjs';
import { createWatch } from './watch.mjs';
import { Presence, appLabel } from './presence.mjs';
import { codexHome } from './sources/codex.mjs';
import { claudeHome, claudeDesktopSessionsDir } from './sources/claude.mjs';
import { accountTools, accountFilterProp, accountDesktopNote, extraWatchRoots } from './accounts-mcp.mjs';
import { accountActions, accountActionTools } from './account-actions.mjs';
import { shutdownLogins } from './login.mjs';
import { boardHtml } from './ui.mjs';
import { taskContextSchema } from './task-context.mjs';
import { uploadImage, promptImages, listSkills, withSkills, withImagePaths, remoteImages } from './prompt-input.mjs';
import { resolveSession, inspect, timingProblem } from './dispatch.mjs';
import { claudeExecutionSession, savedClaudeExecutionSession } from './claude-handoff.mjs';
import { desktopProfilePlan, withDesktopAccount, saveClaudeExecutionAccount, desktopExecutionLink } from './claude-desktop-profile.mjs';
import { SlackService, slackTools } from './slack.mjs';
import { listChanges, fileDiff } from './changes.mjs';
import { attachSummaryCache } from './summary-cache.mjs';
import { loopArtifact } from './loop-artifact.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// The Codex plugin manifest is absent when installed another way (Claude Desktop extension, a bare copy).
const PKG = readManifest(['.codex-plugin', 'plugin.json'], ['package.json']);
const UI_URI = 'ui://canban/board.html';
const UI_MIME = 'text/html;profile=mcp-app';
// A capability for the rendered UI, never included in tools/list or model tool results.
// Native Messaging stamps it at the trusted Chrome bridge; MCP Apps receive it in their resource.
const uiToken = process.env.CANBAN_UI_TOKEN || randomBytes(32).toString('hex');
delete process.env.CANBAN_UI_TOKEN; // No launcher, terminal, or supervised agent inherits UI authority.
const requireLoopUi = a => {
  if (a.uiToken !== uiToken) throw new Error('この操作はボードUIから確認してください');
  const { uiToken: omitted, ...args } = a;
  return args;
};
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
attachSummaryCache(store.dir); // Claude transcript summaries survive a restart: only new lines are read
const desktopBridge = await startDesktopBridge({ dataDir: store.dir }).catch(error => {
  process.stderr.write(`[canban] Codex連携: ${error.message}\n`);
  return null;
});

const slack = new SlackService(store);
// Realtime: watches nothing until a board calls canban_watch (see server/live.mjs).
const live = process.env.CANBAN_LIVE === '0' ? null : new LiveHub({ dataDir: store.dir, codexHome: codexHome(), claudeProjects: path.join(claudeHome(), 'projects'), claudeDesktop: claudeDesktopSessionsDir(), extraRoots: extraWatchRoots(store) });
if (live) pool.onLate = () => live.emit('store', store.dir); // a slow SSH host answered: rebuild the board
const watch = live ? createWatch(live, { presence: new Presence(store.dir, { app: () => appLabel(client) }) }) : null;
const accountsActions = accountActions({ store, allSessions, getLive: () => live });
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
  dotScope: { type: 'string', enum: ['exclude', 'all', 'only'], description: 'dotのセッション: 除く（既定）／含める／dotだけ' },
  pinnedOnly: { type: 'boolean', description: 'Codex アプリでピン留めしたスレッドだけ' },
  groupBranch: { type: 'boolean', description: '同じリポジトリ＋ブランチのセッションをまとめる' },
  fulltext: { type: 'boolean', description: 'q を会話の本文でも検索する（3 文字以上）' },
  days: { type: 'number', description: '未配置セッションの表示期間（日）。0 で無制限。既定 30' },
};

const loopCommandProps = { taskId: { type: 'string' }, expectedRevision: { type: 'integer', minimum: 0 }, commandId: { type: 'string' }, command: { type: 'object' } };
async function loopCommand(args, source) {
  const prior = await store.getLoop({ taskId: args.taskId });
  if (args.command.type === 'start') {
    const task = (await store.load()).cards[args.taskId];
    const taskHost = task.context?.host || task.target?.host || 'local';
    let cwd = taskHost === 'local' ? task.context?.cwd || task.target?.cwd : null;
    if (!cwd && task.links?.length) {
      try { const r = await findSession(store, task.links[0]); if (r.session.host?.local !== false) cwd = r.session.cwd; } catch {}
    }
    const artifactRef = await loopArtifact(cwd);
    args.command = { ...args.command, artifactFolder: artifactRef ? cwd : null, startedArtifactRef: artifactRef };
  }
  if (['record', 'confirm'].includes(args.command.type)) {
    const c = prior.cycles.find(c => c.id === args.command.cycleId);
    const round = c?.rounds.at(-1);
    if (round?.artifactFolder) {
      const ref = await loopArtifact(round.artifactFolder);
      if (!ref || args.command.artifactRef !== ref) throw new Error('成果物が変わったか、版を確認できません。最新の版を読み直して検証してください');
    }
  }
  const result = await store.loopCommand({ ...args, source });
  if (result.saved && args.command.type === 'pause') {
    const requests = await dispatcherFor(store).requests.list();
    for (const r of requests.filter(r => r.state === 'queued' && r.loopContext?.taskId === args.taskId && r.loopContext?.cycleId === args.command.cycleId)) await dispatcherFor(store).requests.cancel(r.id);
  }
  return { text: result.conflict ? '別の画面で更新されています。最新の状態を確認してください' : 'ループを保存しました', structured: result };
}
const TOOLS = [
  ...slackTools({ service: slack, store, appTool, validateCard: async cardId => {
    if (cardId.startsWith('task:')) { const card = (await store.load()).cards[cardId]; if (card?.kind !== 'task') throw new Error('タスクカードが見つかりません'); return card.title; }
    else return (await findSession(store, cardId)).session.title;
  } }),
  appTool('canban_upload_prompt_image', 'プロンプトに画像を添付', {
    id: { type: 'string' }, offset: { type: 'integer' }, data: { type: 'string' },
    name: { type: 'string' }, mime: { type: 'string' }, size: { type: 'integer' },
  }, ['data'], a => uploadImage(store.dir, a)),
  appTool('canban_prompt_skills', '利用できるスキルを取得', {
    cardId: { type: 'string' }, agent: { type: 'string', enum: ['codex', 'claude'] },
    hostId: { type: 'string' }, cwd: { type: 'string' },
  }, [], async a => {
    let context = a, host = null;
    if (a.cardId) {
      const resolved = await resolveSession(store, a.cardId);
      context = resolved.session; host = resolved.host;
      if (isCloudSession(context)) return { skills: [], reason: CLOUD_OPERATION_REASON };
    } else if (a.hostId && a.hostId !== 'local') {
      host = (await hostsWithState(await store.load())).find(h => h.id === a.hostId);
      if (!host) throw new Error('Codex に登録されていない接続です');
    }
    if (!host) return { skills: listSkills(context) };
    const result = await pool.dispatch(host, { mode: 'prompt_skills', agent: context.agent || 'codex', cwd: context.cwd || '', homeDir: context.homeDir });
    if (!result.ok) throw new Error(result.error || '接続先のスキルを取得できません');
    return { skills: result.skills || [] };
  }),
  appTool('canban_get_changes', '作業フォルダの変更を取得', { cardId: { type: 'string' }, path: { type: 'string' } }, ['cardId'], async ({ cardId, path: file }) => {
    const { session, host } = await findSession(store, cardId);
    if (isCloudSession(session)) return { available: false, reason: CLOUD_OPERATION_REASON };
    if (host) return { available: false, reason: 'リモートのセッションの変更はまだ表示できません' };
    if (file) return { available: true, diff: await fileDiff(session.cwd, file) };
    return listChanges(session.cwd);
  }),
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
      },
      required: ['cardId'],
      additionalProperties: false,
    },
    _meta: appAndModel,
    handler: async (args) => ({ text: 'カードを更新しました', structured: await store.updateCard(args) }),
  },
  {
    name: 'canban_set_claude_execution',
    title: 'Claude の実行アカウントを保存',
    description: '同じ会話の再開・送信に使うアカウントを保存する。ログイン済み Desktop プロフィールがある場合は通常起動も同じアカウントへ切り替える。Desktop 起動中でも CLI の選択は保存し、Desktop は適用待ちとして返す。認証情報や会話は移動しない。',
    inputSchema: {
      type: 'object', properties: { cardId: { type: 'string' }, claudeHome: { type: ['string', 'null'] }, account: { type: ['string', 'null'] } },
      required: ['cardId', 'claudeHome', 'account'], additionalProperties: false,
    },
    _meta: appOnly,
    handler: async ({ cardId, claudeHome, account }) => {
      const { session: source } = await findSession(store, cardId);
      if (source.agent !== 'claude' || source.host?.local === false) throw new Error('このマシンの Claude Code セッションを選んでください');
      if (!claudeHome) {
        await store.setClaudeExecution({ cardId, execution: null });
        return { text: '元の CLI 設定に戻しました。Desktop のプロフィールは現在の選択を維持します', structured: { execution: null, desktop: null } };
      }
      if (!account) throw new Error('選択したアカウントを確認できません。実行アカウントを選び直してください');
      const session = await claudeExecutionSession(source, claudeHome, account);
      const problem = timingProblem(source, await inspect(source, null));
      if (problem) throw new Error(`${problem}。停止してから実行アカウントを選んでください`);
      const requests = await dispatcherFor(store).requests.list({ cardId });
      if (requests.some(r => ['queued', 'starting', 'running'].includes(r.state))) throw new Error('待機中または実行中の指示があります。完了または取消後に実行アカウントを選んでください');
      const execution = { homeId: session.home, account: session.executionAccount };
      const result = await saveClaudeExecutionAccount(account, async () => {
        await claudeExecutionSession(source, session.home, account);
        return store.setClaudeExecution({ cardId, execution });
      });
      return { text: result.desktop.maintained ? 'CLI と Desktop の実行アカウントを保存しました' : `CLI の実行アカウントを保存しました。${result.desktop.reason}`, structured: result };
    },
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
        claudeHome: { type: 'string', description: 'Claude の実行アカウント（launch.claudeAccounts の ID）。省略時は保存した選択。空文字は元の CLI 設定' },
      },
      required: ['cardId'],
      additionalProperties: false,
    },
    _meta: appAndModel,
    handler: async ({ cardId, route, terminal, target, claudeHome }) => {
      const { session: source, state } = await findSession(store, cardId);
      if (isCloudSession(source) && route === 'terminal') throw new Error(CLOUD_OPERATION_REASON);
      const session = await savedClaudeExecutionSession(source, state, claudeHome);
      const selected = !!session.executionAccount;
      if (selected) {
        const problem = timingProblem(source, await inspect(source, null));
        if (problem) throw new Error(`${problem}。停止してからアカウントを選んで再開してください`);
        const requests = await dispatcherFor(store).requests.list({ cardId });
        if (requests.some(r => ['queued', 'starting', 'running'].includes(r.state))) throw new Error('このセッションには待機中または実行中の指示があります。完了または取消後に再開してください');
      }
      await store.markSeen({ cardId });
      const prefs = state.settings.launch;
      let useRoute = isCloudSession(session) ? 'desktop' : selected && !route ? 'terminal' : route || prefs.route;
      const link = selected ? await desktopExecutionLink(source, session.executionAccount) : desktopLink(session);
      if (selected && useRoute === 'desktop' && !link) throw new Error('Desktop からこの会話を取り込めません。同じ会話をターミナルで再開してください');
      if (useRoute === 'desktop' && !link) {
        if (route === 'desktop') throw new Error('このセッションはデスクトップアプリでは開けません。ターミナルで再開してください。');
        useRoute = 'terminal';
      }
      // Claude desktop signed in to another account would not find the session: the
      // default route resumes it in the terminal instead (an explicit desktop still opens).
      const accountNote = selected ? null : accountDesktopNote(session, state.settings.accounts.labels);
      if (useRoute === 'desktop' && accountNote && !route) useRoute = 'terminal';
      if (useRoute === 'desktop') {
        if (selected) await withDesktopAccount(session.executionAccount, async () => {
          await claudeExecutionSession(source, session.home, session.executionAccount);
          await openUrl(link.url);
        });
        else await openUrl(link.url);
        const note = accountNote || link.note || null;
        return { text: `${link.label}: ${link.url}${accountNote ? `\n${note}` : ''}`, structured: { route: 'desktop', url: link.url, exact: link.exact, note, executionAccount: session.executionAccount || null } };
      }
      const term = terminal || prefs.terminal;
      if (!installedTerminals().some((t) => t.id === term)) throw new Error(`${TERMINAL_LABELS[term] || term} が見つかりません。設定でターミナルを選んでください。`);
      const command = resumeCommand(session);
      const res = await runInTerminal({ terminal: term, target: target || prefs.target, command });
      return { text: `${TERMINAL_LABELS[term]} で再開: ${command}`, structured: { route: 'terminal', command, executionAccount: session.executionAccount || null, ...res } };
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
        claudeHome: { type: 'string', description: 'Claude の実行アカウント（launch.claudeAccounts の ID）' },
      },
      required: ['cardId', 'prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    _meta: appAndModel,
    handler: async ({ cardId, prompt, when = 'queue', claudeHome }) => {
      const r = await dispatcherFor(store).submit({ cardId, prompt, when, claudeHome, origin: 'model' });
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
        claudeHome: { type: 'string' },
        prompt: { type: 'string' },
        imageIds: { type: 'array', items: { type: 'string' }, maxItems: 8 },
        skills: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string' } }, required: ['name', 'path'], additionalProperties: false }, maxItems: 20 },
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
  ...accountActionTools({ actions: accountsActions, store, appTool }),
  appTool('canban_update_settings', '再開方法の既定を変更', {
    route: { type: 'string', enum: ['desktop', 'terminal'] },
    terminal: { type: 'string', enum: ['ghostty', 'terminal', 'iterm'] },
    target: { type: 'string', enum: ['new-window', 'new-tab', 'split', 'current'] },
    linkBrowser: { type: 'string', enum: ['', 'chrome', 'safari'] },
    linkProfile: { type: 'string', maxLength: 40 },
  }, [], (a) => store.updateLaunchSettings(a)),
  appTool('canban_open_external', '設定したブラウザで URL を開く', { url: { type: 'string', maxLength: 2000 } }, ['url'],
    async ({ url }) => { await openExternal(url, (await store.load()).settings.launch); return { opened: true }; }),
  {
    name: 'canban_create_task',
    title: 'タスクカードを追加',
    description: 'セッションに紐づかないタスクカードを作る（Trello のカードと同じ）。list はリスト ID か名前（省略時は既定のリスト）。',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, list: { type: 'string' }, directory: { type: ['string', 'null'] }, labels: { type: 'array', items: { type: 'string' } }, context: taskContextSchema, clientRequestId: { type: 'string', maxLength: 128 }, slackSource: { type: 'string', maxLength: 120 } }, required: ['title'], additionalProperties: false },
    _meta: appAndModel,
    handler: async ({ title, description, list, directory, labels, context, clientRequestId, slackSource }) => {
      const l = list ? resolveList((await store.load()).lists, list) : null;
      const res = await store.createTask({ title, description, listId: l?.id || list, directory, labels, context, clientRequestId, slackSource });
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
        imageIds: { type: 'array', items: { type: 'string' }, maxItems: 8 },
        skills: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string' } }, required: ['name', 'path'], additionalProperties: false }, maxItems: 20 },
        route: { type: 'string', enum: ['desktop', 'terminal'] },
        terminal: { type: 'string', enum: ['ghostty', 'terminal', 'iterm'] },
        target: { type: 'string', enum: ['new-window', 'new-tab', 'split', 'current'] },
      },
      required: ['taskId', 'agent'],
      additionalProperties: false,
    },
    _meta: appAndModel,
    handler: async ({ taskId, agent, hostId = 'local', cwd = '', prompt, imageIds = [], skills = [], route, terminal, target }) => {
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
      const rawPrompt = String(prompt ?? [task.title, task.description, task.note].filter(Boolean).join('\n\n'));
      if (rawPrompt.length > 20000) throw new Error('依頼文は20000文字までです');
      const skillPrompt = withSkills(rawPrompt, skills);
      const localImages = promptImages(store.dir, imageIds);
      const images = host.local === false ? await remoteImages(store.dir, localImages, host, pool) : localImages;
      const text = withImagePaths(skillPrompt, images);
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
        const command = newSessionCommand(agent, { host, cwd, prompt: agent === 'codex' ? skillPrompt : text, images });
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
    handler: async (a) => {
      const { sessions } = await allSessions(await store.load());
      const session = sessions.find(s => s.id === a.sessionId);
      if (!session) throw new Error('セッションが見つかりません');
      if (session.subagent) throw new Error('タスクには通常のセッションを紐付けてください。サブエージェントは親セッションから参照できます。');
      return { text: '紐付けました', structured: await store.linkSession(a) };
    },
  },
  appTool('canban_unlink_session', 'セッションの紐付けを解除', { taskId: { type: 'string' }, sessionId: { type: 'string' } }, ['taskId', 'sessionId'], (a) => store.unlinkSession(a)),
  appTool('canban_update_task', 'タスクカードを更新', { cardId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, context: taskContextSchema, directory: { type: ['string', 'null'] }, labels: { type: 'array', items: { type: 'string' } } }, ['cardId'], (a) => store.updateTask(a)),
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
  appTool('canban_delete_task', 'タスクカードを削除', { cardId: { type: 'string' } }, ['cardId'], (a) => store.deleteTask(a)),
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
  {
    name: 'canban_get_loop', title: '改善ループを取得', description: '目標、版付きの条件、大小2段のループと追記した周回・検証根拠を返す。CLIの正常終了は合格と扱わない。',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false },
    annotations: { readOnlyHint: true }, _meta: appAndModel,
    handler: async a => {
      const record = await store.getLoop(a);
      const refs = new Map();
      for (const c of record.cycles) {
        const last = c.rounds.at(-1);
        if (last?.artifactFolder) {
          if (!refs.has(last.artifactFolder)) refs.set(last.artifactFolder, await loopArtifact(last.artifactFolder));
          c.currentArtifactRef = refs.get(last.artifactFolder);
          c.stale = !!last.results && c.currentArtifactRef !== last.artifactRef;
        }
      }
      return { text: '改善ループ', structured: record };
    },
  },
  {
    name: 'canban_loop_command', title: '改善ループを進める',
    description: 'expectedRevisionと一意なcommandIdを指定。command: configure(goal, criteria文字列配列, principles, maxRounds, 任意cycleId/parentId)、start(cycleId,nextAction)、record(cycleId,roundId,version,artifactRef,results:[criterionId,pass:true/false/null,summary,ref],learning)、pause/resume(cycleId)。エージェントの検証結果は報告として保存され、人の確認まで完了にはしない。送信はUIで人が行う。',
    inputSchema: { type: 'object', properties: loopCommandProps, required: Object.keys(loopCommandProps), additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false }, _meta: appAndModel,
    handler: async a => loopCommand(a, 'reported'),
  },
  {
    name: 'canban_review_loop', title: '改善ループを確認（UI）',
    inputSchema: { type: 'object', properties: { ...loopCommandProps, uiToken: { type: 'string' } }, required: [...Object.keys(loopCommandProps), 'uiToken'], additionalProperties: false },
    _meta: appOnly, handler: async a => loopCommand(requireLoopUi(a), 'human'),
  },
  {
    name: 'canban_send_loop', title: 'この周回の指示を送る（UI）',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, cycleId: { type: 'string' }, roundId: { type: 'string' }, expectedRevision: { type: 'integer' }, cardId: { type: 'string' }, prompt: { type: 'string' }, uiToken: { type: 'string' } }, required: ['taskId','cycleId','roundId','expectedRevision','cardId','prompt','uiToken'], additionalProperties: false },
    _meta: appOnly,
    handler: async a => {
      const { taskId, cycleId, roundId, expectedRevision, cardId, prompt } = requireLoopUi(a);
      const r = await dispatcherFor(store).submit({ cardId, prompt, when: 'queue', origin: 'ui', loopContext: { taskId, cycleId, roundId, expectedRevision } });
      return { text: `この周回の依頼（${r.id}）`, structured: requestView(r) };
    },
  },
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
  return boardHtml({ version: PKG.version, uiToken });
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
              ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: ['blob:', 'data:'] } },
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
  slack.stop();
  await Promise.allSettled([...pending]);
  await shutdownLogins();
  await desktopBridge?.close();
  // Exit only after stdout has flushed; large responses are written asynchronously to pipes.
  process.stdout.write('', () => process.exit(0));
});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
  slack.stop();
  await shutdownLogins();
  await desktopBridge?.close();
  process.exit(0);
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
    if (!isLeader) slack.closeSockets();
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
  if (process.env.CANBAN_LAUNCH_DRYRUN !== '1') background.push(setInterval(() => leader.run(() => accountsActions.refresh({ automatic: true })).catch(() => log('account usage: update failed')), 30000));
    for (const t of background) t.unref();
  },
});
perf.startLoopMonitor();
await leader.start();
await slack.start(leader);

log(`started v${PKG.version}`);

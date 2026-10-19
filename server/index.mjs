#!/usr/bin/env node
// Canban MCP server (stdio, newline-delimited JSON-RPC 2.0).
// Exposes an MCP App whose `openai/ui` global entrypoint shows up as a Codex sidebar destination.
// Other MCP Apps hosts (Claude Desktop) render the same `ui.resourceUri` inline in the conversation.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startDesktopBridge } from './codex-desktop-bridge.mjs';
import { Store } from './store.mjs';
import { leaderFor } from './leader.mjs';
import { perf } from './perf.mjs';
import { dispatcherFor, tickDispatch, setSpawner, dryRunSpawner } from './dispatch.mjs';
import { allSessions, findSession, hostsWithState, tickRules, tickSearch, pool } from './board.mjs';
import { newSessionLink, preparedCodexLink } from './agents.mjs';
import { LOCAL_HOST } from './sources/util.mjs';
import { setRunner } from './launcher.mjs';
import { LiveHub } from './live.mjs';
import { createWatch } from './watch.mjs';
import { Presence, appLabel } from './presence.mjs';
import { codexHome } from './sources/codex.mjs';
import { claudeHome, claudeDesktopSessionsDir } from './sources/claude.mjs';
import { accountTools, extraWatchRoots } from './accounts-mcp.mjs';
import { accountLabel, configureDesktopStorage } from './accounts.mjs';
import { recoverGuests, setGuestRunningCheck, guestPaths, desktopRunning } from './claude-desktop-guests.mjs';
import { openDesktopApp } from './claude-desktop-open.mjs';
import { accountActions, accountActionTools } from './account-actions.mjs';
import { shutdownLogins } from './login.mjs';
import { boardHtml } from './ui.mjs';
import { prepareLaunchSelection, launchEvidence } from './launch-selection.mjs';
import { promptImages, withSkills } from './prompt-input.mjs';
import { inspect, timingProblem } from './dispatch.mjs';
import { startAccount } from './start-account.mjs';
import { claudeEnvironments, codexLaunchTargets } from './sources/launch-targets.mjs';
import { setCloudRunner } from './codex-cloud.mjs';
import { resolveSshTarget, matchDesktopTarget } from './sources/ssh-targets.mjs';
import { prepareCodexDesktop } from './codex-desktop-start.mjs';
import { readDesktopCapabilities } from './desktop-capabilities.mjs';
import { managedDesktopSetup } from './claude-desktop-profile.mjs';
import { createClaudeDesktopResume } from './claude-desktop-resume.mjs';
import { rememberDesktopAccount } from './desktop-account-setup.mjs';
import { createDesktopLaunches } from './desktop-launch.mjs';
import { withDesktopAccount } from './claude-desktop-profile.mjs';
import { SlackService, slackTools } from './slack.mjs';
import { Terminals } from './terminal.mjs';
import { attachSummaryCache } from './summary-cache.mjs';
import { appAndModel, appTool } from './tools/shared.mjs';
import { promptTools, promptImageTools } from './tools/prompt.mjs';
import { workspaceTools } from './tools/workspace.mjs';
import { boardTools, statsTools, boardConfigTools } from './tools/board.mjs';
import { sessionTools } from './tools/sessions.mjs';
import { systemTools, settingsTools } from './tools/system.mjs';
import { createTaskTools, taskTools } from './tools/tasks.mjs';
import { startTools } from './tools/start.mjs';
import { desktopTools } from './tools/desktop.mjs';
import { loopTools } from './tools/loop.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// The Codex plugin manifest is absent when installed another way (Claude Desktop extension, a bare copy).
const PKG = readManifest(['.codex-plugin', 'plugin.json'], ['package.json']);
const UI_URI = 'ui://canban/board.html';
const UI_MIME = 'text/html;profile=mcp-app';
// A capability for the rendered UI, never included in tools/list or model tool results.
// Native Messaging stamps it at the trusted Chrome bridge; MCP Apps receive it in their resource.
const uiToken = process.env.CANBAN_UI_TOKEN || randomBytes(32).toString('hex');
delete process.env.CANBAN_UI_TOKEN; // No launcher, terminal, or supervised agent inherits UI authority.
const terminals = new Terminals();
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
configureDesktopStorage(store.dir);
attachSummaryCache(store.dir); // Claude transcript summaries survive a restart: only new lines are read
// Integrated Desktop sidebar: the ledger lives with the data, and the watcher inherits it.
process.env.CANBAN_DESKTOP_GUESTS_DIR ||= path.join(store.dir, 'desktop-integrated');
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
// It never touches the real integrated-sidebar state or reads the real Desktop process:
// Desktop counts as running, so no guests are placed.
if (process.env.CANBAN_LAUNCH_DRYRUN === '1') {
  process.env.CANBAN_DESKTOP_GUESTS_DIR = path.join(store.dir, 'desktop-integrated');
  setGuestRunningCheck(async () => true);
  setRunner(async (file, args) => log('dry-run:', file, ...args));
  setSpawner(dryRunSpawner(log));
  setCloudRunner(async (command) => { log('dry-run:', command); return 'https://chatgpt.com/codex/tasks/task_e_dryrun\n'; });
}
// After the dry-run setup, so a dry run never tidies the real integrated-sidebar state.
recoverGuests().then(r => (r?.restored || r?.tidied) && process.stderr.write(`[canban] Desktop の統合を片付けました（書き戻し ${r.restored || 0} 件・台帳にない複製 ${r.tidied || 0} 件）\n`), error => process.stderr.write(`[canban] Desktop の統合の片付け: ${error.message}\n`));

// Re-resolve persisted Desktop starts on every resume; no closure over stale targets.
const desktopResume = createClaudeDesktopResume({ paths: guestPaths(), findSession: async cardId => (await findSession(store, cardId)).session,
  check: async source => timingProblem(source, await inspect(source, null)), requests: async cardId => dispatcherFor(store).requests.list({ cardId }) });
async function resolveDesktopStart(input) {
  if (input.operation === 'resume') return desktopResume.resolve(input);
  const state = await store.load();
  if (input.taskId && state.cards[input.taskId]?.kind !== 'task') throw new Error('タスクカードが見つかりません');
  const selection = await prepareLaunchSelection({ ...input, route: 'desktop' }, { codex: await codexLaunchTargets() });
  let host = LOCAL_HOST, cwd = input.cwd || '', projectId = null;
  if (input.environmentId) {
    const env = (await claudeEnvironments(guestPaths().app, { expectedAccount: input.account, dataDir: store.dir })).environments.find(e => e.id === input.environmentId);
    if (input.agent !== 'claude' || !env) throw new Error('Claude Desktop の環境を確認してください');
    cwd = env.cwd;
    if (env.kind === 'ssh') {
      const match = await matchDesktopTarget({ requested: { alias: env.sshHost, port: env.sshPort }, codexHosts: await hostsWithState(state) });
      const known = match.state === 'resolved' ? match.codexHost : null;
      host = { id: known?.id || env.sshHost, alias: env.sshHost, label: known?.label || env.sshLabel, local: false, sshPort: env.sshPort ?? null };
    }
  } else {
    let hostId = input.hostId || 'local';
    if (input.projectId) {
      const project = (await codexLaunchTargets()).projects.find(p => p.id === input.projectId);
      if (input.agent !== 'codex' || !project) throw new Error('Codex のプロジェクトを確認してください');
      cwd = project.root; hostId = project.hostId; projectId = hostId === 'local' ? project.id : null;
    }
    if (hostId !== 'local') {
      const known = (await hostsWithState(state)).find(h => h.id === hostId);
      if (!known) throw new Error('登録済みの接続を確認してください');
      host = { ...known, local: false };
    }
  }
  if (input.agent === 'claude' && host.local === false && !input.environmentId) {
    const environments = (await claudeEnvironments(guestPaths().app, { expectedAccount: input.account, dataDir: store.dir })).environments.filter(e => e.kind === 'ssh');
    const match = await matchDesktopTarget({ requested: { alias: host.alias, hostname: host.hostname, port: host.sshPort }, claudeEnvironments: environments });
    if (match.state !== 'resolved' || !match.claudeEnvironment) throw new Error('同じ接続先のClaude環境を確認し、環境を選んでください');
    host = { ...host, alias: match.claudeEnvironment.sshHost, sshPort: match.claudeEnvironment.sshPort ?? null };
  }
  if (cwd && (!cwd.startsWith('/') || cwd.includes('\0') || cwd.length > 4096)) throw new Error('作業フォルダを確認してください');
  const remoteCodex = input.agent === 'codex' && host.local === false;
  let sshIdentity = null;
  if (remoteCodex) {
    if (!(await readDesktopCapabilities(store.dir)).codexRemote) throw new Error('このDesktopでのリモート下書き表示は未確認です');
    sshIdentity = await resolveSshTarget({ alias: host.alias, hostname: host.hostname, port: host.sshPort });
    if (sshIdentity.state !== 'resolved' || !cwd) throw new Error('SSHの接続先と作業フォルダを確認してください');
  } else newSessionLink(input.agent, { host, cwd, prompt: input.prompt, projectId });
  promptImages(store.dir, input.imageIds || []); withSkills(input.prompt, input.skills || []);
  if (input.agent === 'codex') await startAccount({ agent: input.agent, account: input.account, host, route: 'desktop', labels: state.settings.accounts.labels });
  return { host, cwd, projectId, account: input.account || null, prepareThread: remoteCodex, sshIdentity, selection };
}
const desktopLaunches = createDesktopLaunches({
  dataDir: store.dir, resolveTarget: resolveDesktopStart,
  recordSelection: async (input, target) => {
    if (input.operation === 'resume') return { cardId: input.cardId, conversationId: target.desktopSessionId, nativeId: target.nativeId };
    const evidence = launchEvidence(target.selection, input.clientRequestId);
    if (input.taskId) await store.recordLaunch({ taskId: input.taskId, ...evidence });
    return evidence;
  },
  accounts: { withAccount: (account, options, action) => withDesktopAccount(account, action, options) },
  prepareOpen: async (input, target) => input.operation === 'resume' && target.owner !== input.account && await desktopRunning()
    ? { state: 'waiting-for-quit', reason: 'Desktop を保存して終了すると、選択したアカウントで同じ会話を開きます' } : null,
  prepareThread: async (input, target) => process.env.CANBAN_LAUNCH_DRYRUN === '1'
    ? { state: 'prepared', threadId: randomUUID(), hostId: target.host.id, cwd: target.cwd, writerClosed: true, dryRun: true }
    : prepareCodexDesktop({ host: target.host, cwd: target.cwd, clientRequestId: input.clientRequestId }, { pool }),
  open: async (input, target, thread) => {
    const state = await store.load(), labels = state.settings.accounts.labels;
    if (input.operation === 'resume') {
      const integrated = await openDesktopApp(target.url, { guestSessionId: target.owner !== input.account ? target.desktopSessionId : null, labelOf: a => accountLabel(`claude:${a}`, labels).replace(/@.*/, '') });
      if (!integrated.opened) return { notOpened: true, state: integrated.code === 'desktop_running' ? 'waiting-for-quit' : 'failed', reason: integrated.reason };
      await rememberDesktopAccount({ dataDir: store.dir, appDir: guestPaths().app, account: input.account });
      await store.markSeen({ cardId: input.cardId });
      return { url: target.url, exact: true, cwd: target.cwd, desktopAccount: input.account, note: target.importCLI ? '同じ CLI 会話IDの履歴を Desktop に取り込みました。続きはアプリで確認してください。' : '元の会話ID・履歴・作業先で開きました。続きは Desktop で確認してください。' };
    }
    const skillPrompt = withSkills(input.prompt, input.skills || []);
    const localImages = promptImages(store.dir, input.imageIds || []);
    const text = skillPrompt;
    const link = target.prepareThread ? preparedCodexLink(thread, { prompt: text }) : newSessionLink(input.agent, { ...target, prompt: text });
    const integrated = await openDesktopApp(link.url, { labelOf: a => accountLabel(`claude:${a}`, labels).replace(/@.*/, '') });
    if (input.agent === 'claude' && input.account) await rememberDesktopAccount({ dataDir: store.dir, appDir: guestPaths().app, account: input.account });
    if (input.taskId) {
      await store.updateTask({ cardId: input.taskId, target: { agent: input.agent, hostId: target.host.id, cwd: target.cwd, account: input.account } });
      await store.addPending({ taskId: input.taskId, pending: { agent: input.agent, hostId: target.host.id, cwd: target.cwd, prompt: text.slice(0,200), startedAt: Date.now() } });
    }
    return { attachmentCopyAvailable: (await readDesktopCapabilities(store.dir)).clipboardImages, url: link.url, hostId: target.host.id, cwd: target.cwd, ...(thread ? { threadId: thread.threadId } : {}), note: '新規画面を開きました。依頼の送信と実行状況はアプリで確認してください。', integrated: integrated && { ok: integrated.ok, placed: integrated.placed || 0, code: integrated.code || null, reason: integrated.reason || null } };
  },
});
desktopLaunches.recover().catch(() => log('Desktop の開始記録を確認できません'));
const desktopSetup = managedDesktopSetup(store.dir);
if (process.env.CANBAN_BACKGROUND !== '0') {
  let resuming = false;
  setInterval(async () => {
    if (resuming) return;
    resuming = true;
    try { await desktopSetup.recover(); await desktopLaunches.recover(); } catch {} finally { resuming = false; }
  }, 5000).unref();
}

// ---- tool definitions ----------------------------------------------------
// Each group lives in server/tools/ and takes the runtime pieces it needs; the order is the tools/list order.
const toolContext = {
  store, ICONS, UI_URI, requireLoopUi, terminals, watch, live, desktopSetup, desktopLaunches, resolveDesktopStart,
  getLeader: () => leader, getClient: () => client,
};
const TOOLS = [
  ...slackTools({ service: slack, store, appTool, validateCard: async cardId => {
    if (cardId.startsWith('task:')) { const card = (await store.load()).cards[cardId]; if (card?.kind !== 'task') throw new Error('タスクカードが見つかりません'); return card.title; }
    else return (await findSession(store, cardId)).session.title;
  } }),
  ...promptTools(toolContext),
  ...workspaceTools(toolContext),
  ...boardTools(toolContext),
  ...sessionTools(toolContext),
  ...systemTools(toolContext),
  ...accountTools({ store, allSessions, appTool, meta: appAndModel, getLive: () => live }),
  ...accountActionTools({ actions: accountsActions, store, appTool }),
  ...settingsTools(toolContext),
  ...createTaskTools(toolContext),
  ...startTools(toolContext),
  ...promptImageTools(toolContext),
  ...desktopTools(toolContext),
  ...taskTools(toolContext),
  ...loopTools(toolContext),
  ...statsTools(toolContext),
  ...boardConfigTools(toolContext),
];

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
  terminals.closeAll();
  await Promise.allSettled([...pending]);
  await shutdownLogins();
  await desktopBridge?.close();
  // Exit only after stdout has flushed; large responses are written asynchronously to pipes.
  process.stdout.write('', () => process.exit(0));
});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
  slack.stop();
  terminals.closeAll();
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

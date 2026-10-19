// Starting new sessions: launch targets and canban_start_session (desktop, terminal, Codex Cloud).
import { randomBytes } from 'node:crypto';
import { hostsWithState, pool } from '../board.mjs';
import { newSessionCommand } from '../agents.mjs';
import { LOCAL_HOST } from '../sources/util.mjs';
import { runInTerminal, installedTerminals, TERMINAL_LABELS, launchOnce } from '../launcher.mjs';
import { guestPaths } from '../claude-desktop-guests.mjs';
import { integratedNote } from '../claude-desktop-open.mjs';
import { prepareLaunchSelection, launchEvidence } from '../launch-selection.mjs';
import { sourceRefSchema } from '../category-bindings.mjs';
import { promptImages, withSkills, withImagePaths, remoteImages } from '../prompt-input.mjs';
import { startAccount } from '../start-account.mjs';
import { claudeEnvironments, codexLaunchTargets } from '../sources/launch-targets.mjs';
import { startCodexCloud } from '../codex-cloud.mjs';
import { readDesktopCapabilities } from '../desktop-capabilities.mjs';
import { appAndModel } from './shared.mjs';

export function startTools({ store, requireLoopUi, desktopLaunches, resolveDesktopStart }) {
  return [
  {
    name: 'canban_launch_targets',
    title: '開始先の一覧',
    description: '新しいセッションの開始先を、各デスクトップアプリと同じデータで返す。Claude は選択アカウントの Desktop の「環境」、Codex はアプリの「プロジェクト」と「実行場所: クラウド」の環境。',
    inputSchema: { type: 'object', properties: { account: { type: ['string','null'] } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
    _meta: appAndModel,
    handler: async ({ account }) => {
      const [claude, codex] = await Promise.all([claudeEnvironments(guestPaths().app, { expectedAccount: account, dataDir: store.dir }), codexLaunchTargets()]);
      return {
        text: [`Claude の環境: ${claude.environments.map((e) => e.name).join('、') || 'なし'}`, `Codex のプロジェクト: ${codex.projects.map((p) => p.name).join('、') || 'なし'}`,
          `Codex Cloud の環境: ${codex.cloudEnvironments.map((e) => e.name).join('、') || 'なし'}`].join('\n'),
        structured: { claude, codex, desktopCapabilities: { ...await readDesktopCapabilities(store.dir), activeAccount: (await claudeEnvironments(guestPaths().app)).account || null } },
      };
    },
  },
  {
    name: 'canban_start_session',
    title: '新しいセッションを開始',
    description: 'Codex / Claude Code の新規画面をデスクトップで開くか、ターミナルで開始する。taskId は任意で、省略するとタスクカードを作らない。デスクトップでの送信・実行開始はアプリで確認する。',
    inputSchema: {
      type: 'object',
      properties: {
        uiToken: { type: 'string' },
        allowDesktopSwitch: { type: 'boolean' },
        allowQuit: { type: 'boolean' },
        taskId: { type: 'string' },
        clientRequestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$', description: '同じ開始リクエストの再試行に同じIDを使うと二重起動を防ぐ' },
        agent: { type: 'string', enum: ['codex', 'claude'] },
        hostId: { type: 'string', description: "'local' またはリモート接続の hostId" },
        cwd: { type: 'string', description: '作業フォルダ（そのマシン上の絶対パス）' },
        prompt: { type: 'string' },
        imageIds: { type: 'array', items: { type: 'string' }, maxItems: 8 },
        skills: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string' } }, required: ['name', 'path'], additionalProperties: false }, maxItems: 20 },
        route: { type: 'string', enum: ['desktop', 'terminal'] },
        terminal: { type: 'string', enum: ['ghostty', 'terminal', 'iterm'] },
        target: { type: 'string', enum: ['new-window', 'new-tab', 'split', 'current'] },
        account: { type: ['string', 'null'], description: "開始するアカウント（canban_get_usage の key）。Desktop の登録済みアカウントへの切替はボードUIで確認する" },
        sourceRef: { ...sourceRefSchema, description: '同じnativeIdのCodex projectIdと一緒に指定する開始設定の参照。Claude環境・section・group・projectIdなしの指定は拒否し、フォルダ開始へ変換しない' },
        environmentId: { type: 'string', maxLength: 128, description: 'Claude環境のID。完全適用経路が未確認の場合は開始を拒否し、元アプリでの開始または明示folder指定を案内する' },
        projectId: { type: 'string', maxLength: 200, description: 'Codex のプロジェクト（canban_launch_targets の codex.projects[].id）。そのプロジェクトのマシン・フォルダで開く。hostId / cwd より優先' },
        runOn: { type: 'string', enum: ['local', 'cloud'], description: "Codex の実行場所。'cloud' は Codex Cloud にタスクを送信して開始する（新規画面は開かない）" },
        cloudEnvironment: { type: 'string', maxLength: 200, description: "runOn 'cloud' の環境（canban_launch_targets の codex.cloudEnvironments[].id）" },
      },
      required: ['agent'],
      additionalProperties: false,
    },
    _meta: appAndModel,
    handler: async ({ uiToken: suppliedToken, allowDesktopSwitch = false, allowQuit = false, taskId, agent, hostId = 'local', cwd = '', prompt, imageIds = [], skills = [], route, terminal, target, account = null, clientRequestId, environmentId, projectId, sourceRef, runOn = 'local', cloudEnvironment }) => {
      const uiAuthorized = suppliedToken !== undefined ? !!requireLoopUi({ uiToken: suppliedToken }) : false;
      const state = (await store.load());
      const task = state.cards[taskId];
      if (taskId !== undefined && task?.kind !== 'task') throw new Error('タスクカードが見つかりません');
      if (runOn !== 'cloud' && (route || state.settings.launch.route) === 'desktop') {
        const rawPrompt = String(prompt ?? [task?.title, task?.description, task?.note].filter(Boolean).join('\n\n'));
        if (rawPrompt.length > 20000) throw new Error('依頼文は20000文字までです');
        const input = { taskId: taskId || null, agent, hostId, cwd, prompt: rawPrompt, imageIds, skills, route: 'desktop', account, environmentId: environmentId || null, projectId: projectId || null, sourceRef, clientRequestId, allowDesktopSwitch, allowQuit };
        await resolveDesktopStart(input);
        const detail = await desktopLaunches.start(input, { uiAuthorized });
        return { text: detail.note || detail.reason || 'Desktop の準備を待っています', structured: detail };
      }

      let host = LOCAL_HOST;
      let remoteEnabled = true;
      let codexProject = null;
      const cloud = agent === 'codex' && runOn === 'cloud';
      if (runOn === 'cloud' && agent !== 'codex') throw new Error('クラウドで開始できるのは Codex だけです');
      const selectionRequest = { agent, route: route || state.settings.launch.route, account, hostId, cwd, environmentId, projectId, sourceRef, runOn, cloudEnvironment };
      const readTargets = async () => ({ codex: await codexLaunchTargets() });
      const selection = await prepareLaunchSelection(selectionRequest, await readTargets());
      if (projectId) {
        if (agent !== 'codex') throw new Error('プロジェクトを選べるのは Codex だけです');
        codexProject = (await codexLaunchTargets()).projects.find((p) => p.id === projectId);
        if (!codexProject) throw new Error('Codex のプロジェクトが見つかりません。Codex でプロジェクトを確認してください');
        cwd = codexProject.root;
        hostId = codexProject.hostId;
      }
      if (!environmentId && hostId && hostId !== 'local') {
        const h = (await hostsWithState(state)).find((x) => x.id === hostId);
        if (!h) throw new Error('Codex に登録されていない接続です');
        host = { id: h.id, alias: h.alias, label: h.label, local: false, sshPort: h.sshPort };
        remoteEnabled = h.enabled;
      }
      const rawPrompt = String(prompt ?? [task?.title, task?.description, task?.note].filter(Boolean).join('\n\n'));
      if (rawPrompt.length > 20000) throw new Error('依頼文は20000文字までです');
      if (cwd && (!cwd.startsWith('/') || cwd.includes('\0') || cwd.length > 4096)) throw new Error('作業フォルダは絶対パスで指定してください');
      const prefs = state.settings.launch;
      const useRoute = cloud ? 'cloud' : route || prefs.route;
      if (useRoute === 'terminal' && !cwd) throw new Error('ターミナルで開始する作業フォルダを選んでください');
      if (cloud) {
        if (!cloudEnvironment) throw new Error('Codex Cloud の環境を選んでください');
        if (!rawPrompt.trim()) throw new Error('クラウドで開始するには依頼内容が必要です');
        if (imageIds.length) throw new Error('クラウドで開始するときは画像を添付できません');
      }
      const detail = await launchOnce(store.dir, clientRequestId, { taskId: taskId || null, agent, hostId, cwd, prompt: rawPrompt, imageIds, skills, route: useRoute, terminal: terminal || prefs.terminal, target: target || prefs.target, account, sourceRef: sourceRef || null, environmentId: environmentId || null, projectId: projectId || null, cloudEnvironment: cloud ? cloudEnvironment : null }, async () => {
        // Re-read source ownership immediately before side effects; names never identify a preset.
        await prepareLaunchSelection({ ...selectionRequest, sourceRef: selection.selectedRefs[0] || sourceRef }, await readTargets());
        const requestId = clientRequestId || randomBytes(16).toString('hex');
        const evidence = launchEvidence(selection, requestId);
        const { receipt } = evidence;
        if (taskId) await store.recordLaunch({ taskId, ...evidence });
        const skillPrompt = withSkills(rawPrompt, skills);
        const localImages = promptImages(store.dir, imageIds);
        const images = host.local === false ? await remoteImages(store.dir, localImages, host, pool) : localImages;
        const text = withImagePaths(skillPrompt, images);
        let detail;
        const labels = state.settings.accounts.labels;
        const as = await startAccount({ agent, account, host: cloud ? LOCAL_HOST : host, route: cloud ? 'terminal' : useRoute, labels });
        if (cloud) {
          const active = await startAccount({ agent, account: null, host: LOCAL_HOST, route: 'desktop', labels });
          if (account && active.account !== account) throw new Error('クラウド環境の所有アカウントを確認できません。現在のログインで環境を選び直してください');
          detail = await startCodexCloud({ environment: cloudEnvironment, prompt: skillPrompt, prefix: as.prefix, cwd: host.local !== false && cwd ? cwd : null });
        } else {
          const term = terminal || prefs.terminal;
          if (!installedTerminals().some((t) => t.id === term)) throw new Error(`${TERMINAL_LABELS[term] || term} が見つかりません。設定でターミナルを選んでください。`);
          const command = newSessionCommand(agent, { host, cwd, prompt: agent === 'codex' ? skillPrompt : text, images, prefix: as.prefix });
          detail = { route: 'terminal', command, ...(await runInTerminal({ terminal: term, target: target || prefs.target, command })) };
        }
        if (taskId) {
          await store.updateTask({ cardId: taskId, target: { agent, hostId: host.local === false ? host.id : 'local', cwd, account: as.account } });
          await store.addPending({ taskId, pending: { agent, hostId: host.local === false ? host.id : 'local', cwd, prompt: text.slice(0, 200), startedAt: Date.now() } });
        }
        const note = cloud ? `Codex Cloud にタスクを送信しました。実行状況は Codex の「クラウド」で確認してください。${detail.url ? `（${detail.url}）` : ''}` : !remoteEnabled ? `${host.label} の読み取りがオフです。「マシン」でオンにするとセッションを表示できます。` : useRoute === 'desktop' ? ['新規画面を開きました。依頼の送信と実行状況はアプリで確認してください。', integratedNote({ ...detail.integrated, opened: true })].filter(Boolean).join('') : null;
        return { ...detail, selection: { ...selection, requestId }, receipt, note };
      });
      return { text: detail.note || (detail.route === 'desktop' ? 'デスクトップの新規画面を開きました' : detail.route === 'cloud' ? 'Codex Cloud にタスクを送信しました' : 'ターミナルに開始を依頼しました'), structured: detail };
    },
  },
  ];
}

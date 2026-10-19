// Session tools: resume, the Claude execution account, and prompts sent to existing sessions (requests).
import { findSession } from '../board.mjs';
import { isCloudSession, CLOUD_OPERATION_REASON } from '../sources/codex-dots.mjs';
import { desktopLink, resumeCommand } from '../agents.mjs';
import { runInTerminal, installedTerminals, TERMINAL_LABELS } from '../launcher.mjs';
import { accountDesktopNote } from '../accounts-mcp.mjs';
import { accountName, accountLabel, desktopAccountMismatch } from '../accounts.mjs';
import { openDesktopApp, integratedNote } from '../claude-desktop-open.mjs';
import { dispatcherFor, inspect, timingProblem } from '../dispatch.mjs';
import { claudeExecutionSession, savedClaudeExecutionSession } from '../claude-handoff.mjs';
import { desktopProfilePlan, withDesktopAccount, saveClaudeExecutionAccount, desktopExecutionLink } from '../claude-desktop-profile.mjs';
import { appOnly, appAndModel, appTool, requestView } from './shared.mjs';

export function sessionTools({ store, requireLoopUi, desktopLaunches }) {
  return [
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
        desktopAccount: { type: 'string', description: '今回起動する Claude Desktop アカウント。CLI設定とは独立' },
        clientRequestId: { type: 'string' },
        allowDesktopSwitch: { type: 'boolean' },
        uiToken: { type: 'string' },
      },
      required: ['cardId'],
      additionalProperties: false,
    },
    _meta: appAndModel,
    handler: async ({ cardId, route, terminal, target, claudeHome, desktopAccount, clientRequestId, allowDesktopSwitch = false, uiToken: suppliedToken }) => {
      const { session: source, state } = await findSession(store, cardId);
      if (desktopAccount !== undefined) {
        if (source.agent !== 'claude' || route === 'terminal') throw new Error('Desktop の起動アカウントは Claude Desktop で選んでください');
        const uiAuthorized = suppliedToken !== undefined ? !!requireLoopUi({ uiToken: suppliedToken }) : false;
        const detail = await desktopLaunches.start({ operation: 'resume', agent: 'claude', cardId, account: desktopAccount, clientRequestId, allowDesktopSwitch }, { uiAuthorized });
        return { text: detail.reason || detail.note || 'Desktop の再開状況', structured: detail };
      }
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
      if (session.desktopAmbiguous && useRoute === 'desktop') throw new Error('この会話には複数の Desktop 所有者があります。実行アカウントを確認してください');
      // Another account's session, run as the account signed in to Desktop: open the
      // original through the integrated sidebar. Desktop's import (claude://resume)
      // would make a second, unlinked record in the signed-in account instead.
      const mismatch = selected && session.desktopSessionId && !session.archived ? desktopAccountMismatch(source) : null;
      const crossDesktop = !!mismatch && mismatch.active === session.executionAccount;
      const link = selected && !crossDesktop ? await desktopExecutionLink(source, session.executionAccount) : desktopLink(session);
      if (selected && useRoute === 'desktop' && !link) throw new Error('Desktop からこの会話を取り込めません。同じ会話をターミナルで再開してください');
      if (useRoute === 'desktop' && !link) {
        if (route === 'desktop') throw new Error('このセッションはデスクトップアプリでは開けません。ターミナルで再開してください。');
        useRoute = 'terminal';
      }
      // Claude desktop signed in to another account would not find the session: the
      // default route resumes it in the terminal instead (an explicit desktop still opens).
      let accountNote = selected ? null : accountDesktopNote(session, state.settings.accounts.labels);
      // A signed-in Desktop profile of the session's own account opens it there.
      const owner = accountNote && useRoute === 'desktop' ? desktopAccountMismatch(session)?.session : null;
      const ownerPlan = owner ? await desktopProfilePlan(owner) : null;
      if (ownerPlan?.available) accountNote = null;
      // Every Desktop open goes through openDesktopApp (claude-desktop-open.mjs): with
      // Desktop stopped, the signed-in Desktop starts with every account's sessions.
      const labels = state.settings.accounts.labels;
      const labelOf = a => accountLabel(`claude:${a}`, labels).replace(/@.*/, '');
      let integrated = null;
      if (crossDesktop && useRoute === 'desktop') {
        integrated = await openDesktopApp(link.url, { guestSessionId: session.desktopSessionId, labelOf });
        if (!integrated.opened) throw new Error(`${accountName(mismatch.session, labels)} の会話を Desktop で開けません。${integrated.reason}`);
      } else if (owner && !ownerPlan?.available && useRoute === 'desktop') {
        integrated = await openDesktopApp(link.url, { guestSessionId: session.desktopSessionId, labelOf });
        if (integrated.opened) accountNote = null;
        else if (route === 'desktop') throw new Error(`${accountName(owner, labels)} の会話を Desktop で開けません。${integrated.reason}`);
        else accountNote = `${accountNote}\n${integrated.reason}`;
      }
      let terminalNote = null;
      if (useRoute === 'desktop' && accountNote && !route) { useRoute = 'terminal'; terminalNote = accountNote; }
      if (useRoute === 'desktop' && !integrated?.opened) {
        if (selected) await withDesktopAccount(session.executionAccount, async () => {
          await claudeExecutionSession(source, session.home, session.executionAccount);
          integrated = await openDesktopApp(link.url, { labelOf });
        });
        else if (ownerPlan?.available) {
          try { await withDesktopAccount(owner, async () => { integrated = await openDesktopApp(link.url, { labelOf }); }); }
          catch (error) {
            if (route || !['desktop_running', 'desktop_busy', 'desktop_unavailable'].includes(error.code)) throw new Error(`${accountName(owner, labels)} の Desktop で開けません。${error.message}`);
            useRoute = 'terminal';
            terminalNote = `${accountName(owner, labels)} の Desktop へ切り替えられないため、ターミナルで再開しました。${error.message}`;
          }
        } else integrated = await openDesktopApp(link.url, { labelOf });
      }
      if (useRoute === 'desktop') accountNote = integratedNote(integrated) || accountNote;
      if (useRoute === 'desktop') {
        const note = accountNote || link.note || null;
        return { text: `${link.label}: ${link.url}${accountNote ? `\n${note}` : ''}`, structured: { route: 'desktop', url: link.url, exact: link.exact, note, executionAccount: session.executionAccount || null, integrated: integrated && { ok: integrated.ok, placed: integrated.placed || 0, code: integrated.code || null } } };
      }
      const term = terminal || prefs.terminal;
      if (!installedTerminals().some((t) => t.id === term)) throw new Error(`${TERMINAL_LABELS[term] || term} が見つかりません。設定でターミナルを選んでください。`);
      const command = resumeCommand(session);
      const res = await runInTerminal({ terminal: term, target: target || prefs.target, command });
      return { text: `${TERMINAL_LABELS[term]} で再開: ${command}${terminalNote ? `\n${terminalNote}` : ''}`, structured: { route: 'terminal', command, executionAccount: session.executionAccount || null, note: terminalNote, ...res } };
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
  ];
}

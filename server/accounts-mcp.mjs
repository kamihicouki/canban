// Accounts in the MCP server and on the board: tools, the `account` filter, notes on
// desktop links, and the extra folders the live watch follows. The data comes from
// server/accounts.mjs; this file only wires it in (index.mjs / board.mjs call these).
import fs from 'node:fs';
import path from 'node:path';
import { configureAccounts, codexHomes, claudeHomes, claudeDesktopRoots, claudeDesktopSessionsDir, refreshAccounts, accountsView, accountLabel, desktopAccountMismatch } from './accounts.mjs';
import { limitsByAccount } from './signals.mjs';
import { createHome, removeHome, loginCommand, listRunnerHomes } from './runner.mjs';
import { runInTerminal, installedTerminals } from './launcher.mjs';
import { dataDir } from './store.mjs';
import { defaultClaudeHome, defaultCodexHome } from './accounts.mjs';

export const accountFilterProp = { type: 'string', description: "アカウントで絞り込み（canban_get_usage の key。例 'claude:<uuid>' / 'codex:<id>'）。'__none' でアカウント不明" };

// '__none' = sessions of this machine whose account is not known.
export function matchesAccount(account, s) {
  return account === '__none' ? !s.account && s.host?.local !== false : s.account === account;
}

// The Claude desktop app lists only the signed-in account's sessions: opening another
// account's session there would not find it, so say so (the terminal resumes it).
export function accountDesktopNote(s, labels) {
  const m = desktopAccountMismatch(s);
  return m ? `このセッションは ${accountLabel(m.session, labels)} のものです。Claude デスクトップは今 ${accountLabel(m.active, labels)} でサインインしているため、開くにはアカウントを切り替えるか、ターミナルで再開してください。` : null;
}
export function withAccountNote(launch, s, labels) {
  const note = launch.desktop && accountDesktopNote(s, labels);
  if (!note) return launch;
  const m = desktopAccountMismatch(s);
  return { ...launch, desktop: { ...launch.desktop, note, accountMismatch: { session: m.session, active: m.active } } };
}

// Folders beyond the defaults for the live watch (other config folders, desktop profiles).
const realOr = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
export function extraWatchRoots(store) {
  return async () => {
    configureAccounts((await store.load()).settings.accounts);
    const [codex, claude, desktop] = await Promise.all([codexHomes(), claudeHomes(), claudeDesktopRoots()]);
    return {
      codexHomes: codex.filter((h) => !h.default).map((h) => h.dir),
      // Runner folders usually link projects/ to the default one: watch each real folder once.
      claudeProjects: [...new Set(claude.filter((h) => !h.default).map((h) => realOr(path.join(h.dir, 'projects'))))].filter((d) => d !== realOr(path.join(claude.find((h) => h.default)?.dir || '', 'projects'))),
      // Profiles often link their session folder to a shared one: watch each real folder once.
      claudeDesktop: [...new Set(desktop.map((r) => realOr(r.sessionsDir)))].filter((d) => d !== realOr(claudeDesktopSessionsDir())),
    };
  };
}

const windowText = (w) => (w ? `${w.windowMinutes >= 1440 ? '週' : `${Math.round(w.windowMinutes / 60)}h`} ${Math.round(w.usedPercent)}%` : null);
const signedText = (x) => (x === 'desktop' ? 'デスクトップ' : x.startsWith('desktop:') ? `デスクトップ（${x.slice(8)}）` : `CLI ${x.slice(4)}`);

// getLive: () => the LiveHub (or null), so a change of folders is watched at once.
export function accountTools({ store, allSessions, appTool, meta, getLive = () => null }) {
  return [
    {
      name: 'canban_get_usage',
      title: 'アカウントと使用量',
      description:
        'Codex / Claude のアカウントごとの使用量（5 時間・週の利用上限の使用率）と、各アカウントのセッション数・サインイン状況・設定フォルダを返す。Codex はセッションのログ、Claude は Claude デスクトップアプリの記録から読む。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      _meta: meta,
      handler: async () => {
        const state = await store.load();
        const { sessions } = await allSessions(state);
        const v = accountsView({ ...state.settings.accounts, sessions: sessions.filter((s) => !s.subagent), codexLimits: limitsByAccount() });
        const lines = v.accounts.map((a) => {
          const l = a.limits;
          const usage = l ? [windowText(l.primary), windowText(l.secondary)].filter(Boolean).join(' · ') : '使用量の記録なし';
          const signed = a.signedIn.length ? `（サインイン中: ${a.signedIn.map(signedText).join(', ')}）` : '';
          return `${a.agent === 'codex' ? 'Codex' : 'Claude'} ${a.label}${a.plan ? ` [${a.plan}]` : ''}: ${usage} / ${a.count} セッション${signed}`;
        });
        if (v.unknown.codex || v.unknown.claude) lines.push(`アカウント不明: Codex ${v.unknown.codex} / Claude ${v.unknown.claude} セッション`);
        return { text: lines.join('\n') || 'アカウントが見つかりません', structured: v };
      },
    },
    appTool('canban_update_accounts', 'アカウントと設定フォルダを変更', {
      label: { type: 'object', properties: { key: { type: 'string' }, name: { type: 'string' } } },
      mark: { type: 'object', properties: { key: { type: 'string' }, short: { type: 'string' }, color: { type: ['string', 'null'] } } },
      visible: { type: 'object', properties: { key: { type: 'string' }, on: { type: 'boolean' } } },
      claudeHomes: { type: 'array', items: { type: 'string' } },
      codexHomes: { type: 'array', items: { type: 'string' } },
      discover: { type: 'boolean' },
      runner: { type: 'object', properties: { enabled: { type: 'boolean' }, shareProjects: { type: 'boolean' }, shareConfig: { type: 'boolean' }, limitAt: { type: 'number' } } },
    }, [], async (a) => {
      const res = await store.updateAccountSettings(a);
      if (configureAccounts(res)) {
        await refreshAccounts({ force: true });
        const live = getLive();
        if (live?.active) live.watchExtra();
      }
      return res;
    }),
    ...runnerTools({ store, appTool, getLive }),
  ];
}

// ---- account runner (Canban-made account folders, server/runner.mjs) ----------------
async function afterHomesChanged(getLive) {
  await refreshAccounts({ force: true });
  const live = getLive();
  if (live?.active) live.watchExtra();
}

// Log in with the agent's own CLI in the user's terminal (Canban never sees the token).
async function openLogin(store, home) {
  const { launch } = (await store.load()).settings;
  const command = loginCommand(home);
  if (!installedTerminals().some((t) => t.id === launch.terminal)) return { command, opened: false };
  await runInTerminal({ terminal: launch.terminal, target: 'new-window', command });
  return { command, opened: true };
}

function runnerHome(homeId) {
  const h = listRunnerHomes(dataDir()).find((x) => x.id === homeId);
  if (!h) throw new Error('Canban が作ったアカウントのフォルダではありません');
  return h;
}

function runnerTools({ store, appTool, getLive }) {
  return [
    appTool('canban_account_create', 'アカウントを追加', {
      agent: { type: 'string', enum: ['claude', 'codex'] },
      name: { type: 'string', description: 'フォルダ名にも使う名前（英数字）' },
      login: { type: 'boolean', description: '作ったあとターミナルでログインを開く（既定 true）' },
    }, ['agent', 'name'], async ({ agent, name, login = true }) => {
      const { runner } = (await store.load()).settings.accounts;
      if (!runner.enabled) throw new Error('アカウントの追加は設定でオフになっています（👤 → アカウントの追加をオン）');
      const home = createHome({ dataDir: dataDir(), agent, name, sourceHome: agent === 'codex' ? defaultCodexHome() : defaultClaudeHome(), shareProjects: runner.shareProjects, shareConfig: runner.shareConfig });
      await afterHomesChanged(getLive);
      return { home, login: login ? await openLogin(store, home) : { command: loginCommand(home), opened: false } };
    }),
    appTool('canban_account_login', 'アカウントにログイン', { homeId: { type: 'string' } }, ['homeId'], async ({ homeId }) => openLogin(store, runnerHome(homeId))),
    appTool('canban_account_remove', 'アカウントのフォルダを外す', { homeId: { type: 'string' } }, ['homeId'], async ({ homeId }) => {
      const res = removeHome({ dataDir: dataDir(), id: runnerHome(homeId).id });
      await afterHomesChanged(getLive);
      return res;
    }),
  ];
}

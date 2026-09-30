// Accounts in the MCP server and on the board: tools, the `account` filter, notes on
// desktop links, and the extra folders the live watch follows. The data comes from
// server/accounts.mjs; this file only wires it in (index.mjs / board.mjs call these).
import fs from 'node:fs';
import path from 'node:path';
import { configureAccounts, codexHomes, claudeHomes, claudeDesktopRoots, claudeDesktopSessionsDir, refreshAccounts, accountsView, accountLabel, desktopAccountMismatch } from './accounts.mjs';
import { limitsByAccount } from './signals.mjs';

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
    configureAccounts(store.load().settings.accounts);
    const [codex, claude, desktop] = await Promise.all([codexHomes(), claudeHomes(), claudeDesktopRoots()]);
    return {
      codexHomes: codex.filter((h) => !h.default).map((h) => h.dir),
      claudeProjects: claude.filter((h) => !h.default).map((h) => path.join(h.dir, 'projects')),
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
        const state = store.load();
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
    }, [], async (a) => {
      const res = await store.updateAccountSettings(a);
      if (configureAccounts(res)) {
        await refreshAccounts({ force: true });
        const live = getLive();
        if (live?.active) live.watchExtra();
      }
      return res;
    }),
  ];
}

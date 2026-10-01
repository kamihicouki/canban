// Accounts in the MCP server and on the board: tools, the `account` filter, notes on
// desktop links, and the extra folders the live watch follows. The data comes from
// server/accounts.mjs; this file only wires it in (index.mjs / board.mjs call these).
import fs from 'node:fs';
import path from 'node:path';
import { configureAccounts, codexHomes, claudeHomes, claudeDesktopRoots, claudeDesktopSessionsDir, refreshAccounts, accountsView, accountLabel, desktopAccountMismatch, runAs, accountChoices, roomiest, homeForAccount, usedPercent, runningAccount } from './accounts.mjs';
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

// The account each session runs as: the card's pin, else the account Canban last ran it
// as, else what the logs say (accounts.mjs). Returns new objects for the ones that change;
// a pin that cannot apply (the folder does not see the conversation) is reported instead.
export function applyCardAccounts(sessions, state) {
  return sessions.map((s) => {
    const card = state.cards?.[s.id];
    const key = card?.accountPin || card?.lastAccount;
    if (!key || s.host?.local === false) return s;
    const r = runAs(s, key);
    if (r.ok) return r.session === s ? { ...s, accountSource: card.accountPin ? 'pin' : 'last' } : { ...r.session, accountSource: card.accountPin ? 'pin' : 'last' };
    return card.accountPin ? { ...s, accountPinProblem: r.reason } : s;
  });
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
// Choose the account a session runs as. key: an account key, 'auto' (most room left
// among the accounts that can run it) or null (back to the recorded / last-used one).
export async function pinSessionAccount({ store, findSession, limits = limitsByAccount() }, { cardId, account }) {
  const { session, state } = await findSession(store, cardId);
  if (!account) {
    await store.updateCardAccount({ cardId, pin: null });
    return { cardId, account: null };
  }
  const base = { ...session, account: session.accountSource ? null : session.account }; // judge from the logs, not the old pin
  let key = account;
  if (account === 'auto') {
    const choices = accountChoices(base);
    key = roomiest(session.agent, limits, { exclude: [] });
    if (!choices.includes(key)) key = choices[0] || null;
    if (!key) throw new Error('このセッションを続けられるアカウントがありません（👤 → アカウントを追加）');
  }
  const r = runAs(base, key);
  if (!r.ok) throw new Error(r.reason);
  await store.updateCardAccount({ cardId, pin: key });
  return { cardId, account: key, label: accountLabel(key, state.settings.accounts.labels) };
}

// ---- usage limits: continue on another account (requests with onLimit 'switch') ----
// The agents' own words when a plan limit stops a turn.
export const LIMIT_ERROR = /usage limit|rate[ _-]?limit|hit your limit|limit (?:reached|exceeded)|out of (?:usage|credits)|quota/i;

// Before a run. runAccount: the account a retry was queued for. With onLimit 'switch',
// a session whose account is at or over limitAt runs as the account with the most
// room that can take it. Returns { session, switched: { from, to } | null }.
export function accountForRun(session, { onLimit = 'wait', runAccount = null } = {}, { limitAt = 95, codexLimits = limitsByAccount() } = {}) {
  let s = session;
  if (runAccount) {
    const r = runAs(s, runAccount);
    if (r.ok) s = r.session;
  }
  const current = runningAccount(s);
  if (onLimit !== 'switch' || !current) return { session: s, switched: null };
  const used = usedPercent(current, codexLimits);
  if (used == null || used < limitAt) return { session: s, switched: null };
  const to = roomiest(s.agent, codexLimits, { exclude: [current], among: accountChoices({ ...s, account: null }), below: limitAt });
  return to ? { session: runAs({ ...s, account: current }, to).session, switched: { from: current, to } } : { session: s, switched: null };
}

// After a run failed: the account to try once more with, or null.
export function retryAccount(req, session, error, { limitAt = 95, codexLimits = limitsByAccount() } = {}) {
  if (req.onLimit !== 'switch' || req.switchedFrom || !LIMIT_ERROR.test(String(error || ''))) return null;
  const from = req.account || runningAccount(session);
  return roomiest(session.agent, codexLimits, { exclude: [from].filter(Boolean), among: accountChoices({ ...session, account: null }), below: limitAt });
}

// The folder to start a new session in for `account` (a key or 'auto'): { key, homeDir }.
// The default folder has homeDir null. Throws when no folder is signed in to it.
export function startFolderFor(agent, account) {
  if (!account) return { key: null, homeDir: null };
  const key = account === 'auto' ? roomiest(agent, limitsByAccount()) : account;
  const h = key && homeForAccount(agent, key);
  if (!h) throw new Error(account === 'auto' ? 'ログインしたフォルダのあるアカウントがありません' : 'このアカウントでログインしたフォルダがありません（👤 → アカウントを追加）');
  return { key, homeDir: h.default ? null : h.dir };
}

// findSession: board.mjs findSession (passed in to keep this module free of board.mjs).
export function accountTools({ store, allSessions, findSession, appTool, meta, getLive = () => null }) {
  return [
    {
      name: 'canban_set_session_account',
      title: 'セッションのアカウントを選ぶ',
      description:
        "セッションを動かすアカウントを選ぶ（再開・指示の送信・キューに使う）。account は canban_get_usage の key、'auto'（使用量に一番余裕のあるアカウント）、null（記録どおりに戻す）。Claude の会話は、その会話を共有しているフォルダのアカウントにだけ移せる。Codex のスレッドは作ったフォルダのアカウントのまま。",
      inputSchema: { type: 'object', properties: { cardId: { type: 'string' }, account: { type: ['string', 'null'] } }, required: ['cardId'], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false },
      _meta: meta,
      handler: async (a) => {
        const r = await pinSessionAccount({ store, findSession }, a);
        return { text: r.account ? `このセッションは ${r.label} で動かします` : '記録どおりのアカウントに戻しました', structured: r };
      },
    },
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

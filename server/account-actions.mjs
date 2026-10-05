// App-only account operations, separated from the read model to keep account discovery read-only.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { database } from './sqlite-client.mjs';
import { configureAccounts, refreshAccounts, accountsView } from './accounts.mjs';
import { limitsByAccount } from './signals.mjs';
import { codexUsage, claudeUsage } from './account-usage.mjs';
import { credentialIdentity, claudeCredentials } from './account-credentials.mjs';
import { resolveBin } from './dispatch.mjs';
import { shq } from './agents.mjs';
import { runInTerminal } from './launcher.mjs';
import { managedLogins, loginPreference } from './login.mjs';
import { loginTarget } from './login-browsers.mjs';
import { claudeAuthOverrides } from './claude-auth-env.mjs';

export function accountActions({ store, allSessions, getLive = () => null, providers = { codex: codexUsage, claude: claudeUsage }, launch = runInTerminal, bin = resolveBin, loginManager = null, getClaudeCredentials = claudeCredentials, now = Date.now, dryRun = process.env.CANBAN_LAUNCH_DRYRUN === '1' }) {
  const db = database(store.dir);
  const logins = loginManager || managedLogins({ resolveCli: bin, onComplete: async (profile) => {
    const result = await checkLogin({ id: profile.id });
    if (!result.complete) throw new Error('認証したアカウントを確認できません');
    return { key: result.key };
  } });
  const locked = async (key, fn) => {
    const token = await db.call('system', 'acquire', [{ key, owner: crypto.randomUUID(), pid: process.pid }]);
    if (!token) return { busy: true };
    try { return await fn(); } finally { await db.call('system', 'release', [token]); }
  };
  const changed = async (settings) => {
    configureAccounts(settings); await refreshAccounts({ force: true });
    const live = getLive(); if (live?.active) live.watchExtra();
  };
  const view = async (state) => {
    const { sessions } = await allSessions(state);
    return accountsView({ ...state.settings.accounts, sessions: sessions.filter((s) => !s.subagent), codexLimits: limitsByAccount() });
  };
  const refresh = async ({ key, automatic = false } = {}) => {
    const state = await store.load(), settings = state.settings.accounts;
    if (automatic && !settings.refresh.enabled) return { updated: [] };
    const v = await view(state);
    if (key && !v.accounts.some((a) => a.key === key)) throw new Error('アカウントが見つかりません');
    const selected = v.accounts.filter((a) => !key || a.key === key);
    const updated = [], busy = [];
    // Limit concurrency to two provider connections; each account is isolated by a SQLite lease.
    let next = 0;
    const worker = async () => {
      while (next < selected.length) {
        const a = selected[next++];
        const result = await locked(`account-usage:${a.key}`, async () => {
          const current = (await store.load()).settings.accounts;
          const previous = current.usage[a.key];
          if (automatic && (!current.refresh.enabled || (previous?.attemptedAt && now() - previous.attemptedAt < current.refresh.intervalMinutes * 60000))) return null;
          const homes = v.homes.filter((h) => h.agent === a.agent && h.account === a.key && !h.missing);
          // Try another home if its credential has expired; never use another account's home.
          let snapshot, code = 'login_required';
          if (dryRun) code = 'unavailable';
          else for (const home of homes) {
            try { snapshot = await providers[a.agent]({ key: a.key, home }); break; }
            catch (error) { code = ['login_required', 'unsupported', 'identity_changed', 'timeout', 'rate_limited'].includes(error.code) ? error.code : 'unavailable'; }
          }
          const value = snapshot ? { ...snapshot, attemptedAt: now(), status: 'ok', code: null }
            : { ...previous, attemptedAt: now(), status: 'error', code };
          await store.updateAccountSettings({ usage: { [a.key]: value } });
          return { key: a.key, status: value.status, code: value.code };
        });
        if (result?.busy) busy.push(a.key);
        else if (result) updated.push(result);
      }
    };
    await Promise.all([worker(), worker()]);
    configureAccounts((await store.load()).settings.accounts);
    return { updated, busy };
  };
  const loginCommand = (p, executable) => {
    const removed = ['CODEX_THREAD_ID', 'CLAUDECODE', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_CLIENT_ID', 'CLAUDE_CODE_CUSTOM_OAUTH_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_ACCOUNT_UUID', 'CLAUDE_CODE_ORGANIZATION_UUID', 'CLAUDE_CODE_USER_EMAIL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'BROWSER', 'CANBAN_AUTH_SOCKET', 'CANBAN_AUTH_NONCE', 'CANBAN_AUTH_NODE', 'CANBAN_AUTH_HELPER'];
    const inherited = Object.keys(process.env).filter(k => /^(CLAUDE_(BG|PTY)_|CLAUDE_CODE_|CODEX_SANDBOX|CODEX_MANAGED_)/.test(k));
    const env = [...new Set([...removed, ...inherited, ...(p.agent === 'claude' ? claudeAuthOverrides() : [])])].map(name => `-u ${shq(name)}`).join(' ');
    return `cd ${shq(p.dir)} && env ${env} ${p.agent === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'}=${shq(p.dir)} ${shq(executable)} ${p.agent === 'codex' ? 'login -c '+shq('cli_auth_credentials_store="file"') : 'auth login --claudeai'}`;
  };
  const profile = async (id) => {
    const p = (await store.load()).settings.accounts.profiles.find(p => p.id === id);
    if (!p?.pending) throw new Error('ログイン待ちの保存先が見つかりません');
    return p;
  };
  const loginBrowsers = async ({ profileId } = {}) => {
    const p = profileId ? await profile(profileId) : null;
    return { browsers: logins.catalog(), preference: p ? loginPreference(p) : null,
      active: p && logins.active(p) ? logins.view(logins.active(p)) : null };
  };
  const loginDetails = async ({ profileId }) => {
    const p = await profile(profileId), executable = bin(p.agent);
    return { command: executable ? loginCommand(p, executable) : null,
      login: logins.active(p) ? logins.view(logins.active(p)) : null };
  };
  const startLogin = async ({ agent, key, profileId, method = 'terminal', loginOptions } = {}) => locked('account-profiles', async () => {
    if (!['codex', 'claude'].includes(agent)) throw new Error('サービスを選んでください');
    if (!['terminal', 'browser'].includes(method)) throw new Error('認証方法を選んでください');
    if (method === 'browser') loginTarget(loginOptions || { mode: 'manual' }, logins.catalog());
    const state = await store.load(), settings = state.settings.accounts;
    if (key && !(await view(state)).accounts.some((a) => a.key === key && a.agent === agent)) throw new Error('アカウントが見つかりません');
    const executable = bin(agent);
    if (!executable) throw new Error(`${agent === 'codex' ? 'Codex' : 'Claude'} CLI が見つかりません。先にインストールしてください`);
    let p = settings.profiles.find((p) => p.id === profileId || (key && p.expectedKey === key && p.pending));
    if (profileId && (!p || p.agent !== agent || !p.pending)) throw new Error('ログイン待ちの保存先が見つかりません');
    if (!p) {
      const homes = settings[`${agent}Homes`];
      if (homes.length + settings.profiles.filter((x) => x.agent === agent && x.pending).length >= 10) throw new Error('追加できる設定フォルダはサービスごとに 10 個までです');
      const id = crypto.randomUUID(), dir = path.join(store.dir, 'accounts', agent, id);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(dir, '.canban-account-profile'), id, { mode: 0o600, flag: 'wx' });
      if (agent === 'codex') await fs.writeFile(path.join(dir, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600, flag: 'wx' });
      p = { id, agent, dir, pending: true, key: null, expectedKey: key || null, startedAt: now() };
      await store.updateAccountSettings({ profile: p });
    }
    const command = loginCommand(p, executable);
    if (method === 'browser') {
      if (dryRun && !loginManager) return { profile: p, command, login: { state: 'failed', error: 'テストモードでは認証を開始しません' } };
      const active = logins.active(p);
      return { profile: p, command, login: active ? logins.view(active) : await logins.start(p, loginOptions || { mode: 'manual' }) };
    }
    const active = logins.active(p);
    if (active) await logins.cancel(active.id);
    // A failed OS launch still leaves a usable command for any terminal.
    try {
      if (!(dryRun && launch === runInTerminal)) await launch({ terminal: state.settings.launch.terminal, target: 'new-window', command });
      return { profile: p, command, opened: true };
    } catch { return { profile: p, command, opened: false, error: 'ターミナルを開けませんでした。ログインコマンドをコピーして実行してください' }; }
  });
  const checkLogin = async ({ id }) => locked('account-profiles', async () => {
    const settings = (await store.load()).settings.accounts;
    const p = settings.profiles.find((p) => p.id === id);
    if (!p) throw new Error('ログイン待ちの保存先が見つかりません');
    if (!p.pending) return { complete: true, key: p.key };
    const key = await credentialIdentity(p.agent, { dir: p.dir, default: false });
    if (!key) return { complete: false };
    if (p.expectedKey && p.expectedKey !== key) return { complete: false, wrongAccount: true };
    if (p.agent === 'claude' && !(await getClaudeCredentials({ dir: p.dir, default: false }))?.claudeAiOauth?.accessToken) return { complete: false };
    const homesKey = `${p.agent}Homes`;
    if (!settings[homesKey].includes(p.dir) && settings[homesKey].length >= 10) throw new Error('追加できる設定フォルダは 10 個までです');
    await changed(await store.updateAccountSettings({ profile: { ...p, key, pending: false }, [homesKey]: [...new Set([...settings[homesKey], p.dir])] }));
    return { complete: true, key };
  });
  const cancelLogin = async ({ id }) => locked('account-profiles', async () => {
    const p = (await store.load()).settings.accounts.profiles.find((p) => p.id === id);
    if (!p?.pending) throw new Error('ログイン待ちの保存先が見つかりません');
    const active = logins.active(p);
    if (active) await logins.cancel(active.id);
    // The user may still have the terminal open; keep its files intact.
    await store.updateAccountSettings({ removeProfile: id });
    return { cancelled: true };
  });
  const moveHome = async ({ id, dir }) => locked('account-profiles', async () => {
    const state = await store.load(), settings = state.settings.accounts;
    const p = settings.profiles.find((p) => p.id === id);
    if (!p || p.pending) throw new Error('追加済みの専用保存先を選んでください');
    if (typeof dir !== 'string' || !dir.trim() || dir.includes('\0') || !/^(\/|~\/)/.test(dir.trim())) throw new Error('絶対パスまたは ~/ で始まる保存先を指定してください');
    const destination = path.resolve(dir.trim().replace(/^~(?=\/)/, os.homedir()));
    if (destination === p.dir) return { dir: p.dir };
    if (destination.startsWith(p.dir + path.sep) || p.dir.startsWith(destination + path.sep)) throw new Error('現在の保存先の親・子フォルダへは変更できません');
    if ((await fs.readFile(path.join(p.dir, '.canban-account-profile'), 'utf8').catch(() => null)) !== p.id || (await fs.lstat(p.dir)).isSymbolicLink()) throw new Error('Canban が作成した保存先だけを変更できます');
    if (await credentialIdentity(p.agent, { dir: p.dir, default: false }) !== p.key) throw new Error('保存先のアカウントが変わりました。ログイン状態を確認してください');
    const { sessions } = await allSessions(state);
    if (sessions.some((s) => s.homeDir === p.dir && ['running', 'waiting'].includes(s.status))) throw new Error('この保存先のセッションを終了してから変更してください');
    return locked(`account-usage:${p.key}`, async () => {
      // Never merge with or overwrite an existing folder, including an empty one.
      await fs.mkdir(path.dirname(destination), { recursive: true });
      try { await fs.mkdir(destination, { mode: 0o700 }); } catch { throw new Error('変更先は未使用のフォルダを指定してください'); }
      try {
        if (p.agent === 'claude') {
          // Keychain names depend on CLAUDE_CONFIG_DIR. Preserve authentication using the CLI's supported fallback.
          const credentials = await getClaudeCredentials({ dir: p.dir, default: false });
          if (credentials?.claudeAiOauth?.accessToken) {
            const temporary = path.join(p.dir, `.credentials-${crypto.randomUUID()}.tmp`);
            await fs.writeFile(temporary, JSON.stringify(credentials), { mode: 0o600, flag: 'wx' });
            await fs.rename(temporary, path.join(p.dir, '.credentials.json'));
          }
        }
        await fs.rename(p.dir, destination);
        try { await store.updateAccountSettings({ profile: { ...p, dir: destination }, [`${p.agent}Homes`]: settings[`${p.agent}Homes`].map((d) => d === p.dir ? destination : d) }); }
        catch (error) { await fs.rename(destination, p.dir); throw error; }
      } catch { await fs.rmdir(destination).catch(() => {}); throw new Error('保存先を変更できませんでした。同じディスク内の未使用フォルダを指定してください'); }
      await changed((await store.load()).settings.accounts);
      return { dir: destination };
    });
  });
  return { refresh, startLogin, checkLogin, cancelLogin, moveHome, loginBrowsers, loginDetails,
    loginStatus: ({ sessionId }) => logins.status(sessionId),
    loginOpen: ({ sessionId, loginOptions }) => logins.open(sessionId, loginOptions),
    loginCancel: ({ sessionId }) => logins.cancel(sessionId),
    loginCode: ({ sessionId, code }) => logins.submitCode(sessionId, code) };
}

export function accountActionTools({ actions, store, appTool }) {
  const session = { sessionId: { type: 'string' } };
  const loginOptions = { type: 'object', properties: {
    mode: { type: 'string', enum: ['auto', 'manual'] }, browserId: { type: 'string', enum: ['chrome', 'safari'] }, profileId: { type: 'string' },
  }, additionalProperties: false };
  return [
    appTool('canban_refresh_account_usage', 'アカウントの使用量を更新', { key: { type: 'string' }, automatic: { type: 'boolean' } }, [], actions.refresh),
    appTool('canban_set_usage_refresh', '使用量の自動更新を設定', { enabled: { type: 'boolean' }, intervalMinutes: { type: 'integer', minimum: 1, maximum: 1440 } }, [], async (refresh) => {
      const settings = await store.updateAccountSettings({ refresh }); configureAccounts(settings); return settings.refresh;
    }),
    appTool('canban_start_account_login', '専用保存先でアカウントにログイン', { agent: { type: 'string', enum: ['codex', 'claude'] }, key: { type: 'string' }, profileId: { type: 'string' }, method: { type: 'string', enum: ['terminal', 'browser'] }, loginOptions }, ['agent'], actions.startLogin),
    appTool('canban_login_browsers', '認証ブラウザ一覧', { profileId: { type: 'string' } }, [], actions.loginBrowsers),
    appTool('canban_account_login_details', 'ログイン待ちの認証方法とコマンド', { profileId: { type: 'string' } }, ['profileId'], actions.loginDetails),
    appTool('canban_account_login_status', '認証状態', session, ['sessionId'], actions.loginStatus),
    appTool('canban_account_login_open', '認証ブラウザを開く', { ...session, loginOptions }, ['sessionId'], actions.loginOpen),
    appTool('canban_account_login_cancel', '認証をキャンセル', session, ['sessionId'], actions.loginCancel),
    appTool('canban_account_login_code', '認証コードを送信', { ...session, code: { type: 'string' } }, ['sessionId', 'code'], actions.loginCode),
    appTool('canban_check_account_login', 'アカウントのログイン完了を確認', { id: { type: 'string' } }, ['id'], actions.checkLogin),
    appTool('canban_cancel_account_login', 'アカウント追加を取り消す', { id: { type: 'string' } }, ['id'], actions.cancelLogin),
    appTool('canban_move_account_home', '追加したアカウントの保存先を変更', { id: { type: 'string' }, dir: { type: 'string' } }, ['id', 'dir'], actions.moveHome),
  ];
}

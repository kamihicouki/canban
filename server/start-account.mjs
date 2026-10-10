// The account a new session from a task card starts with. The CLI gets the
// account's own config folder; Claude Desktop switches to the signed-in
// profile of that account (withDesktopAccount), Codex Desktop only runs as
// whoever ~/.codex is signed in to. No credentials are read or copied.
import os from 'node:os';
import path from 'node:path';
import { refreshAccounts, accountName } from './accounts.mjs';
import { homePrefix } from './agents.mjs';
import { withDesktopAccount } from './claude-desktop-profile.mjs';
import { assertClaudeAccount } from './claude-auth-status.mjs';
import { ACCOUNT_KEY } from './accounts-settings.mjs';

const nativeConfig = home => home.default && path.resolve(home.dir) === path.join(os.homedir(), '.claude') && !process.env.CLAUDE_CONFIG_DIR;

// { prefix, open(fn) }: prefix goes before the CLI in a terminal command; open
// wraps the desktop link so the app starts as the account. No account = as is.
export async function startAccount({ agent, account, host, route, labels = {} }) {
  if (!account) return { prefix: '', open: fn => fn(), account: null };
  if (!ACCOUNT_KEY.test(account) || account.split(':')[0] !== agent) throw new Error('AI App とアカウントが一致していません');
  if (host && host.local === false) throw new Error('アカウントを選んで開始できるのはこのマシンだけです。リモートではそのマシンのログインで開始します');
  const name = accountName(account, labels);
  const registry = await refreshAccounts({ force: true });
  const homes = registry.homes[agent].filter(h => h.account === account && !h.missing);
  const home = homes.find(h => h.default) || homes[0] || null;
  if (route === 'desktop') {
    if (agent === 'claude') {
      return { prefix: '', account, open: fn => withDesktopAccount(account, fn).catch(error => {
        throw new Error(`${name} で Desktop を開けません。${error.message}（ターミナルで開始すると、このアカウントで動きます）`);
      }) };
    }
    const current = registry.homes.codex.find(h => h.default)?.account || null;
    if (current !== account) throw new Error(`Codex Desktop は ${current ? accountName(current, labels) : '別のアカウント'} でサインインしています。${name} で開始するには、Codex のアカウントを切り替えるか、ターミナルで開始してください`);
    return { prefix: '', account, open: fn => fn() };
  }
  if (!home) throw new Error(`${name} の CLI 設定がありません。アカウントの設定で CLI にログインしてください`);
  if (agent === 'claude') await assertClaudeAccount({ ...home, configDir: nativeConfig(home) ? null : home.dir }, home.identity);
  return { prefix: homePrefix({ agent, homeDir: home.dir, claudeDefaultConfig: agent === 'claude' && nativeConfig(home) }), account, open: fn => fn() };
}

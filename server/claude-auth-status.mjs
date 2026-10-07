// Ask the installed CLI which login it will actually use. oauthAccount in a
// config file can survive logout, and a profile may have different credentials.
import { execFile } from 'node:child_process';
import { resolveBin } from './dispatch.mjs';
import { isolatedClaudeEnvironment } from './claude-auth-env.mjs';

export async function assertClaudeAccount(home, account) {
  const bin = resolveBin('claude');
  if (!bin) throw new Error('Claude CLI が見つかりません');
  const status = await new Promise((resolve, reject) => {
    const child = execFile(bin, ['auth', 'status', '--json'], {
      env: isolatedClaudeEnvironment(process.env, home.configDir),
      timeout: 15000, maxBuffer: 256 * 1024,
    }, (error, stdout) => {
      // Never forward raw output or errors: vendor output can include secrets.
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error('Claude CLI の認証状態を確認できません。AI Apps でログイン状態を確認してください')); }
    });
    child.stdin?.end();
  });
  if (status.loggedIn !== true) throw new Error('選択した Claude CLI 設定はログインしていません。AI Apps でログインしてから選び直してください');
  const sameEmail = account?.email && typeof status.email === 'string' && account.email.toLowerCase() === status.email.toLowerCase();
  const sameOrg = !account?.orgId || status.orgId === account.orgId;
  if (status.authMethod !== 'claude.ai' || !sameEmail || !sameOrg || (status.accountUuid && status.accountUuid !== account?.id)) {
    throw new Error('Claude CLI の実際の認証先が選択したアカウントと一致しません。AI Apps でログイン状態を確認して選び直してください');
  }
}

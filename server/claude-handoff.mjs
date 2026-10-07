// Resume a local transcript with another registered CLI profile. No auth or
// transcript files are copied, and the worktree/session identity stays intact.
import fs from 'node:fs/promises';
import path from 'node:path';
import { refreshAccounts, accountLabel } from './accounts.mjs';
import { resumeCommand } from './agents.mjs';
import { CLAUDE_AUTH_OVERRIDES } from './claude-auth-env.mjs';
import { desktopProfilePlan, desktopExecutionLink } from './claude-desktop-profile.mjs';

const localClaude = s => s?.agent === 'claude' && s.host?.local !== false;

export async function claudeResumeAccounts(session, labels = {}) {
  if (!localClaude(session) || !session.sourcePath || !path.isAbsolute(session.sourcePath)) return [];
  const registry = await refreshAccounts();
  return Promise.all(registry.homes.claude.filter(home => home.account).map(async home => ({
    id: home.id,
    account: home.account,
    label: `${accountLabel(home.account, labels)} (${home.id})`,
    command: resumeCommand({ ...session, homeDir: home.dir, resumePath: session.sourcePath }),
    desktop: await claudeDesktopChoice(session, home.account),
  })));
}

export async function claudeDesktopChoice(session, account) {
  const plan = await desktopProfilePlan(account);
  const link = plan.available ? await desktopExecutionLink(session, account) : null;
  return { maintainable: plan.available, change: !!plan.change, link, reason: plan.available ? link ? null : 'Desktop からこの会話を取り込めません。同じ会話はターミナルで再開できます。通常起動のアカウントは維持します' : plan.reason };
}

export async function claudeExecutionSession(session, homeId, expectedAccount) {
  if (homeId == null || homeId === '') return session;
  if (!localClaude(session)) throw new Error('アカウントを選んで再開できるのは、このマシンの Claude Code セッションです');
  const registry = await refreshAccounts({ force: true });
  const home = registry.homes.claude.find(h => h.id === homeId && h.account);
  if (!home) throw new Error('選択した Claude CLI アカウントが見つかりません。AI Apps でログイン状態を確認してください');
  if (expectedAccount && home.account !== expectedAccount) throw new Error('保存した実行アカウントが変わりました。実行アカウントを選び直してください');
  if (!session.cwd || !path.isAbsolute(session.cwd)) throw new Error('引き継ぐ作業フォルダを確認できません');
  if (!session.sourcePath || !path.isAbsolute(session.sourcePath) || !session.sourcePath.endsWith('.jsonl')) throw new Error('引き継ぐ Claude の会話ファイルを確認できません');
  const [transcript, cwd, config] = await Promise.all([
    fs.stat(session.sourcePath), fs.stat(session.cwd), fs.stat(home.dir),
  ]).catch(() => { throw new Error('会話ファイル・作業フォルダ・アカウントの保存先を確認できません'); });
  if (!transcript.isFile() || !cwd.isDirectory() || !config.isDirectory()) throw new Error('引き継ぎ元の会話または作業フォルダが利用できません');
  // Settings can take precedence over a profile's OAuth even after removing
  // inherited auth environment variables. Do not silently run a different payer.
  for (const file of [path.join(home.dir, 'settings.json'), path.join(session.cwd, '.claude/settings.json'), path.join(session.cwd, '.claude/settings.local.json')]) {
    let settings;
    try { settings = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw new Error('Claude の認証設定を確認できません'); }
    if (settings.apiKeyHelper || Object.keys(settings.env || {}).some(key => CLAUDE_AUTH_OVERRIDES.includes(key))) {
      throw new Error('Claude の設定に API 認証の上書きがあります。CLI アカウントで実行する設定にしてから再開してください');
    }
  }
  return { ...session, home: home.id, homeDir: home.dir, resumePath: session.sourcePath, executionAccount: home.account };
}

// Undefined uses the saved choice. Null/empty means the source profile, so
// queued requests keep the profile they had when they were added.
export function claudeExecutionChoice(state, cardId, explicitHome) {
  const saved = state.cards[cardId]?.claudeExecution;
  return explicitHome === undefined ? saved || null
    : explicitHome ? { homeId: explicitHome, account: saved?.homeId === explicitHome ? saved.account : null } : null;
}

export async function savedClaudeExecutionSession(session, state, explicitHome) {
  const choice = claudeExecutionChoice(state, session.id, explicitHome);
  return claudeExecutionSession(session, choice?.homeId, choice?.account);
}

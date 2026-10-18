// Desktop has its own OAuth login. Use it only for the account it is signed in to;
// never transplant CLI credentials or move the user's application data.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claudeDesktopRoots, invalidateDesktopRoots } from './accounts.mjs';

import { inspectDesktopRuntime } from './claude-desktop-runtime.mjs';

let processCheck = inspectDesktopRuntime;
const isRunning = status => typeof status === 'boolean' ? status : status?.running !== false;
export function setDesktopProcessCheck(check) { const previous = processCheck; processCheck = check; return previous; }

const identity = async dir => {
  try {
    const config = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
    return typeof config.lastKnownAccountUuid === 'string' && config.lastKnownAccountUuid ? `claude:${config.lastKnownAccountUuid}` : null;
  } catch { return null; }
};

// Pure layout (docs/claude-desktop-pure-layout-plan.md): one real Desktop data
// folder with one login. Canban never switches profiles or links; another account
// needs a Desktop sign-in switch by the user, or a CLI run.
export async function desktopProfilePlan(account, { platform = process.platform } = {}) {
  if (!/^claude:[A-Za-z0-9_-]{1,128}$/.test(account)) return { available: false, reason: 'Desktop のアカウントIDを確認できません' };
  if (platform !== 'darwin') return { available: false, reason: 'Desktop のアカウント確認は macOS に対応しています' };
  invalidateDesktopRoots();
  const current = (await claudeDesktopRoots()).find(r => r.default);
  const currentDir = await fs.realpath(current.dir).catch(() => null);
  const signedIn = currentDir && await identity(currentDir);
  if (signedIn === account) return { available: true, account, dir: currentDir, profile: current.name || '標準', defaultDir: current.dir, change: false };
  return { available: false, signedIn, reason: signedIn ? 'Desktop は別のアカウントでログイン中です。Desktop でログインを切り替えるか、CLI で実行してください' : 'Desktop のログインを確認できません。Desktop にログインしてから開いてください' };
}

// Runs the action only while Desktop is signed in to the account. A running app
// must be confirmed to have that data folder open.
export async function withDesktopAccount(account, action, options = {}) {
  const plan = await desktopProfilePlan(account, options);
  if (!plan.available) throw Object.assign(new Error(plan.reason), { code: 'desktop_unavailable' });
  const runtime = await processCheck(plan);
  if (isRunning(runtime) && runtime.profileDir !== plan.dir) throw Object.assign(new Error('起動中の Desktop の保存先を確認できません。Desktop を終了してから開いてください'), { code: 'desktop_running' });
  return action({ account, changed: false, maintained: true, pending: false, profile: plan.profile });
}

// Normal Desktop startup only searches ~/.claude/projects for CLI imports.
// A continue link is usable only when the selected account owns/reaches it.
export async function desktopExecutionLink(session, account, { cliHome = path.join(os.homedir(), '.claude'), platform = process.platform } = {}) {
  if (!/^claude:[A-Za-z0-9_-]{1,128}$/.test(account)) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session.nativeId)) return null;
  const projects = path.join(cliHome, 'projects');
  const source = await fs.realpath(session.sourcePath).catch(() => null);
  if (!source) return null;
  let reachable = false;
  for (const project of await fs.readdir(projects, { withFileTypes: true }).catch(() => [])) {
    if (!project.isDirectory() && !project.isSymbolicLink()) continue;
    const candidate = path.join(projects, project.name, `${session.nativeId}.jsonl`);
    if (await fs.realpath(candidate).catch(() => null) === source) { reachable = true; break; }
  }
  // A shared metadata ID alone can point at an older transcript after a CLI
  // handoff writes a newer copy in another home. Never open that stale copy.
  if (!reachable) return null;
  const nativeAccount = account.replace(/^claude:/, '');
  if (!session.archived && /^local_[A-Za-z0-9-]{1,64}$/.test(session.desktopSessionId || '')) {
    const plan = await desktopProfilePlan(account, { platform });
    if (plan.available) {
      const folder = path.join(plan.dir, 'claude-code-sessions', nativeAccount);
      for (const org of await fs.readdir(folder).catch(() => [])) {
        try {
          const metadata = JSON.parse(await fs.readFile(path.join(folder, org, `${session.desktopSessionId}.json`), 'utf8'));
          if (metadata.sessionId === session.desktopSessionId && metadata.cliSessionId === session.nativeId) return { url: `claude://code/continue?session=${session.desktopSessionId}`, exact: true, label: 'Claude で開く', note: '選択した Desktop アカウントで元の会話を開きます。' };
        } catch {}
      }
    }
  }
  return { url: `claude://resume?session=${session.nativeId}`, exact: true, label: 'Claude で開く', note: '選択した Desktop アカウントで同じ CLI 会話を取り込みます。' };
}

// Saving the CLI choice succeeds independently from Desktop's process lifecycle.
// Only expected availability/lifecycle failures are converted to pending status.
export async function saveClaudeExecutionAccount(account, commit, options = {}) {
  const execution = await commit();
  try {
    const desktop = await withDesktopAccount(account, async status => status, options);
    return { execution, desktop };
  } catch (error) {
    if (!['desktop_unavailable', 'desktop_running', 'desktop_busy'].includes(error.code)) throw error;
    return { execution, desktop: { maintained: false, pending: true, account, reason: error.message, code: error.code } };
  }
}

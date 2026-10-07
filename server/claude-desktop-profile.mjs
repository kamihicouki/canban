// Desktop has its own OAuth login. Reuse an existing, signed-in Desktop profile;
// never transplant CLI credentials or move the user's application data.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { claudeDesktopRoots, invalidateDesktopRoots } from './accounts.mjs';

let processCheck = async () => {
  const commands = await new Promise((resolve, reject) => execFile('/bin/ps', ['-axo', 'command='], { timeout: 5000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  return commands.split('\n').some(line => /\/Claude\.app\/Contents\/(?:MacOS|Frameworks)\//.test(line));
};
export function setDesktopProcessCheck(check) { const previous = processCheck; processCheck = check; return previous; }

const identity = async dir => {
  try {
    const config = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
    return typeof config.lastKnownAccountUuid === 'string' && config.lastKnownAccountUuid ? `claude:${config.lastKnownAccountUuid}` : null;
  } catch { return null; }
};

export async function desktopProfilePlan(account, { platform = process.platform } = {}) {
  if (!/^claude:[A-Za-z0-9_-]{1,128}$/.test(account)) return { available: false, reason: 'Desktop のアカウントIDを確認できません' };
  if (platform !== 'darwin') return { available: false, reason: 'Desktop のアカウント維持は macOS の既存プロフィールに対応しています' };
  invalidateDesktopRoots();
  const roots = await claudeDesktopRoots();
  const current = roots.find(r => r.default);
  const currentDir = await fs.realpath(current.dir).catch(() => null);
  if (currentDir && await identity(currentDir) === account) return { available: true, account, dir: currentDir, profile: current.name || '標準', defaultDir: current.dir, change: false };
  const candidates = [];
  for (const root of roots.filter(r => !r.default)) {
    const dir = await fs.realpath(root.dir).catch(() => null);
    if (dir && await identity(dir) === account) candidates.push(dir);
  }
  // The active switcher already identifies its profile family. A legacy
  // Claude-* backup outside that family must not make its unique match ambiguous.
  const family = currentDir && path.dirname(currentDir);
  const inFamily = path.basename(family || '') === 'Claude-Profiles' ? candidates.filter(dir => path.dirname(dir) === family) : [];
  const choices = inFamily.length ? inFamily : candidates;
  if (choices.length !== 1) return { available: false, reason: choices.length ? '同じアカウントの Desktop プロフィールが複数あります。通常起動するプロフィールを先に選んでください' : 'このアカウントでログイン済みの Desktop プロフィールがありません。Desktop のプロフィールを用意してから選んでください' };
  const stat = await fs.lstat(current.dir).catch(() => null);
  if (!stat?.isSymbolicLink()) return { available: false, reason: 'Desktop の保存先がプロフィール切替用のリンクになっていません。既存データを移動せずに切り替えるため、先に Desktop のプロフィール構成を用意してください' };
  const support = await fs.realpath(path.dirname(current.dir));
  const known = currentDir && (path.dirname(currentDir) === path.join(support, 'Claude-Profiles') || (path.dirname(currentDir) === support && /^Claude-/.test(path.basename(currentDir))));
  if (!known) return { available: false, reason: 'Desktop の現在の保存先が既知のプロフィールではありません。リンクを変更せず、CLI の選択だけを保存します' };
  return { available: true, account, dir: choices[0], profile: path.basename(choices[0]).replace(/^Claude-/, ''), defaultDir: current.dir, change: true };
}

// Hold the filesystem lock through the caller's DB commit/open. Atomic rename
// replaces only the existing symlink. Roll back on failure if it is still ours.
export async function withDesktopAccount(account, action, options = {}) {
  const plan = await desktopProfilePlan(account, options);
  if (!plan.available) throw new Error(plan.reason);
  const lock = path.join(path.dirname(plan.defaultDir), '.canban-claude-profile.lock');
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Desktop のプロフィール切替が進行中です。完了してから再操作してください'); throw error; }
  const temporary = `${plan.defaultDir}.canban-${randomUUID()}`;
  let previous, changed = false;
  try {
    const fresh = await desktopProfilePlan(account, options);
    if (!fresh.available || fresh.dir !== plan.dir) throw new Error('Desktop のプロフィールが変わりました。実行アカウントを選び直してください');
    // A link can have been changed externally while an old app is still open.
    // The app's loaded login cannot be inferred from a symlink/config snapshot.
    if (await processCheck()) throw new Error('Claude Desktop を終了してから実行アカウントを適用してください。起動中のアカウントは保存先だけでは確認できません');
    if (fresh.change) {
      previous = await fs.readlink(plan.defaultDir);
      if (await identity(plan.dir) !== account) throw new Error('Desktop のログインアカウントが変わりました');
      await fs.symlink(plan.dir, temporary);
      if (await processCheck()) throw new Error('Claude Desktop が起動しました。終了してから再操作してください');
      // A separate profile switcher must not be silently overwritten.
      if (await fs.readlink(plan.defaultDir) !== previous) throw new Error('別の操作で Desktop のプロフィールが切り替わりました');
      await fs.rename(temporary, plan.defaultDir);
      changed = true;
      invalidateDesktopRoots();
    }
    if (await fs.realpath(plan.defaultDir) !== plan.dir || await identity(plan.dir) !== account) throw new Error('Desktop の実行アカウントを確認できません');
    return await action({ account, changed, maintained: true });
  } catch (error) {
    if (changed) {
      // Never switch a running app's data directory back, or overwrite a newer
      // external choice. Report a failed rollback rather than claim success.
      if (await processCheck() || await fs.realpath(plan.defaultDir).catch(() => null) !== plan.dir) throw new Error(`${error.message}。Desktop の保存先は切替後のままです。アプリを終了してプロフィールを確認してください`);
      await fs.symlink(previous, temporary);
      await fs.rename(temporary, plan.defaultDir);
      invalidateDesktopRoots();
    }
    throw error;
  } finally {
    await fs.unlink(temporary).catch(() => {});
    await fs.rmdir(lock);
  }
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

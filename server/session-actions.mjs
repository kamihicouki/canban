// Agent-owned lifecycle operations. Never substitute a Canban visibility flag.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { resolveBin, cleanEnv } from './dispatch.mjs';
import { codexHome } from './sources/codex.mjs';
import { findDesktopArchive } from './codex-desktop-bridge.mjs';

export function sessionActions(session) {
  const reason = session.agent !== 'codex'
    ? 'Claudeのアーカイブ・削除を外部から実行するAPIが利用できません。Claudeで操作してください。'
    : session.host?.local === false ? 'このリモート接続の履歴操作には対応していません。Codexで操作してください。'
    : ['running', 'waiting'].includes(session.status) ? '実行中・入力待ちのセッションは、Codexで停止してから操作してください。' : null;
  return { available: !reason, reason };
}

export async function codexLifecycle(session, action, { spawnChild = spawn, bin = resolveBin('codex'), timeoutMs = 30000, dataDir, desktopArchive } = {}) {
  if (!['archive', 'restore', 'delete'].includes(action)) throw new Error('セッション操作が不正です');
  const capability = sessionActions(session);
  if (!capability.available) throw new Error(capability.reason);
  if (!session.nativeId || typeof session.nativeId !== 'string') throw new Error('CodexのセッションIDがありません');
  const desktop = desktopArchive || (dataDir ? await findDesktopArchive(session, dataDir) : null);
  const result = { cardId: session.id, action, agent: 'codex' };
  if (desktop && action !== 'delete') {
    await desktop(action === 'archive');
    return result;
  }
  try { await standaloneLifecycle(session, action, { spawnChild, bin, timeoutMs }); }
  catch (error) {
    if (!/already has an active writer/.test(error.message)) throw error;
    if (!desktop) throw new Error('Codexデスクトップがこのセッションを保持しています。CodexのCanbanプラグインを再接続してから操作してください');
    if (action !== 'delete') { await desktop(action === 'archive'); return result; }
    await desktop(true); // The owner archives and releases its writer normally.
    try { await standaloneLifecycle(session, 'delete', { spawnChild, bin, timeoutMs }); }
    catch (deleteError) {
      if (!session.archived) {
        try { await desktop(false); }
        catch { throw new Error(`${deleteError.message}。削除は完了していません。Codex側ではアーカイブ済みです。状態を再取得してください`); }
      }
      throw deleteError;
    }
  }
  return result;
}

async function standaloneLifecycle(session, action, { spawnChild, bin, timeoutMs }) {
  if (!bin) throw new Error('Codex CLIが見つかりません');
  const child = spawnChild(bin, ['app-server', '--listen', 'stdio://'], {
    env: { ...cleanEnv(process.env), CODEX_HOME: session.homeDir || codexHome() }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let next = 0;
  const fail = error => { for (const { reject } of pending.values()) reject(error); pending.clear(); };
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('exit', () => fail(new Error('Codex App Serverが操作完了前に終了しました')));
  child.stderr.on('data', () => {}); // vendor diagnostics may contain account information
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const request = pending.get(message.id); if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`Codex: ${message.error.message || '操作に失敗しました'}`));
    else request.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++next; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', error => { if (error) fail(error); });
  });
  const timer = setTimeout(() => { fail(new Error('Codexの操作がタイムアウトしました。状態を再取得して確認してください')); child.kill(); }, timeoutMs);
  try {
    await request('initialize', { clientInfo: { name: 'canban', title: 'Canban', version: '1.0.0' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
    await request(action === 'restore' ? 'thread/unarchive' : `thread/${action}`, { threadId: session.nativeId });
  } finally { clearTimeout(timer); lines.close(); child.stdin.end(); child.kill(); }
}

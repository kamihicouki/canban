// Preparing a remote thread never starts a turn. The remote reservation owns
// retries; transport uncertainty must not become a second thread/start.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function prepareCodexDesktop({ host, cwd, clientRequestId }, { pool, verify } = {}) {
  if (!host?.id || host.local !== false || typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0') || cwd.length > 4096 || !/^[A-Za-z0-9_-]{1,128}$/.test(clientRequestId || '')) throw new Error('リモートDesktopの開始先・要求IDが不正です');
  const base = { hostId: host.id, cwd };
  try {
    const result = await pool.prepareDesktop(host, { clientRequestId, cwd });
    if (result.state === 'failed') return { ...base, state:'failed', reason:result.reason || '接続先のCodex CLIを確認してください' };
    if (result.state !== 'prepared' || !UUID.test(result.threadId || '') || result.hostId !== host.id || result.cwd !== cwd || result.writerClosed !== true || verify && !await verify(result, host)) return { ...base, state:'uncertain', reason:'接続先のスレッドと作業フォルダを確認できません' };
    return { ...base, state:'prepared', threadId:result.threadId, writerClosed:true };
  } catch { return { ...base, state:'uncertain', reason:'リモートの準備結果を確認できません。同じ依頼を自動で作り直しません' }; }
}

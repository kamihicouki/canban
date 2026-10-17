// Durable Desktop starts. The input is private; status exposes only the outcome.
// A process which dies after an external intent cannot safely repeat that intent.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inspectProfileDirectory, readDesktopJson } from './claude-desktop-roots.mjs';
import { desktopProfileLock } from './claude-desktop-lock.mjs';

const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const final = new Set(['opened', 'uncertain', 'failed', 'cancelled']);
const unknown = () => ({ state: 'uncertain', reason: '起動結果を確認できません。アプリを確認してください。同じ依頼を自動で開き直すことはありません。' });

export function createDesktopLaunches({ dataDir, accounts, resolveTarget, prepareThread, open, now = Date.now }) {
  const dir = path.join(dataDir, 'desktop-launches');
  function files(id) {
    if (!validId(id)) throw new Error('開始リクエストが不正です');
    return { record: path.join(dir, `${id}.json`), lock: path.join(dir, `${id}.lock`), cancel: path.join(dir, `${id}.cancel`) };
  }
  const read = readDesktopJson;
  async function save(file, record) {
    const temp = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
    try { await fs.rename(temp, file); const d = await fs.open(dir, 'r'); try { await d.sync(); } finally { await d.close(); } }
    finally { await fs.rm(temp, { force: true }); }
  }
  const result = record => ({ clientRequestId: record.input.clientRequestId, route: 'desktop', account: record.input.account || null, imageIds: record.input.imageIds || [], ...(record.input.imageIds?.length ? { attachmentState: 'pending-paste' } : {}), ...record.result });
  async function start(input, { uiAuthorized = false } = {}) {
    const id = input.clientRequestId || randomUUID(), f = files(id);
    const { uiToken: omitted, allowDesktopSwitch, allowQuit, ...payload } = input;
    payload.clientRequestId = id;
    const fingerprint = createHash('sha256').update(stable(payload)).digest('hex');
    await inspectProfileDirectory(await fs.realpath(dataDir));
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await inspectProfileDirectory(dir);
    let lease;
    try { lease = await desktopProfileLock(f.lock); }
    catch (e) {
      if (e.code !== 'desktop_busy') throw e;
      const existing = await read(f.record);
      if (existing && existing.fingerprint !== fingerprint) throw new Error('開始要求の内容が一致しません');
      return existing ? result(existing) : { clientRequestId: id, state: 'prepared', reason: '開始要求を確認中です' };
    }
    try {
      let record = await read(f.record);
      if (record && record.fingerprint !== fingerprint) throw new Error('開始要求の内容を変更して再送できません');
      if (record && final.has(record.result.state)) return result(record);
      if (record?.intent) { record.result = unknown(); await save(f.record, record); return result(record); }
      if (!record) record = { fingerprint, input: payload, permissions: {}, createdAt: now(), result: { state: 'prepared' } };
      if (uiAuthorized) {
        record.permissions.allowSwitch ||= allowDesktopSwitch === true;
        record.permissions.allowQuit ||= allowQuit === true;
      }
      await save(f.record, record);
      const cancelled = async () => !!await read(f.cancel);
      const set = async r => { record.result = r; await lease.assertHeld(); await save(f.record, record); return result(record); };
      if (await cancelled()) return set({ state: 'cancelled', reason: '開始を取り消しました。本文と画像は保持しています' });
      let target;
      try { target = await resolveTarget(payload); }
      catch { return set({ state: 'failed', reason: '開始先を確認できません。接続先を選び直してください' }); }
      if (!target || record.target && stable(record.target) !== stable(target)) return set({ state: 'failed', reason: '開始先が変更されました。接続先を確認してください' });
      record.target = target; await save(f.record, record);
      const perform = async () => {
        if (await cancelled()) return set({ state: 'cancelled' });
        if (prepareThread && target.prepareThread !== false && !record.thread) {
          record.intent = 'prepare-thread'; await save(f.record, record);
          try {
            record.thread = await prepareThread(payload, target);
            if (record.thread?.state === 'uncertain' || record.thread?.state === 'failed') return set(record.thread);
          } catch { return set(unknown()); }
          delete record.intent; await save(f.record, record);
        }
        if (await cancelled()) return set({ state: 'cancelled' });
        // Resolve again inside the account lease before issuing the external intent.
        let current;
        try { current = await resolveTarget(payload); } catch { current = null; }
        if (stable(current) !== stable(target)) return set({ state: 'failed', reason: '開始先が変更されました' });
        record.intent = 'open'; await set({ state: 'opening' });
        if (await cancelled()) { delete record.intent; return set({ state: 'cancelled' }); }
        try {
          const opened = await open(payload, target, record.thread);
          delete record.intent;
          return set({ ...opened, state: 'opened' });
        } catch { return set(unknown()); }
      };
      try {
        if (accounts && payload.agent === 'claude' && payload.account) {
          const response = await accounts.withAccount(payload.account, { requestId: id, ...record.permissions }, perform);
          if (['waiting-for-quit', 'waiting-for-login'].includes(response?.state)) return set(response);
          return response;
        }
        return await perform();
      } catch (e) {
        if (record.intent) return set(unknown());
        if (['desktop_busy', 'desktop_running'].includes(e.code)) return set({ state: 'waiting-for-quit', reason: e.message });
        if (e.code === 'desktop_unavailable') return set({ state: 'waiting-for-login', reason: e.message });
        return set({ state: 'failed', reason: 'Desktop の準備を完了できませんでした' });
      }
    } finally { await lease.release(); }
  }
  async function status(id) {
    const record = await read(files(id).record);
    if (!record) return null;
    if (!final.has(record.result.state) && !record.intent && await read(files(id).cancel)) return { ...result(record), state: 'cancelled' };
    return result(record);
  }
  async function cancel(id, { uiAuthorized = false } = {}) {
    if (!uiAuthorized) throw new Error('この操作はボードUIから確認してください');
    const f = files(id), record = await read(f.record);
    if (!record) return null;
    if (final.has(record.result.state) || record.intent) return result(record);
    await save(f.cancel, { at: now() });
    const current = await read(f.record);
    if (current?.intent || final.has(current?.result?.state)) return result(current);
    return { ...result(record), state: 'cancelled', reason: '開始を取り消しました。CLI の処理と下書きは保持しています' };
  }
  async function recover() {
    const names = await fs.readdir(dir).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    const results = [];
    for (const name of names.filter(n => /^[A-Za-z0-9_-]+\.json$/.test(n))) {
      const record = await read(path.join(dir, name));
      if (record && !final.has(record.result?.state)) results.push(await start(record.input));
    }
    return results;
  }
  return { start, status, cancel, recover };
}

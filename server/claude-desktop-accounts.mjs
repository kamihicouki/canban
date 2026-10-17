// Owns Desktop profile changes only. CLI homes, tokens and Keychain entries are
// deliberately absent from this interface.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withDesktopMutationLock } from './claude-desktop-lock.mjs';
import { desktopAccountPaths, desktopError, inspectProfileDirectory, optionalStat, readDesktopIdentity, readDesktopJson, readDesktopRegistry, readDesktopProfileRoots, validDesktopAccount } from './claude-desktop-roots.mjs';
import { moveProfileDirectory, recoverDesktopProfiles, switchDesktopProfiles, writeDesktopRecord } from './claude-desktop-journal.mjs';
import { seedDesktopAccountHistory } from './claude-desktop-seed.mjs';

async function ensureState(paths) {
  for (const dir of [path.dirname(paths.state), paths.state, paths.profiles]) {
    try { await fs.mkdir(dir, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await inspectProfileDirectory(dir, { device: paths.device });
  }
}

async function saveRegistry(paths, registry) {
  // Refuse an unexpected destination, including a symlink, before replacing it.
  await readDesktopJson(paths.registry);
  const temp = path.join(paths.state, `.registry-${randomUUID()}.tmp`);
  let file;
  try {
    file = await fs.open(temp, 'wx', 0o600);
    await file.writeFile(JSON.stringify(registry) + '\n');
    await file.sync(); await file.close(); file = null;
    await fs.rename(temp, paths.registry);
    const dir = await fs.open(paths.state, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await file?.close(); await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export function createDesktopAccounts({ dataDir, appDir, identity = readDesktopIdentity, runtime = async () => ({ running: true, profileDir: null }), quit, restoreGuests, backup, open, move = moveProfileDirectory } = {}) {
  const locations = () => desktopAccountPaths({ dataDir, appDir });
  const runtimeState = async plan => { try { return await runtime(plan); } catch { return { running: true, profileDir: null, unknown: true }; } };
  const waiting = (account, reason = 'Desktop を保存して終了すると、同じ依頼で切替を続けられます') => ({ state: 'waiting-for-quit', account, reason });
  async function restore(lease) {
    const restored = await restoreGuests?.({ lease });
    if (restored?.problems?.length || restored?.running) throw desktopError(`ゲストの書戻しを完了できません: ${(restored?.problems || ['Desktop が起動しています']).join('、')}`);
  }
  async function enrollment(input) {
    if (Object.keys(input).some(k => !['type', 'account', 'requestId'].includes(k)) || input.type !== 'cancel' && !validDesktopAccount(input.account)) throw desktopError('Desktop の初回接続要求が不正です');
    const paths = await locations(); await ensureState(paths);
    return withDesktopMutationLock({ dataDir: paths.dataDir, lease: null }, async lease => {
      try {
        await recoverDesktopProfiles(paths, { lease, runtime: runtimeState, move });
        let registry = await readDesktopRegistry(paths), pending = registry.pending;
        const waitingLogin = p => ({ state: 'waiting-for-login', account: p.expectedAccount, profileId: p.id, reason: 'Desktop 自身で選択したアカウントへログインし、接続を確認してください' });
        if (input.type === 'finish-login') {
          if (!pending?.active) {
            const registered = registry.profiles.find(p => p.active && p.account === input.account);
            if (registered && await identity(paths.appDir) === input.account) return { state: 'prepared', account: registered.account, profileId: registered.id };
          }
          if (!pending?.active || input.account !== pending.expectedAccount) throw desktopError('確認する Desktop の接続が一致しません');
          if (await identity(paths.appDir) !== pending.expectedAccount) return waitingLogin(pending);
          const profile = { id: pending.id, account: pending.expectedAccount, active: true, dir: paths.appDir };
          await lease.assertHeld();
          await writeDesktopRecord(paths, 'registry.json', { version: 1, profiles: [...registry.profiles, profile], candidates: registry.candidates || [] });
          return { state: 'prepared', account: profile.account, profileId: profile.id };
        }
        if (input.type === 'cancel' && !pending?.active) return { state: 'cancelled', account: pending?.expectedAccount || null };
        if (input.type === 'begin-login') {
          const registered = registry.profiles.find(p => p.account === input.account);
          if (registered) return { state: 'prepared', account: registered.account, profileId: registered.id };
          if (pending?.active) {
            if (pending.expectedAccount !== input.account) throw desktopError('初回接続を取り消してからアカウントを選び直してください');
            return waitingLogin(pending);
          }
        }
        const status = await runtimeState({ defaultDir: paths.appDir });
        if (status !== false && status?.running !== false) return waiting(input.account || pending?.expectedAccount);
        await restore(lease);
        if (input.type === 'cancel') {
          const previous = registry.profiles.find(p => p.id === pending.previousId);
          if (!previous) throw desktopError('元の Desktop の保存先を確認できません');
          const requestId = input.requestId || randomUUID();
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw desktopError('Desktop の要求IDが不正です');
          await switchDesktopProfiles(paths, registry, previous, { requestId, lease, runtime: runtimeState, backup, move });
          await open?.({ purpose: 'restore', account: previous.account, profileId: previous.id });
          return { state: 'cancelled', account: pending.expectedAccount, profileId: pending.id };
        }
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId || '')) throw desktopError('Desktop の要求IDが不正です');
        const current = registry.profiles.find(p => p.active);
        if (!current || await identity(paths.appDir) !== current.account) throw desktopError('現在の Desktop を登録してから接続してください');
        const candidates = [...(registry.candidates || [])];
        if (pending && pending.expectedAccount !== input.account) candidates.push(pending);
        const candidate = pending?.expectedAccount === input.account ? pending : candidates.find(p => p.expectedAccount === input.account);
        pending = { id: candidate?.id || randomUUID(), expectedAccount: input.account, previousId: current.id, requestId: input.requestId, active: false, initialized: candidate?.initialized === true };
        registry = { ...registry, candidates: candidates.filter(p => p.id !== pending.id), pending };
        await lease.assertHeld(); await writeDesktopRecord(paths, 'registry.json', registry);
        const dir = path.join(paths.profiles, pending.id);
        if (!pending.initialized) {
          await seedDesktopAccountHistory(paths, registry, pending, { lease, runtime: runtimeState });
          pending.initialized = true;
          await lease.assertHeld(); await writeDesktopRecord(paths, 'registry.json', registry);
        } else await inspectProfileDirectory(dir, { device: paths.device });
        await switchDesktopProfiles(paths, registry, { id: pending.id, account: pending.expectedAccount, dir }, { requestId: input.requestId, lease, runtime: runtimeState, backup, move });
        await open?.({ purpose: 'login', account: pending.expectedAccount, profileId: pending.id });
        return waitingLogin(pending);
      } catch (error) { if (error.code === 'desktop_running') return waiting(input.account); throw error; }
    });
  }
  return {
    async view() {
      const roots = await readDesktopProfileRoots({ dataDir, appDir });
      const registry = await readDesktopRegistry(await locations());
      // A last-known account in config.json is not evidence of current OAuth validity.
      return { profiles: roots.map(p => ({ id: p.id, account: p.account, active: p.active, auth: 'unknown' })), ...(registry.pending ? { pending: { id: registry.pending.id, account: registry.pending.expectedAccount, active: registry.pending.active } } : {}) };
    },
    async command(input) {
      if (['begin-login', 'finish-login', 'cancel'].includes(input?.type)) return enrollment(input);
      if (input?.type === 'recover') {
        if (Object.keys(input).some(k => !['type', 'requestId'].includes(k))) throw desktopError('Desktop の復元要求が不正です');
        const paths = await locations(); await ensureState(paths);
        return withDesktopMutationLock({ dataDir: paths.dataDir, lease: null }, async lease => {
          const recovered = await recoverDesktopProfiles(paths, { lease, runtime: runtimeState, move });
          const current = (await readDesktopRegistry(paths)).profiles.find(p => p.active);
          return recovered || (current ? { state: 'prepared', account: current.account, profileId: current.id } : { state: 'failed', reason: 'Desktop を登録してください' });
        });
      }
      if (input?.type !== 'enroll-current' || !validDesktopAccount(input.account)) throw desktopError('Desktop の登録アカウントを確認してください');
      if (Object.keys(input).some(k => !['type', 'account', 'requestId'].includes(k))) throw desktopError('Desktop の登録に保存先や認証情報を指定できません');
      const paths = await locations();
      await inspectProfileDirectory(paths.appDir, { device: paths.device });
      if (await identity(paths.appDir) !== input.account) throw desktopError('Desktop にログイン中のアカウントが一致しません');
      await ensureState(paths);
      return withDesktopMutationLock({ dataDir: paths.dataDir, lease: null }, async lease => {
        await lease.assertHeld();
        if (await optionalStat(paths.journal)) throw desktopError('Desktop の切替記録を復元してから登録してください');
        const registry = await readDesktopRegistry(paths);
        if (await identity(paths.appDir) !== input.account) throw desktopError('Desktop にログイン中のアカウントが変わりました');
        const existing = registry.profiles.find(p => p.account === input.account);
        if (existing) {
          if (!existing.active || existing.dir !== paths.appDir) throw desktopError('このアカウントは別の保存先に登録されています');
          return { state: 'prepared', account: input.account, profileId: existing.id };
        }
        if (registry.profiles.some(p => p.active)) throw desktopError('登録済みの Desktop アカウントと一致しません');
        const profile = { id: randomUUID(), account: input.account, active: true, dir: paths.appDir };
        await lease.assertHeld();
        await saveRegistry(paths, { version: 1, profiles: [...registry.profiles, profile] });
        return { state: 'prepared', account: input.account, profileId: profile.id };
      });
    },
    async withAccount(account, { requestId, allowSwitch = false, allowQuit = false } = {}, action) {
      if (!validDesktopAccount(account) || typeof action !== 'function') throw desktopError('Desktop の開始要求が不正です');
      const paths = await locations(); await ensureState(paths);
      return withDesktopMutationLock({ dataDir: paths.dataDir, lease: null }, async lease => {
        try {
          await recoverDesktopProfiles(paths, { lease, runtime: runtimeState, move });
          const registry = await readDesktopRegistry(paths), target = registry.profiles.find(p => p.account === account);
          if (!target) return { state: 'waiting-for-login', account, reason: 'このアカウントの Desktop を接続してください' };
          const current = registry.profiles.find(p => p.active);
          if (!current || await identity(paths.appDir) !== current.account) return { state: 'waiting-for-login', account, reason: 'Desktop のログインを確認してください' };
          await readDesktopProfileRoots({ dataDir, appDir });
          let status = await runtimeState({ defaultDir: paths.appDir, dir: paths.appDir, account: current.account });
          if (status !== false && status?.running !== false && status?.profileDir !== paths.appDir) return waiting(account, '起動中の Desktop の保存先や状態を確認できません');
          if (target.active) {
            await lease.assertHeld();
            return action({ account, profileId: target.id, changed: false });
          }
          if (!allowSwitch) return waiting(account, 'Desktop の切替操作を選んでください。CLI の選択は維持しています');
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId || '')) throw desktopError('Desktop の要求IDが不正です');
          if (status !== false && status?.running !== false) {
            if (!allowQuit || status.busy !== false || status.draftsSaved !== true || typeof quit !== 'function') return waiting(account);
            await lease.assertHeld(); await quit();
            status = await runtimeState({ defaultDir: paths.appDir });
            if (status !== false && status?.running !== false) return waiting(account);
          }
          await restore(lease);
          await switchDesktopProfiles(paths, registry, target, { requestId, lease, runtime: runtimeState, backup, move });
          if (await identity(paths.appDir) !== account) return { state: 'waiting-for-login', account, reason: '切替先の Desktop のログインを確認してください' };
          await lease.assertHeld();
          return action({ account, profileId: target.id, changed: true });
        } catch (error) {
          if (error.code === 'desktop_running') return waiting(account);
          throw error;
        }
      });
    },
  };
}

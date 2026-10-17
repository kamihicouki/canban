// Owns Desktop profile changes only. CLI homes, tokens and Keychain entries are
// deliberately absent from this interface.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { desktopProfileLock } from './claude-desktop-lock.mjs';
import { desktopAccountPaths, desktopError, inspectProfileDirectory, optionalStat, readDesktopIdentity, readDesktopJson, readDesktopRegistry, readDesktopProfileRoots, validDesktopAccount } from './claude-desktop-roots.mjs';

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

export function createDesktopAccounts({ dataDir, appDir, identity = readDesktopIdentity } = {}) {
  const locations = () => desktopAccountPaths({ dataDir, appDir });
  return {
    async view() {
      const roots = await readDesktopProfileRoots({ dataDir, appDir });
      // A last-known account in config.json is not evidence of current OAuth validity.
      return { profiles: roots.map(p => ({ id: p.id, account: p.account, active: p.active, auth: 'unknown' })) };
    },
    async command(input) {
      if (input?.type !== 'enroll-current' || !validDesktopAccount(input.account)) throw desktopError('Desktop の登録アカウントを確認してください');
      if (Object.keys(input).some(k => !['type', 'account', 'requestId'].includes(k))) throw desktopError('Desktop の登録に保存先や認証情報を指定できません');
      const paths = await locations();
      await inspectProfileDirectory(paths.appDir, { device: paths.device });
      if (await identity(paths.appDir) !== input.account) throw desktopError('Desktop にログイン中のアカウントが一致しません');
      await ensureState(paths);
      const lease = await desktopProfileLock(paths.lock);
      try {
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
      } finally { await lease.release(); }
    },
  };
}

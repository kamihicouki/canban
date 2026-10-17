// Read-only profile discovery. This module must not import accounts, runtime or
// the mutation service: scanners and the lifecycle service both depend on it.
import fs from 'node:fs/promises';
import path from 'node:path';

export const validDesktopAccount = value => typeof value === 'string' && /^claude:[A-Za-z0-9_-]{1,128}$/.test(value);
const validId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export const desktopError = message => Object.assign(new Error(message), { code: 'desktop_unavailable' });
export async function optionalStat(file) {
  try { return await fs.lstat(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function inspectProfileDirectory(dir, { uid = process.getuid?.(), device } = {}) {
  const st = await optionalStat(dir);
  if (!st || !st.isDirectory() || st.isSymbolicLink()) throw desktopError('保存先は実ディレクトリである必要があります');
  if (uid !== undefined && st.uid !== BigInt(uid)) throw desktopError('保存先の所有者が一致しません');
  if (device !== undefined && st.dev !== BigInt(device)) throw desktopError('保存先は同じファイルシステムに置いてください');
  return { dir: await fs.realpath(dir), device: String(st.dev), inode: String(st.ino) };
}

export async function desktopAccountPaths({ dataDir, appDir }) {
  if (!path.isAbsolute(dataDir || '') || !path.isAbsolute(appDir || '')) throw desktopError('Desktop の保存先を確認できません');
  const data = await inspectProfileDirectory(dataDir);
  const app = path.join(await fs.realpath(path.dirname(appDir)), path.basename(appDir));
  const state = path.join(data.dir, 'desktop-accounts', 'claude');
  for (const dir of [path.dirname(state), state, path.join(state, 'profiles')]) {
    if (await optionalStat(dir)) await inspectProfileDirectory(dir, { device: data.device });
  }
  return { dataDir: data.dir, device: data.device, appDir: app, state, profiles: path.join(state, 'profiles'), registry: path.join(state, 'registry.json'), journal: path.join(state, 'switch.json'), lock: path.join(state, 'lifecycle.lock') };
}

export async function readDesktopJson(file) {
  const st = await optionalStat(file);
  if (!st) return null;
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1n || st.size > 128n * 1024n || process.getuid && st.uid !== BigInt(process.getuid())) throw desktopError('Desktop の記録は所有者が一致する通常ファイルである必要があります');
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { throw desktopError('Desktop の記録を読み取れません'); }
}

export async function readDesktopIdentity(dir) {
  const config = await readDesktopJson(path.join(dir, 'config.json'));
  const account = config?.lastKnownAccountUuid && `claude:${config.lastKnownAccountUuid}`;
  return validDesktopAccount(account) ? account : null;
}

export async function readDesktopRegistry(paths) {
  const value = await readDesktopJson(paths.registry);
  if (!value) return { version: 1, profiles: [] };
  return validateDesktopRegistry(paths, value);
}

export function validateDesktopRegistry(paths, value) {
  if (value?.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length > 32) throw desktopError('Desktop の対応表を確認できません');
  const ids = new Set(), accounts = new Set();
  let active = 0;
  for (const p of value.profiles) {
    if (!validId(p?.id) || !validDesktopAccount(p.account) || typeof p.active !== 'boolean' || ids.has(p.id) || accounts.has(p.account)) throw desktopError('Desktop の対応表に不正なアカウントがあります');
    const expected = p.active ? paths.appDir : path.join(paths.profiles, p.id);
    if (p.dir !== expected) throw desktopError('Desktop の保存先が対応表と一致しません');
    ids.add(p.id); accounts.add(p.account); active += Number(p.active);
  }
  if (active > 1) throw desktopError('有効な Desktop プロフィールを1つにしてください');
  return value;
}

export async function readDesktopProfileRoots(options) {
  const paths = await desktopAccountPaths(options), registry = await readDesktopRegistry(paths);
  const roots = [];
  for (const p of registry.profiles) {
    const checked = await inspectProfileDirectory(p.dir, { device: paths.device });
    const account = await readDesktopIdentity(checked.dir);
    if (account && account !== p.account) throw desktopError('Desktop の保存先のアカウントが対応表と一致しません');
    roots.push({ ...p, dir: checked.dir, sessionsDir: path.join(checked.dir, 'claude-code-sessions') });
  }
  return roots;
}

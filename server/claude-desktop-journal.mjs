// Durable intent and recovery for two exclusive directory renames. All callers
// hold the lifecycle lease; neither recovery nor a switch overwrites a directory.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { desktopError, inspectProfileDirectory, optionalStat, readDesktopJson, validateDesktopRegistry } from './claude-desktop-roots.mjs';

async function syncDir(dir) {
  const handle = await fs.open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function writeDesktopRecord(paths, name, value) {
  if (!['registry.json', 'switch.json'].includes(name)) throw desktopError('Desktop の記録先が不正です');
  await inspectProfileDirectory(paths.state, { device: paths.device });
  const destination = path.join(paths.state, name);
  await readDesktopJson(destination);
  const temp = path.join(paths.state, `.${name}-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value) + '\n');
    await handle.sync(); await handle.close(); handle = null;
    await fs.rename(temp, destination); await syncDir(paths.state);
  } finally {
    await handle?.close();
    await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function clearJournal(paths) {
  await readDesktopJson(paths.journal);
  await fs.unlink(paths.journal); await syncDir(paths.state);
}

export async function moveProfileDirectory(from, to) {
  if (![from, to].every(p => typeof p === 'string' && path.isAbsolute(p) && !p.includes('\0'))) throw desktopError('Desktop の移動先が不正です');
  const helper = fileURLToPath(new URL('./desktop-files.py', import.meta.url));
  await new Promise((resolve, reject) => execFile('python3', [helper, from, to], { timeout: 15000, maxBuffer: 4096 }, error => {
    if (!error) resolve();
    else reject(desktopError('Desktop の保存先を上書きせずに移動できませんでした'));
  }));
  await syncDir(path.dirname(from));
  if (path.dirname(from) !== path.dirname(to)) await syncDir(path.dirname(to));
}

const matches = (st, expected) => st?.isDirectory() && !st.isSymbolicLink() && String(st.dev) === expected.device && String(st.ino) === expected.inode;
const stat = file => optionalStat(file);
async function stopped(runtime, paths, lease) {
  await lease.assertHeld();
  const state = await runtime({ defaultDir: paths.appDir });
  if (state !== false && state?.running !== false) throw Object.assign(new Error('Desktop の終了を待っています'), { code: 'desktop_running' });
}
async function checkedMove(paths, lease, runtime, move, from, to, expected) {
  await stopped(runtime, paths, lease);
  await inspectProfileDirectory(path.dirname(to), { device: paths.device });
  if (!matches(await stat(from), expected) || await stat(to)) throw desktopError('Desktop の保存先が変わったため停止しました');
  await lease.assertHeld();
  await move(from, to);
  await lease.assertHeld();
  if (!matches(await stat(to), expected)) throw desktopError('移動した Desktop の実体を確認できません');
}

export async function switchDesktopProfiles(paths, registry, target, { requestId, lease, runtime, backup, move = moveProfileDirectory }) {
  const pending = registry.pending;
  const current = registry.profiles.find(p => p.active) || (pending?.active ? { id: pending.id, account: pending.expectedAccount, dir: paths.appDir } : null);
  if (!current || current.id === target.id) throw desktopError('切替前の Desktop を確認できません');
  const from = { id: current.id, account: current.account, ...await inspectProfileDirectory(current.dir, { device: paths.device }) };
  const to = { id: target.id, account: target.account, ...await inspectProfileDirectory(target.dir, { device: paths.device }) };
  const parked = path.join(paths.profiles, from.id);
  if (await stat(parked) || await stat(paths.journal)) throw desktopError('前回の Desktop の切替を復元してください');
  await stopped(runtime, paths, lease);
  if (typeof backup !== 'function') throw desktopError('プロフィールを保全するバックアップが必要です');
  const backupDir = await backup({ requestId, profiles: [current, target] });
  if (typeof backupDir !== 'string' || !path.isAbsolute(backupDir)) throw desktopError('Desktop のバックアップを確認できません');
  await inspectProfileDirectory(backupDir);
  const kind = pending?.active ? 'cancel-login' : pending?.id === target.id ? 'login' : 'switch';
  const journal = { version: 1, requestId, kind, phase: 'parking', from, to, registry, backupDir };
  await lease.assertHeld(); await writeDesktopRecord(paths, 'switch.json', journal);
  await checkedMove(paths, lease, runtime, move, paths.appDir, parked, from);
  journal.phase = 'parked'; await writeDesktopRecord(paths, 'switch.json', journal);
  journal.phase = 'activating'; await writeDesktopRecord(paths, 'switch.json', journal);
  await checkedMove(paths, lease, runtime, move, target.dir, paths.appDir, to);
  journal.phase = 'activated'; await writeDesktopRecord(paths, 'switch.json', journal);
  await commitActivated(paths, journal, lease);
}

function switchedRegistry(paths, journal) {
  const value = { ...journal.registry, profiles: journal.registry.profiles.map(p => ({ ...p, active: p.id === journal.to.id, dir: p.id === journal.to.id ? paths.appDir : path.join(paths.profiles, p.id) })) };
  if (journal.kind === 'login' || journal.kind === 'cancel-login') value.pending = { ...journal.registry.pending, active: journal.kind === 'login' };
  return value;
}
async function commitActivated(paths, journal, lease) {
  await lease.assertHeld();
  await writeDesktopRecord(paths, 'registry.json', switchedRegistry(paths, journal));
  journal.phase = 'committed'; await writeDesktopRecord(paths, 'switch.json', journal);
  await clearJournal(paths);
}

export async function recoverDesktopProfiles(paths, { lease, runtime, move = moveProfileDirectory }) {
  const journal = await readDesktopJson(paths.journal);
  if (!journal) return null;
  validateDesktopRegistry(paths, journal.registry);
  const pending = journal.registry.pending;
  const pendingProfile = pending && { id: pending.id, account: pending.expectedAccount, dir: pending.active ? paths.appDir : path.join(paths.profiles, pending.id) };
  const from = journal.kind === 'cancel-login' && pending?.active ? pendingProfile : journal.registry.profiles.find(p => p.id === journal.from?.id && p.active);
  const to = journal.kind === 'login' && pending && !pending.active ? pendingProfile : journal.registry.profiles.find(p => p.id === journal.to?.id && !p.active);
  if (journal.version !== 1 || !from || !to || from.account !== journal.from.account || to.account !== journal.to.account ||
      from.id !== journal.from.id || to.id !== journal.to.id || !['switch', 'login', 'cancel-login'].includes(journal.kind) ||
      journal.from.dir !== paths.appDir || journal.to.dir !== path.join(paths.profiles, to.id) ||
      ![journal.from, journal.to].every(p => /^\d+$/.test(p.device) && /^\d+$/.test(p.inode)) ||
      !['parking', 'parked', 'activating', 'activated', 'committed', 'rolling-back'].includes(journal.phase)) throw desktopError('Desktop の復元記録を確認できません');
  await stopped(runtime, paths, lease);
  const parked = path.join(paths.profiles, from.id);
  const [activeStat, fromStat, toStat] = await Promise.all([stat(paths.appDir), stat(parked), stat(to.dir)]);
  if (matches(activeStat, journal.to) && matches(fromStat, journal.from) && !toStat) {
    await commitActivated(paths, journal, lease);
    return { state: 'prepared', account: to.account, profileId: to.id };
  }
  if (!activeStat && matches(fromStat, journal.from) && matches(toStat, journal.to)) {
    journal.phase = 'rolling-back'; await writeDesktopRecord(paths, 'switch.json', journal);
    await checkedMove(paths, lease, runtime, move, parked, paths.appDir, journal.from);
  } else if (!matches(activeStat, journal.from) || fromStat || !matches(toStat, journal.to)) {
    throw desktopError('Desktop の保存先が外部で変わりました。上書きせず復元を停止しました');
  }
  await lease.assertHeld();
  await writeDesktopRecord(paths, 'registry.json', journal.registry);
  await clearJournal(paths);
  return { state: 'prepared', account: from.account, profileId: from.id };
}

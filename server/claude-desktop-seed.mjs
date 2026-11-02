// Seed account-scoped conversations only. Global storage, login configuration,
// Keychain and CLI homes never enter a new account's profile.
import fs from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { desktopError, inspectProfileDirectory, optionalStat } from './claude-desktop-roots.mjs';

async function snapshot(root) {
  const entries = new Map();
  async function visit(relative) {
    const file = path.join(root, relative), st = await optionalStat(file);
    if (!st) throw desktopError('引継ぎ元の会話が変更されました');
    if (process.getuid && st.uid !== BigInt(process.getuid()) || st.isSymbolicLink()) throw desktopError('会話の所有者と実体を確認してください');
    if (st.isDirectory()) {
      entries.set(relative, 'directory');
      for (const name of (await fs.readdir(file)).sort()) await visit(path.join(relative, name));
    } else {
      if (!st.isFile() || st.nlink !== 1n) throw desktopError('会話は所有者が一致する通常ファイルである必要があります');
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file, { flags: constants.O_RDONLY | constants.O_NOFOLLOW })) hash.update(chunk);
      entries.set(relative, hash.digest('hex'));
    }
  }
  await visit(''); return entries;
}

export async function seedDesktopAccountHistory(paths, registry, pending, { lease, runtime }) {
  const account = pending.expectedAccount.slice('claude:'.length), sources = [];
  for (const profile of registry.profiles) {
    await inspectProfileDirectory(profile.dir, { device: paths.device });
    const sessions = path.join(profile.dir, 'claude-code-sessions');
    if (!await optionalStat(sessions)) continue;
    await inspectProfileDirectory(sessions, { device: paths.device });
    const dir = path.join(sessions, account);
    if (await optionalStat(dir)) {
      await inspectProfileDirectory(dir, { device: paths.device });
      sources.push({ dir, entries: await snapshot(dir) });
    }
  }
  if (sources.length > 1) throw desktopError('同じアカウントの履歴が複数の保存先にあります。引継ぎ元を確認してください');
  const target = path.join(paths.profiles, pending.id), source = sources[0];
  const prefix = path.join('claude-code-sessions', account);
  const expected = new Map([['', 'directory']]);
  if (source) {
    expected.set('claude-code-sessions', 'directory');
    for (const [name, value] of source.entries) expected.set(path.join(prefix, name), value);
  }
  const stopped = async () => {
    await lease.assertHeld();
    const state = await runtime({ defaultDir: paths.appDir });
    if (state !== false && state?.running !== false) throw Object.assign(new Error('Desktop の終了を待っています'), { code: 'desktop_running' });
  };
  if (!await optionalStat(target)) { await stopped(); await fs.mkdir(target, { mode: 0o700 }); }
  await inspectProfileDirectory(target, { device: paths.device });
  const existing = await snapshot(target);
  for (const [name, value] of existing) {
    if (expected.get(name) !== value) throw desktopError('初回接続の保存先に想定外のファイルがあります');
  }
  // Resume partial copies without overwriting matching or unexpected files.
  for (const [name, value] of expected) {
    if (existing.has(name)) continue;
    await stopped();
    const destination = path.join(target, name);
    if (value === 'directory') await fs.mkdir(destination, { mode: 0o700 });
    else {
      await fs.copyFile(path.join(source.dir, path.relative(prefix, name)), destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      await fs.chmod(destination, 0o600);
      const handle = await fs.open(destination, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    }
  }
  const copied = await snapshot(target);
  const equal = (a, b) => JSON.stringify([...a]) === JSON.stringify([...b]);
  if (source && !equal(await snapshot(source.dir), source.entries) || !equal(copied, expected)) throw desktopError('引継ぎ中に会話が変更されました。元の保存先は保持しています');
  for (const [name, value] of [...expected].reverse()) if (value === 'directory') {
    const handle = await fs.open(path.join(target, name), 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  await stopped();
}

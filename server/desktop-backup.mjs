// Whole stopped profiles are copied as files, never parsed for credentials.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectProfileDirectory } from './claude-desktop-roots.mjs';
export async function backupDesktopProfiles({ dataDir, requestId, profiles }) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId || '') || !Array.isArray(profiles) || !profiles.length) throw new Error('バックアップ要求が不正です');
  const root = await inspectProfileDirectory(await fs.realpath(dataDir));
  const parent = path.join(root.dir, 'desktop-backups');
  await fs.mkdir(parent, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
  await inspectProfileDirectory(parent);
  const dir = await fs.mkdtemp(path.join(parent, `${requestId}-`)); await fs.chmod(dir, 0o700);
  const record = { version: 1, id: randomUUID(), state: 'preparing', profiles: [] };
  const file = path.join(dir, 'backup.json');
  await fs.writeFile(file, JSON.stringify(record), { mode: 0o600 });
  for (const p of profiles) {
    if (!/^[0-9a-f-]{36}$/i.test(p.id)) throw new Error('プロフィールIDが不正です');
    await inspectProfileDirectory(p.dir);
    await fs.cp(p.dir, path.join(dir, p.id), { recursive: true, dereference: false, errorOnExist: true, force: false, preserveTimestamps: true, mode: constants.COPYFILE_FICLONE });
    record.profiles.push({ id: p.id, source: p.dir, account: p.account });
  }
  record.state = 'ready';
  const handle = await fs.open(file, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
  return dir;
}

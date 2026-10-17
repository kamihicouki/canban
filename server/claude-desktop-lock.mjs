import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { inspectProfileDirectory } from './claude-desktop-roots.mjs';

const busy = () => Object.assign(new Error('Desktop のプロフィール切替が進行中です。完了してから再操作してください'), { code: 'desktop_busy' });
const same = (a, b) => a && b && a.ino === b.ino && a.dev === b.dev && a.birthtimeMs === b.birthtimeMs;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

export async function desktopProfileLock(lock, { staleMs = 60000, heartbeatMs = 5000 } = {}) {
  const ownerFile = path.join(lock, 'owner.json');
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const original = await fs.lstat(lock);
    if (!original.isDirectory() || original.isSymbolicLink() || process.getuid && original.uid !== process.getuid()) throw busy();
    let owner;
    try { owner = JSON.parse(await fs.readFile(ownerFile, 'utf8')); } catch { owner = null; }
    if (!Number.isInteger(owner?.pid) || owner.pid <= 0 || typeof owner.generation !== 'string' || Date.now() - original.mtimeMs <= staleMs || alive(owner.pid)) throw busy();
    const current = await fs.stat(lock).catch(() => null);
    if (!same(original, current) || original.mtimeMs !== current.mtimeMs) throw busy();
    // Move the abandoned generation aside. A competing acquisition must verify
    // its inode before changing a profile, and release only its own generation.
    const abandoned = `${lock}.abandoned-${randomUUID()}`;
    await fs.rename(lock, abandoned).catch(() => { throw busy(); });
    const moved = await fs.stat(abandoned);
    if (!same(original, moved) || original.mtimeMs !== moved.mtimeMs) {
      if (!await fs.lstat(lock).catch(() => null)) await fs.rename(abandoned, lock);
      throw busy();
    }
    await fs.rm(abandoned, { recursive: true, force: true });
    try { await fs.mkdir(lock, { mode: 0o700 }); } catch { throw busy(); }
  }
  const generation = randomUUID(), owned = await fs.stat(lock);
  const assertHeld = async () => {
    if (!same(owned, await fs.stat(lock).catch(() => null))) throw busy();
    const currentOwner = JSON.parse(await fs.readFile(ownerFile, 'utf8').catch(() => 'null'));
    if (currentOwner?.generation !== generation) throw busy();
  };
  try { await fs.writeFile(ownerFile, JSON.stringify({ pid: process.pid, generation }), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (same(owned, await fs.stat(lock).catch(() => null))) await fs.rmdir(lock).catch(() => {}); throw error; }
  let heartbeatTask = Promise.resolve();
  const timer = setInterval(() => {
    heartbeatTask = heartbeatTask.then(async () => { await assertHeld(); const now = new Date(); await fs.utimes(lock, now, now); }).catch(() => {});
  }, heartbeatMs);
  timer.unref();
  return { assertHeld, release: async () => {
    clearInterval(timer); await heartbeatTask;
    if (same(owned, await fs.stat(lock).catch(() => null))) {
      const currentOwner = JSON.parse(await fs.readFile(ownerFile, 'utf8').catch(() => 'null'));
      if (currentOwner?.generation !== generation) return;
      await fs.unlink(ownerFile); await fs.rmdir(lock);
    }
  } };
}

// Async context permits only trusted nested calls (open -> guest restore). A new
// MCP call or a watcher process has no lease and must acquire the same lock.
const lifecycle = new AsyncLocalStorage();
const leases = new WeakMap();
export async function withDesktopMutationLock({ dataDir, lease }, action) {
  const data = await inspectProfileDirectory(dataDir);
  // null explicitly starts a new user request; only nested implementation calls
  // omit the lease and inherit the current trusted transaction.
  const inherited = lease === null ? null : lease || lifecycle.getStore();
  if (inherited) {
    const owner = leases.get(inherited);
    if (!owner || owner.dataDir !== data.dir) throw busy();
    await inherited.assertHeld();
    return action(inherited);
  }
  const state = path.join(data.dir, 'desktop-accounts', 'claude');
  for (const dir of [path.dirname(state), state]) {
    try { await fs.mkdir(dir, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await inspectProfileDirectory(dir, { device: data.device });
  }
  const acquired = await desktopProfileLock(path.join(state, 'lifecycle.lock'));
  leases.set(acquired, { dataDir: data.dir });
  try { return await lifecycle.run(acquired, () => action(acquired)); }
  finally { leases.delete(acquired); await acquired.release(); }
}

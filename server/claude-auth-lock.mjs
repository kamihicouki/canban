import fs from 'node:fs/promises';
import path from 'node:path';

const unavailable = () => Object.assign(new Error('unavailable'), { code: 'unavailable' });
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Directory locks interoperate with Claude Code 2.1.285's proper-lockfile
// protocol: 60s stale window / 5s heartbeat for OAuth, 15s for storage writes.
// No credential or owner metadata is placed in these shared lock directories.
export async function withClaudeAuthLock(home, task, { kind = 'refresh', timeoutMs = 8000 } = {}) {
  const canonical = await fs.realpath(home.dir);
  const locks = kind === 'storage' ? [path.join(canonical, '.storage-write.lock')]
    : [path.join(canonical, '.oauth_refresh.lock'), `${canonical}.lock`];
  const staleMs = kind === 'storage' ? 15000 : 60000;
  const deadline = Date.now() + timeoutMs;
  let held = [], compromised = false, heartbeat, heartbeatTask = Promise.resolve();
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
  const assertHeld = async () => {
    if (compromised) throw unavailable();
    for (const [file, owner] of held) {
      const current = await fs.stat(file).catch(() => null);
      if (!current || !same(current, owner)) { compromised = true; throw unavailable(); }
    }
  };
  const release = async () => {
    for (const [file, owner] of held.reverse()) {
      const current = await fs.stat(file).catch(() => null);
      if (current && same(current, owner)) await fs.rmdir(file).catch(() => {});
    }
    held = [];
  };
  try {
    while (true) {
      let busy = false;
      for (const file of locks) {
        try { await fs.mkdir(file, { mode: 0o700 }); held.push([file, await fs.stat(file)]); }
        catch (error) {
          if (error.code !== 'EEXIST') throw unavailable();
          const current = await fs.stat(file).catch(() => null);
          if (current && Date.now() - current.mtimeMs > staleMs) {
            const recheck = await fs.stat(file).catch(() => null);
            if (recheck && same(current, recheck) && current.mtimeMs === recheck.mtimeMs) await fs.rmdir(file).catch(() => {});
          }
          busy = true; break;
        }
      }
      if (!busy) break;
      await release();
      if (Date.now() >= deadline) throw unavailable();
      await pause(Math.min(50, deadline - Date.now()));
    }
    let updating = false;
    heartbeat = setInterval(() => {
      if (updating) return;
      updating = true;
      heartbeatTask = (async () => {
      try { await assertHeld(); const now = new Date(); for (const [file] of held) await fs.utimes(file, now, now); }
      catch { compromised = true; }
      finally { updating = false; }
      })();
    }, kind === 'storage' ? 2000 : 5000);
    heartbeat.unref();
    const result = await task(assertHeld);
    await assertHeld();
    return result;
  } finally { clearInterval(heartbeat); await heartbeatTask; await release(); }
}

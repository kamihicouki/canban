// Background-work leader election. Codex starts one Canban server per thread, so
// many servers can share one data dir; only the leader runs the background ticks
// (rules, full-text indexing, dispatch). The others just answer tool calls.
// The lock file holds the leader's pid and is touched as a heartbeat; a lock whose
// owner died or stopped beating is taken over.
import fs from 'node:fs';
import path from 'node:path';

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export class Leader {
  // mode: 'auto' (elect), 'always' (tests / single user), 'never' (no background work)
  constructor(dir, { mode = 'auto', heartbeatMs = 30e3, staleMs = 90e3, onChange = () => {} } = {}) {
    this.file = path.join(dir, 'leader.lock');
    this.dir = dir;
    this.mode = mode;
    this.heartbeatMs = heartbeatMs;
    this.staleMs = staleMs;
    this.onChange = onChange;
    this.isLeader = mode === 'always';
    this.timer = null;
  }

  owner() {
    try {
      return Number(fs.readFileSync(this.file, 'utf8')) || null;
    } catch {
      return null;
    }
  }

  // One election step: keep, take or give up leadership. Returns isLeader.
  check(now = Date.now()) {
    if (this.mode !== 'auto') return this.isLeader;
    const was = this.isLeader;
    if (this.isLeader && this.owner() === process.pid) {
      try {
        fs.utimesSync(this.file, now / 1000, now / 1000);
      } catch {}
    } else {
      this.isLeader = this.tryAcquire(now);
    }
    if (was !== this.isLeader) this.onChange(this.isLeader);
    return this.isLeader;
  }

  tryAcquire(now = Date.now()) {
    fs.mkdirSync(this.dir, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(this.file, 'wx');
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return true;
      } catch (e) {
        if (e.code !== 'EEXIST') return false;
      }
      const owner = this.owner();
      if (owner === process.pid) return true;
      let stale = false;
      try {
        stale = now - fs.statSync(this.file).mtimeMs > this.staleMs;
      } catch {
        continue; // removed meanwhile: retry
      }
      if (!stale && owner && pidAlive(owner)) return false;
      // Take over by renaming our own claim into place, then verify we won.
      const mine = `${this.file}.${process.pid}`;
      fs.writeFileSync(mine, String(process.pid));
      fs.renameSync(mine, this.file);
      return this.owner() === process.pid;
    }
    return false;
  }

  start() {
    if (this.mode !== 'auto') {
      if (this.isLeader) this.onChange(true);
      return this;
    }
    this.check();
    this.timer = setInterval(() => this.check(), this.heartbeatMs);
    this.timer.unref();
    process.on('exit', () => this.release());
    return this;
  }

  release() {
    clearInterval(this.timer);
    if (this.mode === 'auto' && this.isLeader && this.owner() === process.pid) fs.rmSync(this.file, { force: true });
    this.isLeader = this.mode === 'always';
  }
}

// Realtime: file watching + long polling.
// MCP Apps UIs can only reach the server through tool calls, so the board holds one
// `canban_watch` call open; it returns as soon as something the board shows changes.
// Watching is lazy: nothing is watched until a board is open, and the watchers close
// again LIVE_IDLE_MS after the last watch call (a server whose board is closed does
// nothing). Where fs.watch is unavailable, the same paths are stat-polled instead.
//
//   data dir (non-recursive)        board.json → store, requests.json → requests
//   Codex home (non-recursive)      state_<n>.sqlite(-wal) → codex, .codex-global-state.json → app
//   ~/.claude/projects (recursive)  <project>/<session>.jsonl → file
//   Claude desktop sessions (rec.)  local_<id>.json, archived-sessions.idx → desktop (title / archive / status)
//   hot files                        logs of running / waiting sessions outside the above (Codex rollouts)
//   focus file                       the log of the session open in the detail view
import fs from 'node:fs';
import path from 'node:path';
import { stat } from './sources/readonly.mjs';

export const LIVE_IDLE_MS = Number(process.env.CANBAN_LIVE_IDLE_MS) || 60e3;
const COALESCE_MS = 150;
const POLL_MS = 2000;
const RING = 500;
const MAX_HOT = 24;

export class LiveHub {
  constructor({ dataDir, codexHome, claudeProjects, claudeDesktop, idleMs = LIVE_IDLE_MS, watch = fs.watch } = {}) {
    this.roots = { dataDir, codexHome, claudeProjects, claudeDesktop };
    this.idleMs = idleMs;
    this.watchFn = watch;
    this.seq = 0;
    this.ring = []; // { seq, kind, path }
    this.waiters = new Set();
    this.watchers = new Map(); // key -> FSWatcher
    this.polled = new Map(); // path -> { kind, sig }
    this.hot = new Set();
    this.focusPath = null;
    this.active = false;
    this.idleTimer = null;
    this.pollTimer = null;
    this.pending = 0;
    this.counters = { events: 0, watchers: 0, polled: 0, starts: 0 };
  }

  // A watch call arrived: start watching (if needed) and push the idle shutdown back.
  touch() {
    clearTimeout(this.idleTimer);
    if (!this.active) this.start();
    this.idleTimer = setTimeout(() => {
      if (this.pending) return this.touch();
      this.stop();
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  start() {
    this.active = true;
    this.counters.starts++;
    const { dataDir, codexHome, claudeProjects, claudeDesktop } = this.roots;
    if (dataDir) {
      fs.mkdirSync(dataDir, { recursive: true });
      this.watchPath('data', dataDir, {}, (f) => (f === 'board.json' ? 'store' : f === 'requests.json' ? 'requests' : null));
    }
    if (codexHome) this.watchPath('codex', codexHome, {}, (f) => (/^state_\d+\.sqlite(-wal)?$/.test(f) ? 'codex' : f === '.codex-global-state.json' ? 'app' : null));
    if (claudeProjects) this.watchPath('claude', claudeProjects, { recursive: true }, (f) => (f.endsWith('.jsonl') ? 'file' : null));
    if (claudeDesktop) this.watchPath('desktop', claudeDesktop, { recursive: true }, (f) => (/^local_.*\.json$/.test(f) || f === 'archived-sessions.idx' ? 'desktop' : null));
    for (const p of this.hot) this.watchFile(p, 'file');
    if (this.focusPath) this.watchFile(this.focusPath, 'file');
  }

  stop() {
    this.active = false;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    this.polled.clear();
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  // Directory watch; `classify(relative name)` returns the event kind or null to ignore.
  watchPath(key, dir, opts, classify) {
    if (this.watchers.has(key) || !fs.existsSync(dir)) return;
    try {
      const w = this.watchFn(dir, { persistent: false, ...opts }, (_type, name) => {
        if (!name) return this.emit(key === 'desktop' ? 'desktop' : opts.recursive ? 'rescan' : 'store', dir);
        const f = String(name);
        const kind = classify(path.basename(f));
        if (kind) this.emit(kind, path.join(dir, f));
      });
      w.on('error', () => this.fallback(key, dir, classify));
      this.watchers.set(key, w);
      this.counters.watchers++;
    } catch {
      this.fallback(key, dir, classify);
    }
  }

  watchFile(file, kind) {
    const key = `file:${file}`;
    if (!file || this.watchers.has(key) || this.polled.has(file) || !this.active || this.coveredByDir(file)) return;
    try {
      const w = this.watchFn(file, { persistent: false }, () => this.emit(kind, file));
      w.on('error', () => {
        this.watchers.delete(key);
        this.poll(file, kind);
      });
      this.watchers.set(key, w);
      this.counters.watchers++;
    } catch {
      this.poll(file, kind);
    }
  }

  unwatchFile(file) {
    const key = `file:${file}`;
    this.watchers.get(key)?.close();
    this.watchers.delete(key);
    this.polled.delete(file);
  }

  // No fs.watch for a directory: poll the files the board cares about in it.
  fallback(key, dir, classify) {
    this.watchers.get(key)?.close();
    this.watchers.delete(key);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {}
    for (const n of names) {
      const kind = classify(n);
      if (kind && kind !== 'file') this.poll(path.join(dir, n), kind);
    }
    this.poll(dir, key === 'claude' ? 'rescan' : key === 'desktop' ? 'desktop' : 'store'); // new files show up as a directory change
  }

  poll(file, kind) {
    if (this.polled.has(file)) return;
    this.polled.set(file, { kind, sig: null });
    this.counters.polled++;
    this.pollTimer ||= setInterval(() => this.pollStep(), POLL_MS);
    this.pollTimer.unref?.();
  }

  async pollStep() {
    for (const [file, e] of this.polled) {
      const st = await stat(file);
      const sig = st ? `${st.mtimeMs}:${st.size}` : '-';
      if (e.sig !== null && e.sig !== sig) this.emit(e.kind, file);
      e.sig = sig;
    }
  }

  // Logs of running sessions that the directory watches do not cover.
  setHot(paths) {
    const next = new Set([...paths].filter(Boolean).slice(0, MAX_HOT));
    for (const p of this.hot) if (!next.has(p) && p !== this.focusPath) this.unwatchFile(p);
    this.hot = next;
    if (this.active) for (const p of next) this.watchFile(p, 'file');
  }

  focus(file) {
    if (file === this.focusPath) return;
    if (this.focusPath && !this.hot.has(this.focusPath)) this.unwatchFile(this.focusPath);
    this.focusPath = file || null;
    if (file) this.watchFile(file, 'file');
  }

  coveredByDir(file) {
    const c = this.roots.claudeProjects;
    return !!c && this.watchers.has('claude') && file.startsWith(c + path.sep);
  }

  emit(kind, file) {
    this.seq++;
    this.counters.events++;
    this.ring.push({ seq: this.seq, kind, path: file });
    if (this.ring.length > RING) this.ring.splice(0, this.ring.length - RING);
    for (const w of this.waiters) w();
  }

  // Events after `since`; null when `since` is older than the ring (the client reloads).
  since(since) {
    if (since > this.seq) return null; // server restarted
    const first = this.ring[0]?.seq ?? this.seq + 1;
    if (since < first - 1) return null;
    return this.ring.filter((e) => e.seq > since);
  }

  // Resolve with the events after `since`, waiting up to `timeoutMs` for the first one.
  async wait(since, { timeoutMs = 20000 } = {}) {
    this.touch();
    const ready = () => {
      const ev = this.since(since);
      return ev === null || ev.length > 0;
    };
    if (!ready() && timeoutMs > 0) {
      this.pending++;
      try {
        await new Promise((resolve) => {
          let timer;
          const done = () => {
            clearTimeout(timer);
            this.waiters.delete(wake);
            resolve();
          };
          const wake = () => setTimeout(done, COALESCE_MS); // let a burst of writes settle
          timer = setTimeout(done, timeoutMs);
          this.waiters.add(wake);
        });
      } finally {
        this.pending--;
      }
    }
    return { seq: this.seq, events: this.since(since) };
  }

  close() {
    clearTimeout(this.idleTimer);
    this.stop();
    for (const w of this.waiters) w();
  }
}

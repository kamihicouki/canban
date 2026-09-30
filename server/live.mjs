// Realtime: file watching + long polling.
// MCP Apps UIs can only reach the server through tool calls, so the board holds one
// `canban_watch` call open; it returns as soon as something the board shows changes.
// Watching is lazy: nothing is watched until a board is open, and the watchers close
// again LIVE_IDLE_MS after the last watch call (a server whose board is closed does
// nothing). Where fs.watch is unavailable, the same paths are stat-polled instead.
//
//   data dir (non-recursive)        board.json → store, requests.json → requests, presence.json → presence
//   Codex homes (non-recursive)     state_<n>.sqlite(-wal) → codex, .codex-global-state.json → app
//   Claude homes' projects (rec.)   <project>/<session>.jsonl → file
//     (the default home plus other config folders, see accounts.mjs; `extraRoots()` gives those)
//   Claude desktop sessions (rec.)  local_<id>.json, archived-sessions.idx → desktop (title / archive / status)
//   git dirs of running sessions    HEAD, index → git (branch, commits, staged changes; see gitlive.mjs)
//   hot files                        logs of running / waiting sessions outside the above (Codex rollouts)
//   focus files                      the logs of the sessions open in detail panes
import fs from 'node:fs';
import { database } from './sqlite-client.mjs';
import path from 'node:path';
import { stat } from './sources/readonly.mjs';

export const LIVE_IDLE_MS = Number(process.env.CANBAN_LIVE_IDLE_MS) || 60e3;
const COALESCE_MS = 150;
const POLL_MS = 2000;
const RING = 500;
const MAX_HOT = 24;
export const MAX_FOCUS = 8; // detail panes open at once whose logs are followed

export class LiveHub {
  constructor({ dataDir, codexHome, claudeProjects, claudeDesktop, extraRoots = null, idleMs = LIVE_IDLE_MS, watch = fs.watch } = {}) {
    this.database = dataDir ? database(dataDir) : null;
    this.dbRevisions = null;
    this.dbPolling = false;
    this.roots = { dataDir, codexHome, claudeProjects, claudeDesktop };
    this.extraRoots = extraRoots; // async () => ({ codexHomes: [], claudeProjects: [], claudeDesktop: [] })
    this.claudeDirs = []; // watched Claude projects folders beyond the default
    this.extraKeys = new Set();
    this.extraGeneration = 0;
    this.idleMs = idleMs;
    this.watchFn = watch;
    this.seq = 0;
    this.ring = []; // { seq, kind, path }
    this.waiters = new Set();
    this.watchers = new Map(); // key -> FSWatcher
    this.polled = new Map(); // path -> { kind, sig }
    this.hot = new Set();
    this.gitDirs = new Set();
    this.focusPaths = new Set();
    this.onStop = null; // called when watching stops (the board closed)
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
      this.watchPath('data', dataDir, {}, (f) => {
        if (f === 'canban.sqlite' || f === 'canban.sqlite-wal') void this.pollStep();
        return null;
      });
      void this.pollStep();
      this.pollTimer ||= setInterval(() => this.pollStep(),POLL_MS);
      this.pollTimer.unref?.();
    }
    if (codexHome) this.watchPath('codex', codexHome, {}, (f) => (/^state_\d+\.sqlite(-wal)?$/.test(f) ? 'codex' : f === '.codex-global-state.json' ? 'app' : null));
    if (claudeProjects) this.watchPath('claude', claudeProjects, { recursive: true }, (f) => (f.endsWith('.jsonl') ? 'file' : null));
    if (claudeDesktop) this.watchPath('desktop', claudeDesktop, { recursive: true }, (f) => (/^local_.*\.json$/.test(f) || f === 'archived-sessions.idx' ? 'desktop' : null));
    for (const p of this.hot) this.watchFile(p, 'file');
    for (const p of this.focusPaths) this.watchFile(p, 'file');
    for (const d of this.gitDirs) this.watchGit(d);
    this.watchExtra();
  }

  // Other config folders: watched like the default ones, keyed by path.
  async watchExtra() {
    if (!this.extraRoots) return;
    const generation = ++this.extraGeneration;
    let extra;
    try {
      extra = await this.extraRoots();
    } catch {
      return;
    }
    if (!this.active || generation !== this.extraGeneration) return;
    const next = new Set([
      ...(extra.codexHomes || []).map(d => `codex:${d}`),
      ...(extra.claudeProjects || []).map(d => `claude:${d}`),
      ...(extra.claudeDesktop || []).map(d => `desktop:${d}`),
    ]);
    for (const key of this.extraKeys) if (!next.has(key)) {
      this.watchers.get(key)?.close(); this.watchers.delete(key);
      for (const [file, entry] of this.polled) if (entry.owner === key) this.polled.delete(file);
    }
    this.extraKeys = next;
    for (const dir of extra.codexHomes || []) this.watchPath(`codex:${dir}`, dir, {}, (f) => (/^state_\d+\.sqlite(-wal)?$/.test(f) ? 'codex' : null));
    for (const dir of extra.claudeProjects || []) this.watchPath(`claude:${dir}`, dir, { recursive: true }, (f) => (f.endsWith('.jsonl') ? 'file' : null));
    for (const dir of extra.claudeDesktop || []) this.watchPath(`desktop:${dir}`, dir, { recursive: true }, (f) => (/^local_.*\.json$/.test(f) || f === 'archived-sessions.idx' ? 'desktop' : null));
    this.claudeDirs = (extra.claudeProjects || []).filter((d) => this.watchers.has(`claude:${d}`));
  }

  stop() {
    this.active = false;
    this.extraGeneration++;
    this.extraKeys.clear();
    this.onStop?.();
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
        if (!name) return this.emit(key.startsWith('desktop') ? 'desktop' : key.startsWith('git:') ? 'git' : opts.recursive ? 'rescan' : 'store', dir);
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
      if (kind && kind !== 'file') this.poll(path.join(dir, n), kind, key);
    }
    if (key.startsWith('git:')) return; // HEAD and index are polled above
    this.poll(dir, key.startsWith('claude') ? 'rescan' : key.startsWith('desktop') ? 'desktop' : 'store', key); // new files show up as a directory change
  }

  poll(file, kind, owner = null) {
    if (this.polled.has(file)) return;
    this.polled.set(file, { kind, sig: null, owner });
    this.counters.polled++;
    this.pollTimer ||= setInterval(() => this.pollStep(), POLL_MS);
    this.pollTimer.unref?.();
  }

  pollStep() {
    if (this.polling) return this.polling;
    this.polling = this.scanChanges().catch(() => {}).finally(() => { this.polling = null; });
    return this.polling;
  }

  async scanChanges() {
    if (this.database && !this.dbPolling) {
      this.dbPolling = true;
      try {
        const next = await Promise.all(['board','requests','presence'].map((kind) => this.database.call('system','revision',[kind + '_change'])));
        if (this.dbRevisions) for (const [i,kind] of ['store','requests','presence'].entries()) if (next[i] !== this.dbRevisions[i]) this.emit(kind,this.roots.dataDir);
        this.dbRevisions = next;
      } catch {} finally { this.dbPolling = false; }
    }
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
    for (const p of this.hot) if (!next.has(p) && !this.focusPaths.has(p)) this.unwatchFile(p);
    this.hot = next;
    if (this.active) for (const p of next) this.watchFile(p, 'file');
  }

  // Git directories of running sessions: HEAD / index are replaced by rename, so the
  // directory is watched rather than the files.
  watchGit(dir) {
    this.watchPath(`git:${dir}`, dir, {}, (f) => (f === 'HEAD' || f === 'index' ? 'git' : null));
  }

  setGitDirs(dirs) {
    const next = new Set([...dirs].filter(Boolean).slice(0, MAX_HOT));
    for (const d of this.gitDirs) {
      if (next.has(d)) continue;
      const key = `git:${d}`;
      this.watchers.get(key)?.close();
      this.watchers.delete(key);
      for (const f of ['HEAD', 'index']) this.polled.delete(path.join(d, f));
    }
    this.gitDirs = next;
    if (this.active) for (const d of next) this.watchGit(d);
  }

  // The logs of the sessions open in detail panes: one path, or a list.
  focus(files) {
    const next = new Set([].concat(files || []).filter(Boolean).slice(0, MAX_FOCUS));
    for (const p of this.focusPaths) if (!next.has(p) && !this.hot.has(p)) this.unwatchFile(p);
    const added = [...next].filter((p) => !this.focusPaths.has(p));
    this.focusPaths = next;
    for (const p of added) this.watchFile(p, 'file');
  }

  coveredByDir(file) {
    const c = this.roots.claudeProjects;
    if (c && this.watchers.has('claude') && file.startsWith(c + path.sep)) return true;
    return this.claudeDirs.some((d) => file.startsWith(d + path.sep));
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
    if (this.database && !this.dbRevisions) {
      await this.pollStep();
      this.touch();
    }
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

// Requests: prompts sent (or queued) to existing sessions. Stored in
// <data dir>/requests.json, separate from the board. Several Canban servers can run
// at once (Codex and Claude Code each start one), so every read-modify-write holds
// an exclusive lock file; claiming a queued request happens under that lock, which
// is what keeps a prompt from being sent twice.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './store.mjs';

export const REQUEST_STATES = ['queued', 'starting', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'];
export const ACTIVE_STATES = new Set(['starting', 'running']);
export const FINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
export const MAX_PROMPT = 20000;
const HISTORY_PER_CARD = 50;
const HISTORY_TOTAL = 1000;
const LOG_MAX_AGE_MS = 14 * 86400e3;
const LOCK_STALE_MS = 10000;
const LOCK_WAIT_MS = 5000;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export class RequestStore {
  constructor(dir = dataDir()) {
    this.dir = dir;
    this.file = path.join(dir, 'requests.json');
    this.lockFile = path.join(dir, 'requests.lock');
    this.runsDir = path.join(dir, 'runs');
  }

  logPath(id) {
    return path.join(this.runsDir, `${id}.log`);
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { requests: Array.isArray(j.requests) ? j.requests : [], paused: j.paused && typeof j.paused === 'object' ? j.paused : {} };
    } catch {
      return { requests: [], paused: {} };
    }
  }

  // Exclusive lock across processes. A lock left behind by a dead process (or older
  // than LOCK_STALE_MS) is taken over.
  lock() {
    fs.mkdirSync(this.dir, { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const fd = fs.openSync(this.lockFile, 'wx');
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      try {
        const st = fs.statSync(this.lockFile);
        const owner = Number(fs.readFileSync(this.lockFile, 'utf8'));
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS || (owner && owner !== process.pid && !pidAlive(owner))) fs.rmSync(this.lockFile, { force: true });
      } catch {}
      if (Date.now() > deadline) throw new Error('依頼ファイルのロックを取得できませんでした');
      sleep(15);
    }
  }

  unlock() {
    fs.rmSync(this.lockFile, { force: true });
  }

  // Synchronous read-modify-write under the lock; `fn` must not await.
  mutate(fn) {
    this.lock();
    try {
      const state = this.load();
      const result = fn(state);
      for (const id of trim(state)) fs.rmSync(this.logPath(id), { force: true });
      const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, this.file);
      return result;
    } finally {
      this.unlock();
    }
  }

  get(id) {
    return this.load().requests.find((r) => r.id === id) || null;
  }

  list({ cardId, state } = {}) {
    return this.load().requests.filter((r) => (!cardId || r.cardId === cardId) && (!state || r.state === state));
  }

  create(fields) {
    return this.mutate((s) => {
      const req = {
        id: `req-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
        state: 'queued',
        createdAt: Date.now(),
        order: Date.now(),
        ...fields,
      };
      s.requests.push(req);
      return req;
    });
  }

  // Apply `patch` if the request is in one of `from` states; returns the updated request or null.
  transition(id, from, patch) {
    return this.mutate((s) => {
      const r = s.requests.find((x) => x.id === id);
      if (!r || (from && !from.includes(r.state))) return null;
      Object.assign(r, typeof patch === 'function' ? patch(r) : patch);
      return { ...r };
    });
  }

  // Claim a queued request for sending. Fails if the session already has an active
  // request, its queue is paused (unless `force`), or `check` (run under the lock) says no.
  claim(id, { force = false, check } = {}) {
    return this.mutate((s) => {
      const r = s.requests.find((x) => x.id === id);
      if (!r || r.state !== 'queued') return { ok: false, reason: 'この依頼は待機中ではありません' };
      if (s.requests.some((x) => x.cardId === r.cardId && ACTIVE_STATES.has(x.state))) return { ok: false, reason: 'このセッションには実行中の依頼があります' };
      if (!force && s.paused[r.cardId]) return { ok: false, reason: `キューは一時停止中です: ${s.paused[r.cardId].reason}` };
      const denied = check?.(s);
      if (denied) return { ok: false, reason: denied };
      r.state = 'starting';
      r.startedAt = Date.now();
      r.owner = process.pid;
      // `force` (send now) bypasses a paused queue for this one request; the queue
      // itself stays paused until it is resumed explicitly.
      return { ok: true, request: { ...r } };
    });
  }

  pause(cardId, reason) {
    return this.mutate((s) => {
      s.paused[cardId] = { reason, at: Date.now() };
    });
  }

  resume(cardId) {
    return this.mutate((s) => {
      delete s.paused[cardId];
    });
  }

  cancel(id) {
    const r = this.transition(id, ['queued'], { state: 'cancelled', endedAt: Date.now() });
    if (!r) throw new Error('取り消せるのは待機中の依頼だけです（実行中のものは停止してください）');
    return r;
  }

  // Edit a queued prompt and/or move it within its session's queue (order is a number).
  update(id, { prompt, order } = {}) {
    const patch = {};
    if (prompt !== undefined) {
      const p = String(prompt).trim();
      if (!p) throw new Error('プロンプトを入力してください');
      if (p.length > MAX_PROMPT) throw new Error(`プロンプトは ${MAX_PROMPT} 文字までです`);
      patch.prompt = p;
    }
    if (typeof order === 'number' && Number.isFinite(order)) patch.order = order;
    const r = this.transition(id, ['queued'], patch);
    if (!r) throw new Error('編集できるのは待機中の依頼だけです');
    return r;
  }

  // Run logs of requests that are gone or older than LOG_MAX_AGE_MS (leader, daily).
  pruneLogs(now = Date.now()) {
    const keep = new Set(this.load().requests.map((r) => r.id));
    let removed = 0;
    let entries = [];
    try {
      entries = fs.readdirSync(this.runsDir, { withFileTypes: true }).filter((e) => e.isFile());
    } catch {}
    for (const name of entries) {
      const p = path.join(this.runsDir, name.name);
      const id = name.name.replace(/\.log$/, '');
      try {
        if (!keep.has(id) || now - fs.statSync(p).mtimeMs > LOG_MAX_AGE_MS) {
          fs.rmSync(p, { force: true });
          removed++;
        }
      } catch {}
    }
    return removed;
  }
}

// Keep every queued / active request and the latest finished ones (per session and
// overall). Returns the ids that were dropped so their logs can go too.
function trim(state) {
  const finished = state.requests.filter((r) => FINAL_STATES.has(r.state)).sort((a, b) => (b.endedAt || b.createdAt) - (a.endedAt || a.createdAt));
  const perCard = new Map();
  const drop = new Set();
  for (const [i, r] of finished.entries()) {
    const n = (perCard.get(r.cardId) || 0) + 1;
    perCard.set(r.cardId, n);
    if (n > HISTORY_PER_CARD || i >= HISTORY_TOTAL) drop.add(r.id);
  }
  if (drop.size) state.requests = state.requests.filter((r) => !drop.has(r.id));
  return drop;
}

// The next request to send for each session (queue order, then creation).
export function queueHeads(requests) {
  const heads = new Map();
  for (const r of requests) {
    if (r.state !== 'queued') continue;
    const h = heads.get(r.cardId);
    if (!h || r.order < h.order || (r.order === h.order && r.createdAt < h.createdAt)) heads.set(r.cardId, r);
  }
  return [...heads.values()];
}

// Per-card summary for the board: queued count and whether a request is running.
export function requestSummary(requests, paused = {}) {
  const m = new Map();
  for (const r of requests) {
    if (r.state !== 'queued' && !ACTIVE_STATES.has(r.state)) continue;
    const e = m.get(r.cardId) || { queued: 0, running: false, paused: false };
    if (r.state === 'queued') e.queued++;
    else e.running = true;
    m.set(r.cardId, e);
  }
  for (const id of Object.keys(paused)) if (m.has(id)) m.get(id).paused = true;
  return m;
}

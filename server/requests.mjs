// SQLite-backed requests; claims and session ownership commit atomically.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './store.mjs';
import { isMainThread, proxyStore } from './sqlite-client.mjs';
import { readRequests, writeRequests, transaction, currentFence, db, sessionKey, nextGeneration } from './sqlite-backend.mjs';

export const REQUEST_STATES = ['queued', 'starting', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'blocked'];
export const ACTIVE_STATES = new Set(['starting', 'running']);
export const FINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'blocked']);
export const MAX_PROMPT = 20000;
const HISTORY_PER_CARD = 50;
const HISTORY_TOTAL = 1000;
const LOG_MAX_AGE_MS = 14 * 86400e3;
export class RequestStore {
  constructor(dir = dataDir()) {
    this.dir = dir;
    this.file = path.join(dir, 'canban.sqlite');
    this.runsDir = path.join(dir, 'runs');
    if (isMainThread) return proxyStore(this, 'requests');
  }

  logPath(id) {
    return path.join(this.runsDir, `${id}.log`);
  }

  load() { return readRequests(); }

  mutate(fn) {
    return transaction(() => {
      const state = this.load();
      const result = fn(state);
      const dropped = trim(state);
      writeRequests(state);
      // Only unlink derived logs after commit in pruneLogs, never while holding a DB lock.
      return result;
    }, { fence: currentFence });
  }

  get(id) {
    return this.load().requests.find((r) => r.id === id) || null;
  }

  list({ cardId, state } = {}) {
    return this.load().requests.filter((r) => (!cardId || r.cardId === cardId) && (!state || r.state === state));
  }

  create(fields) {
    return this.mutate((s) => {
      if (fields.loopContext) {
        const x = fields.loopContext;
        const prior = db().prepare('SELECT payload FROM loop_dispatch WHERE round_id=?').get(x.roundId);
        if (prior) {
          const original = JSON.parse(prior.payload);
          if (original.cardId !== fields.cardId) throw new Error('この周回は別のセッションへ送信済みです');
          return s.requests.find(r => r.id === original.id) || original;
        }
        const row = db().prepare('SELECT payload FROM loop_state WHERE task_id=?').get(x.taskId);
        const record = row && JSON.parse(row.payload);
        const c = record?.cycles.find(c => c.id === x.cycleId);
        const roundRow = db().prepare('SELECT payload FROM loop_rounds WHERE task_id=? AND id=?').get(x.taskId, x.roundId);
        const round = roundRow && JSON.parse(roundRow.payload);
        const taskRow = db().prepare("SELECT payload FROM board_records WHERE kind='cards' AND id=?").get(x.taskId);
        const task = taskRow && JSON.parse(taskRow.payload);
        if (record?.revision !== x.expectedRevision || c?.status !== 'active' || round?.cycleId !== c.id || round.version !== c.version || round.closedAt || !task?.links?.includes(fields.cardId)) throw new Error('周回または紐付けが変わりました。最新の状態を確認してください');
      }
      const req = {
        id: `req-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
        state: 'queued',
        createdAt: Date.now(),
        order: Date.now(),
        ...fields,
      };
      s.requests.push(req);
      if (fields.loopContext) db().prepare('INSERT INTO loop_dispatch VALUES(?,?,?)').run(fields.loopContext.roundId, req.id, JSON.stringify(req));
      return req;
    });
  }

  // Apply `patch` if the request is in one of `from` states; returns the updated request or null.
  transition(id, from, patch, { owner = null, generation = null, release = false } = {}) {
    return this.mutate((s) => {
      const r = s.requests.find((x) => x.id === id);
      if (!r || (from && !from.includes(r.state))) return null;
      if (owner) {
        const lease = db().prepare('SELECT owner,generation FROM leases WHERE key=?').get('session:' + sessionKey(r));
        if (r.ownerUuid !== owner || r.leaseGeneration !== generation || !lease || lease.owner !== owner || lease.generation !== generation) return null;
      }
      Object.assign(r, typeof patch === 'function' ? patch(r) : patch);
      const key = 'session:' + sessionKey(r);
      if (release) db().prepare('DELETE FROM leases WHERE key=? AND owner=? AND generation=?').run(key,r.ownerUuid || '',r.leaseGeneration || 0);
      else if (ACTIVE_STATES.has(r.state)) db().prepare('UPDATE leases SET payload=? WHERE key=? AND owner=? AND generation=?').run(JSON.stringify({ requestId: r.id, pid: r.pid || null, remotePid: r.remotePid || null, uncertain: true }),key,r.ownerUuid || '',r.leaseGeneration || 0);
      return { ...r };
    });
  }

  // Claim a queued request for sending. Fails if the session already has an active
  // request, its queue is paused (unless `force`), or `check` (run under the lock) says no.
  claim(id, { force = false, maxLocal = 2, maxPerHost = 1, owner, ownerPid } = {}) {
    return this.mutate((s) => {
      const r = s.requests.find((x) => x.id === id);
      if (!r || r.state !== 'queued') return { ok: false, reason: 'この依頼は待機中ではありません' };
      if (r.loopContext) {
        const x = r.loopContext;
        const row = db().prepare('SELECT payload FROM loop_state WHERE task_id=?').get(x.taskId);
        const c = row && JSON.parse(row.payload).cycles.find(c => c.id === x.cycleId);
        const roundRow = db().prepare('SELECT payload FROM loop_rounds WHERE task_id=? AND id=?').get(x.taskId, x.roundId);
        const round = roundRow && JSON.parse(roundRow.payload);
        const taskRow = db().prepare("SELECT payload FROM board_records WHERE kind='cards' AND id=?").get(x.taskId);
        const task = taskRow && JSON.parse(taskRow.payload);
        if (c?.status !== 'active' || round?.cycleId !== c?.id || round?.version !== c?.version || round?.closedAt || !task?.links?.includes(r.cardId)) {
          const reason = '周回が停止・終了したか、紐付けが変わったため送信を取り消しました';
          Object.assign(r, { state: 'cancelled', endedAt: Date.now(), reasonCode: 'loop_changed', error: reason });
          return { ok: false, reason, reasonCode: 'loop_changed' };
        }
      }
      if (s.requests.some((x) => x.cardId === r.cardId && ACTIVE_STATES.has(x.state))) return { ok: false, reason: 'このセッションには実行中の依頼があります' };
      if (!force && s.paused[r.cardId]) return { ok: false, reason: `キューは一時停止中です: ${s.paused[r.cardId].reason}` };
      const active = s.requests.filter((x) => ACTIVE_STATES.has(x.state));
      const limit = r.hostId === 'local' ? maxLocal : maxPerHost;
      if (active.filter((x) => x.hostId === r.hostId).length >= limit) return { ok: false, reason: '同時実行数の上限に達しています', reasonCode: 'capacity' };
      const key = 'session:' + sessionKey(r);
      if (db().prepare('SELECT key FROM leases WHERE key=?').get(key)) return { ok: false, reason: 'このセッションの実行状況を確認できません', reasonCode: 'session_locked' };
      r.ownerUuid = owner || String(process.pid);
      r.leaseGeneration = nextGeneration(key);
      db().prepare('INSERT INTO leases VALUES(?,?,?,?,?,?)').run(key,r.ownerUuid,ownerPid || process.pid,r.leaseGeneration,Date.now(),JSON.stringify({ requestId: r.id, uncertain: true }));
      r.state = 'starting';
      r.startedAt = Date.now();
      r.owner = process.pid;
      // `force` (send now) bypasses a paused queue for this one request; the queue
      // itself stays paused until it is resumed explicitly.
      return { ok: true, request: { ...r } };
    });
  }

  releaseStopped(id, token) {
    return this.mutate((s) => {
      const r=s.requests.find(r=>r.id===id);
      if (!r || token.key !== 'session:' + sessionKey(r) || ACTIVE_STATES.has(r.state) || r.ownerUuid !== token.owner || r.leaseGeneration !== token.generation) return false;
      return db().prepare('DELETE FROM leases WHERE key=? AND owner=? AND generation=?').run(token.key,token.owner,token.generation).changes > 0;
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
      const current = this.get(id);
      if (!p && !current?.images?.length && !current?.skills?.length) throw new Error('プロンプトを入力してください');
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
  const leased = new Set(db().prepare('SELECT payload FROM leases').all().map(row=>JSON.parse(row.payload).requestId));
  const finished = state.requests.filter((r) => FINAL_STATES.has(r.state) && !leased.has(r.id)).sort((a, b) => (b.endedAt || b.createdAt) - (a.endedAt || a.createdAt));
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

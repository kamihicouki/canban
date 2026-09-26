// Automatic moves: fire a rule when a session's status changes (or it shows new
// activity). The last observed status of each recent session is kept in
// <dataDir>/status.json, which belongs to Canban — agent data is never written.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const TRACK_MS = 48 * 3600e3; // forget sessions without activity for this long

export class RuleEngine {
  constructor(store) {
    this.store = store;
    this.file = path.join(store.dir, 'status.json');
  }

  loadCache(now) {
    try {
      const c = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (c && typeof c.startedAt === 'number' && c.sessions && typeof c.sessions === 'object') return c;
    } catch {}
    return { startedAt: now, sessions: {} };
  }

  async saveCache(cache) {
    await fsp.mkdir(this.store.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(cache), 'utf8');
    await fsp.rename(tmp, this.file);
  }

  // Returns the moves to apply: [{cardId, toListId, order, ruleId}].
  // `listOf(sessionId)` gives the card's current list; `topOrder(listId)` an order
  // value that puts a card at the top of that list.
  evaluate(args) {
    // Board loads and the background tick may overlap; evaluate one at a time so a
    // transition is observed (and fired) exactly once.
    const p = (this.queue || Promise.resolve()).then(() => this.evaluateNow(args));
    this.queue = p.catch(() => {});
    return p;
  }

  async evaluateNow({ rules, sessions, listOf, topOrder, now = Date.now() }) {
    const cache = this.loadCache(now);
    const active = rules.filter((r) => r.enabled);
    const moves = [];
    for (const s of sessions) {
      const prev = cache.sessions[s.id];
      const status = s.status || 'idle';
      const triggers = [];
      // undefined: PR data not loaded yet — neither fire nor overwrite the baseline
      const pr = s.pr === undefined ? undefined : s.pr ? `${s.pr.state}|${s.pr.checks || ''}` : null;
      if (!prev) {
        // Sessions that appear after tracking began count as a transition from nothing.
        if ((s.createdAt || 0) >= cache.startedAt) {
          if (status !== 'idle') triggers.push(`status:${status}`);
          triggers.push('activity');
        }
      } else {
        if (prev.status !== status && status !== 'idle') triggers.push(`status:${status}`);
        if ((s.updatedAt || 0) > (prev.updatedAt || 0)) triggers.push('activity');
        // PR / CI transitions (only once a baseline exists, so old PRs don't fire)
        if (pr && prev.pr !== undefined && prev.pr !== pr) {
          const [pState, pChecks] = (prev.pr || '|').split('|');
          if (s.pr.state !== pState) triggers.push({ OPEN: 'pr:opened', MERGED: 'pr:merged', CLOSED: 'pr:closed' }[s.pr.state]);
          if ((s.pr.checks || '') !== pChecks && s.pr.checks === 'failing') triggers.push('ci:failed');
          if ((s.pr.checks || '') !== pChecks && s.pr.checks === 'passing') triggers.push('ci:passed');
        }
      }
      const track = status !== 'idle' || (s.updatedAt || 0) >= now - TRACK_MS || (s.pr && s.pr.state === 'OPEN');
      if (track) cache.sessions[s.id] = { status, updatedAt: s.updatedAt || 0, seen: now, pr: pr === undefined ? prev?.pr : pr };
      if (!triggers.length || !active.length) continue;
      const current = listOf(s.id);
      const rule = active.find(
        (r) => triggers.includes(r.trigger) && (r.fromListId === 'any' || r.fromListId === current) && r.toListId !== current,
      );
      if (rule) moves.push({ cardId: s.id, toListId: rule.toListId, order: topOrder(rule.toListId), ruleId: rule.id });
    }
    for (const [id, v] of Object.entries(cache.sessions)) if (now - (v.seen || 0) > TRACK_MS) delete cache.sessions[id];
    await this.saveCache(cache);
    return moves;
  }
}

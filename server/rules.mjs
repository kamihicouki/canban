// Automatic moves: fire a rule when a session's status changes (or it shows new
// activity). The last observed status of each recent session is kept in
// the Canban database — agent data is never written.
import { leaderFor } from './leader.mjs';

// Claude's archive state is unknown when desktop metadata is unavailable.
const archiveState = (s) => typeof s.archived === 'boolean' && !(s.agent === 'claude' && s.desktopKnown === false) ? s.archived : undefined;

export function matchesRuleTrigger(trigger, session) {
  if (trigger.startsWith('status:')) return (session.status || 'idle') === trigger.slice(7);
  if (trigger === 'archived') return archiveState(session) === true;
  // Replaying activity applies the rule to every currently collected session.
  if (trigger === 'activity') return true;
  if (trigger.startsWith('section:')) return session.codexSection?.id === trigger.slice(8);
  if (trigger.startsWith('pr:')) return session.pr?.state === { opened: 'OPEN', merged: 'MERGED', closed: 'CLOSED' }[trigger.slice(3)];
  if (trigger.startsWith('ci:')) return session.pr?.checks === { failed: 'failing', passed: 'passing' }[trigger.slice(3)];
  return false;
}

// Manual replay uses current conditions, including old/archived sessions, without
// altering the transition cache or enabling a disabled rule.
export function replayRule({ rule, sessions, listOf, topOrder }) {
  const moves = [];
  for (const session of sessions) {
    const current = listOf(session.id);
    if (matchesRuleTrigger(rule.trigger, session) && (rule.fromListId === 'any' || rule.fromListId === current) && rule.toListId !== current) {
      moves.push({ cardId: session.id, fromListId: current, toListId: rule.toListId, order: topOrder(rule.toListId), ruleId: rule.id });
    }
  }
  return moves;
}

const TRACK_MS = 48 * 3600e3; // forget sessions without activity for this long

export class RuleEngine {
  constructor(store) {
    this.store = store;
  }

  async loadCache(now) {
    return await this.store.database.call('system','auxiliaryRead',['rules']) || { startedAt:now,sessions:{} };
  }
  async saveCache(cache) { await this.store.database.call('system','auxiliaryPut',['rules',cache]); }

  evaluate(args) {
    // Board loads and the background tick may overlap; evaluate one at a time so a
    // transition is observed (and fired) exactly once.
    const p = (this.queue || Promise.resolve()).then(async () => await leaderFor(this.store.dir).run(() => this.evaluateNow(args)) || []);
    this.queue = p.catch(() => {});
    return p;
  }

  async evaluateNow({ rules, sessions, listOf, topOrder, now = Date.now() }) {
    const cache = await this.loadCache(now);
    const active = rules.filter((r) => r.enabled);
    const trackArchive = active.some((r) => r.trigger === 'archived');
    const moves = [];
    for (const s of sessions) {
      const prev = cache.sessions[s.id];
      if (prev && (prev.updatedAt > (s.updatedAt || 0) || prev.seen > now)) continue;
      const status = s.status || 'idle';
      const triggers = [];
      // undefined: PR data not loaded yet — neither fire nor overwrite the baseline
      const pr = s.pr === undefined ? undefined : s.pr ? `${s.pr.state}|${s.pr.checks || ''}` : null;
      const section = s.codexSection?.id ?? null;
      const archived = archiveState(s);
      if (!prev) {
        // Sessions that appear after tracking began count as a transition from nothing.
        if ((s.createdAt || 0) >= cache.startedAt) {
          if (status !== 'idle') triggers.push(`status:${status}`);
          if (archived === true) triggers.push('archived');
          triggers.push('activity');
        }
      } else {
        if (prev.status !== status && status !== 'idle') triggers.push(`status:${status}`);
        if ((s.updatedAt || 0) > (prev.updatedAt || 0)) triggers.push('activity');
        if (prev.archived === false && archived === true) triggers.push('archived');
        // PR / CI transitions (only once a baseline exists, so old PRs don't fire)
        if (pr && prev.pr !== undefined && prev.pr !== pr) {
          const [pState, pChecks] = (prev.pr || '|').split('|');
          if (s.pr.state !== pState) triggers.push({ OPEN: 'pr:opened', MERGED: 'pr:merged', CLOSED: 'pr:closed' }[s.pr.state]);
          if ((s.pr.checks || '') !== pChecks && s.pr.checks === 'failing') triggers.push('ci:failed');
          if ((s.pr.checks || '') !== pChecks && s.pr.checks === 'passing') triggers.push('ci:passed');
        }
        // Codex section moves (once a baseline exists: 'section' in prev)
        if ('section' in prev && section && prev.section !== section) triggers.push(`section:${section}`);
      }
      // Threads in a Codex section are tracked too: they can be moved long after their last activity.
      const track = status !== 'idle' || (s.updatedAt || 0) >= now - TRACK_MS || (s.pr && s.pr.state === 'OPEN') || section || prev?.section || (trackArchive && archived !== undefined);
      if (track) cache.sessions[s.id] = { status, updatedAt: s.updatedAt || 0, seen: now, pr: pr === undefined ? prev?.pr : pr, section, archived: archived === undefined ? prev?.archived : archived };
      if (!triggers.length || !active.length) continue;
      const current = listOf(s.id);
      const matches = (r) => triggers.includes(r.trigger) && (r.fromListId === 'any' || r.fromListId === current) && r.toListId !== current;
      // An archive move wins over activity/status changes observed in the same tick.
      const rule = active.find((r) => r.trigger === 'archived' && matches(r)) || active.find(matches);
      if (rule) moves.push({ cardId: s.id, fromListId: current, toListId: rule.toListId, order: topOrder(rule.toListId), ruleId: rule.id });
    }
    for (const [id, v] of Object.entries(cache.sessions)) if (now - (v.seen || 0) > TRACK_MS) delete cache.sessions[id];
    await this.saveCache(cache);
    return moves;
  }
}

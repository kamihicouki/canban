// canban_watch: the long-poll behind the realtime board.
// Turns file events from the LiveHub into what the UI needs:
//   reload    the board changed in a way only a rebuild shows (store edits from another
//             app, a new session, Codex app state, a Claude desktop rename / archive / status)
//   requests  requests.json changed (queue / run state of sent prompts)
//   patches   [{ id, status, updatedAt, activity, signals }] for sessions whose log grew;
//             no listing, just one cached tail read per changed log
//   feed      items appended to the open session's log since `offset`
//   limits    Codex rate limits, when a Codex log changed (see signals.mjs)
// Patches of running sessions (and the open one) also carry `git` (gitlive.mjs).
import path from 'node:path';
import { stat, readJson } from './sources/readonly.mjs';
import { LOCAL_HOST, sessionKey } from './sources/util.mjs';
import { listCodexSessions } from './sources/codex.mjs';
import { localStatus } from './status.mjs';
import { readFeedDelta } from './feed.mjs';
import { onSessions, dropLocalCache } from './board.mjs';
import { perf } from './perf.mjs';
import { currentLimits, cardSignals } from './signals.mjs';
import { gitDirOf, refreshGit } from './gitlive.mjs';

export const WATCH_MAX_MS = 45000;

export function createWatch(hub) {
  // Local sessions from the latest listing: id -> session, log path -> id.
  const byId = new Map();
  const byPath = new Map();
  const byGitDir = new Map(); // git dir -> ids of running sessions in that repo
  let gitGen = 0;
  let lastBusy = [];
  onSessions((sessions) => {
    byId.clear();
    byPath.clear();
    const hot = [];
    const busy = [];
    for (const s of sessions) {
      byId.set(s.id, s);
      if (s.sourcePath) byPath.set(s.sourcePath, s.id);
      if (s.sourcePath && (s.status === 'running' || s.status === 'waiting')) {
        hot.push(s.sourcePath);
        if (s.cwd) busy.push(s);
      }
    }
    hub.setHot(hot);
    lastBusy = busy;
    if (hub.active) trackGit(busy, ++gitGen); // servers without an open board run nothing
  });

  // Watch the repos of running sessions and push their git state once it is known.
  async function trackGit(busy, gen) {
    const found = await Promise.all(busy.map(async (s) => [s, await gitDirOf(s.cwd)]));
    if (gen !== gitGen) return;
    byGitDir.clear();
    for (const [s, d] of found) if (d) byGitDir.set(d.gitDir, [...(byGitDir.get(d.gitDir) || []), s.id]);
    hub.setGitDirs(byGitDir.keys());
    for (const [s, d] of found) {
      if (!d) continue;
      const { changed } = await refreshGit(s.cwd);
      if (changed && gen === gitGen) hub.emit('git', d.gitDir);
    }
  }

  async function patchFor(s, { focused = false, grew = true } = {}) {
    const st = await stat(s.sourcePath);
    if (!st) return null;
    const probe = { ...s, updatedAt: Math.max(s.updatedAt || 0, st.mtimeMs) };
    const status = await localStatus(probe);
    const busy = status === 'running' || status === 'waiting';
    const git = (busy || focused) && s.cwd ? (await refreshGit(s.cwd, { grew })).value : null;
    return { id: s.id, status, updatedAt: probe.updatedAt, activity: probe.activity || null, signals: cardSignals(probe.signals), git, full: probe.signals || null };
  }

  async function codexChanges() {
    const { sessions } = await listCodexSessions(); // delta by updated_at; nothing when unchanged
    const out = { reload: false, ids: [] };
    for (const s of sessions) {
      const known = byId.get(s.id);
      if (!known) {
        if (!s.subagent && !s.archived) out.reload = true;
        continue;
      }
      if ((s.updatedAt || 0) > (known.updatedAt || 0) || s.title !== known.title || s.archived !== known.archived) {
        if (s.title !== known.title || s.archived !== known.archived) out.reload = true;
        out.ids.push(s.id);
      }
    }
    return out;
  }

  // Claude desktop metadata changed: rebuild only if it changes what the board shows
  // (the app also rewrites it for activity that the log already reports).
  async function desktopChanged(file) {
    if (!/^local_.*\.json$/.test(path.basename(file))) return true; // archive index or a directory
    let j;
    try {
      j = await readJson(file);
    } catch {
      return false; // mid-write; the rename that completes it sends another event
    }
    const s = j?.cliSessionId && byId.get(sessionKey('claude', LOCAL_HOST, j.cliSessionId));
    if (!s) return false; // a new session appears through its log
    const status = j.postTurnSummary?.status_category ?? j.statusCategory ?? null;
    return !s.desktopKnown || (j.isArchived === true) !== !!s.archived || (j.title ?? null) !== (s.desktopTitle ?? null) || status !== (s.desktopStatus ?? null);
  }

  // offset: where the client's feed continues; size: the log size it last saw (a partial
  // last line keeps size > offset without anything new to show).
  return async function watch({ since = null, cardId = null, offset = null, size = null, codexItems = false, timeoutMs = 20000 } = {}) {
    const focus = cardId ? byId.get(cardId) : null;
    hub.focus(focus?.sourcePath || null);
    if (since == null) {
      const starting = !hub.active;
      hub.touch();
      if (starting) trackGit(lastBusy, ++gitGen);
      return { seq: hub.seq, reload: false, requests: false, patches: [], feed: null };
    }
    // The open session's log grew since the client's offset (e.g. while it was opening): answer now.
    const behind = async () => {
      if (!focus?.sourcePath || offset == null) return false;
      const st = await stat(focus.sourcePath);
      return !!st && st.size !== Number(size ?? offset);
    };
    const wait = (await behind()) ? 0 : Math.min(Math.max(Number(timeoutMs) || 0, 0), WATCH_MAX_MS);
    const { seq, events } = await hub.wait(Number(since), { timeoutMs: wait });
    return perf.timed('live.watch', async () => {
      const res = { seq, reload: events === null, requests: events === null, patches: [], feed: null, limits: null };
      const changed = new Set();
      const seenDesktop = new Set();
      let relist = false; // the next board load must list sessions again
      for (const e of events || []) {
        if (e.kind === 'store' || e.kind === 'app') res.reload = true;
        else if (e.kind === 'rescan') res.reload = relist = true;
        else if (e.kind === 'desktop') {
          if (!relist && !seenDesktop.has(e.path)) {
            seenDesktop.add(e.path);
            if (await desktopChanged(e.path)) res.reload = relist = true;
          }
        }
        else if (e.kind === 'requests') res.requests = true;
        else if (e.kind === 'codex') {
          const c = await codexChanges();
          if (c.reload) res.reload = relist = true;
          for (const id of c.ids) changed.add(id);
        } else if (e.kind === 'git') {
          const dir = byGitDir.has(e.path) ? e.path : path.dirname(e.path);
          for (const id of byGitDir.get(dir) || []) changed.add(id);
          if (focus?.cwd && byGitDir.get(dir)?.includes(focus.id)) changed.add(focus.id);
        } else if (e.kind === 'file') {
          const id = byPath.get(e.path);
          if (id) changed.add(id);
          else if (path.basename(e.path).endsWith('.jsonl') && !e.path.includes(`${path.sep}subagents${path.sep}`)) res.reload = relist = true; // a new session
        }
      }
      for (const id of changed) {
        const s = byId.get(id);
        const p = s && (await patchFor(s, { focused: s.id === focus?.id }));
        if (p) res.patches.push(p);
      }
      if (focus && offset != null && (events === null || changed.has(focus.id) || (await behind()))) {
        try {
          res.feed = await readFeedDelta(focus, Number(offset), { codexItems });
          const p = res.patches.find((x) => x.id === focus.id) || (await patchFor(focus, { focused: true }));
          if (p) Object.assign(res.feed, { status: p.status, activity: p.activity, signals: p.full, git: p.git });
        } catch {}
      }
      if (relist) dropLocalCache();
      for (const p of res.patches) delete p.full; // the detail's copy rides on the feed
      if (res.patches.some((p) => p.id.startsWith('codex'))) res.limits = currentLimits();
      return res;
    });
  };
}

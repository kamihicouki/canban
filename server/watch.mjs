// canban_watch: the long-poll behind the realtime board.
// Turns file events from the LiveHub into what the UI needs:
//   reload    the board changed in a way only a rebuild shows (store edits from another
//             app, a new session, Codex app state)
//   requests  requests.json changed (queue / run state of sent prompts)
//   patches   [{ id, status, updatedAt, activity }] for sessions whose log grew;
//             no listing, just one cached tail read per changed log
//   feed      items appended to the open session's log since `offset`
import path from 'node:path';
import { stat } from './sources/readonly.mjs';
import { listCodexSessions } from './sources/codex.mjs';
import { localStatus } from './status.mjs';
import { readFeedDelta } from './feed.mjs';
import { onSessions } from './board.mjs';
import { perf } from './perf.mjs';

export const WATCH_MAX_MS = 45000;

export function createWatch(hub) {
  // Local sessions from the latest listing: id -> session, log path -> id.
  const byId = new Map();
  const byPath = new Map();
  onSessions((sessions) => {
    byId.clear();
    byPath.clear();
    const hot = [];
    for (const s of sessions) {
      byId.set(s.id, s);
      if (s.sourcePath) byPath.set(s.sourcePath, s.id);
      if (s.sourcePath && (s.status === 'running' || s.status === 'waiting')) hot.push(s.sourcePath);
    }
    hub.setHot(hot);
  });

  async function patchFor(s) {
    const st = await stat(s.sourcePath);
    if (!st) return null;
    const probe = { ...s, updatedAt: Math.max(s.updatedAt || 0, st.mtimeMs) };
    const status = await localStatus(probe);
    return { id: s.id, status, updatedAt: probe.updatedAt, activity: probe.activity || null };
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

  // offset: where the client's feed continues; size: the log size it last saw (a partial
  // last line keeps size > offset without anything new to show).
  return async function watch({ since = null, cardId = null, offset = null, size = null, codexItems = false, timeoutMs = 20000 } = {}) {
    const focus = cardId ? byId.get(cardId) : null;
    hub.focus(focus?.sourcePath || null);
    if (since == null) {
      hub.touch();
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
      const res = { seq, reload: events === null, requests: events === null, patches: [], feed: null };
      const changed = new Set();
      for (const e of events || []) {
        if (e.kind === 'store' || e.kind === 'app' || e.kind === 'rescan') res.reload = true;
        else if (e.kind === 'requests') res.requests = true;
        else if (e.kind === 'codex') {
          const c = await codexChanges();
          if (c.reload) res.reload = true;
          for (const id of c.ids) changed.add(id);
        } else if (e.kind === 'file') {
          const id = byPath.get(e.path);
          if (id) changed.add(id);
          else if (path.basename(e.path).endsWith('.jsonl') && !e.path.includes(`${path.sep}subagents${path.sep}`)) res.reload = true; // a new session
        }
      }
      for (const id of changed) {
        const s = byId.get(id);
        const p = s && (await patchFor(s));
        if (p) res.patches.push(p);
      }
      if (focus && offset != null && (events === null || changed.has(focus.id) || (await behind()))) {
        try {
          res.feed = await readFeedDelta(focus, Number(offset), { codexItems });
          const p = res.patches.find((x) => x.id === focus.id) || (await patchFor(focus));
          if (p) Object.assign(res.feed, { status: p.status, activity: p.activity });
        } catch {}
      }
      return res;
    });
  };
}

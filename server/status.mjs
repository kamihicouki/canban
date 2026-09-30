// Live session status derived from the tail of a session log (read-only).
//   running   — a turn is in progress
//   waiting   — the agent asked the user something and is waiting for an answer
//   completed — the last turn finished
//   aborted   — the last turn was interrupted
//   idle      — no recent activity (or nothing to go on)
// Keep the rules in sync with codex_status / claude_status in server/remote/collect.py.
import { stat } from './sources/readonly.mjs';
import { itemsFor, activityOf, readLines, FEED_MAX_DELTA } from './feed.mjs';
import { newAcc, foldSignals, signalsView, limitsFrom, noteLimits } from './signals.mjs';
import { limitsAccount } from './accounts.mjs';

export const STATUSES = ['running', 'waiting', 'completed', 'aborted', 'idle'];
export const RECENT_MS = 24 * 3600e3; // older sessions are always idle
export const STALE_MS = 15 * 60e3; // "running" with no writes for this long is treated as idle
export const TAIL_BYTES = 256 * 1024;

const ASK_TOOLS = new Set(['request_user_input', 'AskUserQuestion', 'ExitPlanMode']);

export function settle(state, mtimeMs, now = Date.now()) {
  if ((state === 'running' || state === 'waiting') && now - mtimeMs > STALE_MS) return 'idle';
  return state;
}

export function codexStatusFromRecords(records, mtimeMs, now = Date.now()) {
  return settle(codexRawStatus(records), mtimeMs, now);
}

export function codexRawStatus(records) {
  let state = 'idle';
  const asks = new Set();
  for (const o of records) {
    const p = o?.payload;
    if (!p) continue;
    if (o.type === 'event_msg') {
      if (p.type === 'task_started') state = 'running';
      else if (p.type === 'task_complete') state = 'completed';
      else if (p.type === 'turn_aborted') state = 'aborted';
    } else if (o.type === 'response_item') {
      if (p.type === 'function_call' && ASK_TOOLS.has(p.name) && p.call_id) asks.add(p.call_id);
      else if (p.type === 'function_call_output' && p.call_id) asks.delete(p.call_id);
    }
  }
  if (state === 'running' && asks.size) state = 'waiting';
  return state;
}

function contentList(o) {
  const c = o?.message?.content;
  return Array.isArray(c) ? c : [];
}

export function claudeStatusFromRecords(records, mtimeMs, now = Date.now(), desktopStatus = null) {
  return settle(claudeRawStatus(records, desktopStatus), mtimeMs, now);
}

export function claudeRawStatus(records, desktopStatus = null) {
  let state = 'idle';
  const asks = new Set();
  for (const o of records) {
    if (!o || o.isSidechain || (o.type !== 'user' && o.type !== 'assistant')) continue;
    const items = contentList(o);
    if (o.type === 'assistant') {
      for (const it of items) if (it?.type === 'tool_use' && ASK_TOOLS.has(it.name) && it.id) asks.add(it.id);
      const stop = o.message?.stop_reason;
      state = stop === 'end_turn' || stop === 'stop_sequence' ? 'completed' : 'running';
    } else {
      for (const it of items) if (it?.type === 'tool_result' && it.tool_use_id) asks.delete(it.tool_use_id);
      const text = typeof o.message?.content === 'string' ? o.message.content : items.map((it) => (it?.type === 'text' ? it.text : '')).join('');
      state = /\[Request interrupted by user/.test(text) ? 'aborted' : 'running';
    }
  }
  if (state === 'running' && asks.size) state = 'waiting';
  return refineClaude(state, desktopStatus);
}

// The Claude desktop app's post-turn summary refines a finished turn.
export function refineClaude(state, desktopStatus) {
  if (state !== 'completed' || !desktopStatus) return state;
  const d = String(desktopStatus).toLowerCase();
  if (/input|waiting|question|blocked|needs/.test(d)) return 'waiting';
  if (/error|fail/.test(d)) return 'aborted';
  return state;
}

// ---- local sessions -------------------------------------------------------
const cache = new Map(); // path -> { mtimeMs, size, desktopStatus, raw, activity, signals }
const sigAcc = new Map(); // path -> { offset, acc }: signals folded up to `offset`

// Signals follow the whole log since it was first read (a turn's edited files can lie
// before the tail): later changes fold only the appended lines into the accumulator.
async function signalsOf(session, tail) {
  const file = session.sourcePath;
  let e = sigAcc.get(file);
  if (e && e.agent === session.agent && tail.size >= e.offset && tail.size - e.offset <= FEED_MAX_DELTA) {
    const d = await readLines(file, { start: e.offset });
    if (!d.reset) {
      foldSignals(e.acc, d.records);
      e.offset = d.offset;
      if (session.agent === 'codex') noteLimits(limitsFrom(d.records), limitsAccount(session));
      return signalsView(e.acc);
    }
  }
  e = { agent: session.agent, offset: tail.offset, acc: foldSignals(newAcc(session.agent), tail.records) };
  sigAcc.set(file, e);
  if (session.agent === 'codex') noteLimits(limitsFrom(tail.records), limitsAccount(session));
  return signalsView(e.acc);
}

// Status (and, while it runs, what the session is doing) from the log tail.
// Sets `session.activity` and `session.signals`; the tail is only re-read when the log changed.
export async function localStatus(session, now = Date.now()) {
  session.activity = null;
  session.signals = null;
  if (!session.sourcePath || (session.updatedAt || 0) < now - RECENT_MS) return 'idle';
  const st = await stat(session.sourcePath);
  if (!st) return 'idle';
  let hit = cache.get(session.sourcePath);
  if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size || hit.desktopStatus !== session.desktopStatus) {
    const tail = await readLines(session.sourcePath, { tailBytes: TAIL_BYTES });
    const { records } = tail;
    const raw = session.agent === 'codex' ? codexRawStatus(records) : claudeRawStatus(records, session.desktopStatus);
    const activity = raw === 'running' || raw === 'waiting' ? activityOf(itemsFor(session.agent, records.slice(-200), {})) : null;
    const signals = await signalsOf(session, tail);
    hit = { mtimeMs: st.mtimeMs, size: st.size, desktopStatus: session.desktopStatus, raw, activity, signals };
    cache.set(session.sourcePath, hit);
  }
  const status = settle(hit.raw, st.mtimeMs, now);
  session.signals = hit.signals;
  if (status === 'running' || status === 'waiting') session.activity = hit.activity;
  return status;
}

// Set `status` on every session. Remote sessions carry the collector's raw status
// and log mtime; local ones are read here.
export async function annotateStatus(sessions, now = Date.now()) {
  await Promise.all(
    sessions.map(async (s) => {
      if (s.host && s.host.local === false) {
        const recent = (s.updatedAt || 0) >= now - RECENT_MS;
        const raw = s.agent === 'claude' ? refineClaude(s.rawStatus, s.desktopStatus) : s.rawStatus;
        s.status = recent && raw && s.statusMtimeMs ? settle(raw, s.statusMtimeMs, now) : 'idle';
      } else {
        s.status = await localStatus(s, now);
      }
    }),
  );
  return sessions;
}

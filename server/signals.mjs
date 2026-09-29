// Live signals from the tail of a session log (read-only): what the agent apps show
// around the conversation, derived from records they already write.
//   ctx     { used, window }   tokens in the context after the last reply (window: null if unknown)
//   plan    { done, total, current, steps }   the agent's latest to-do list / plan
//   files   { count, names }   files the current turn edited
//   subRunning                 Claude sub-agents (Task / Agent) still running
//   wait    'question' | 'plan' | null   what a waiting session waits for
//   model / effort / mode      as last applied (mode: Claude permission mode, Codex sandbox)
// Codex also logs its account's rate limits; limitsFrom() picks the latest.
import path from 'node:path';

const FILE_NAMES = 12;
const PLAN_STEPS = 12;
const CLAUDE_WINDOW = 200_000;
const CLAUDE_WINDOW_1M = 1_000_000;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SUB_TOOLS = new Set(['Task', 'Agent']);
const WAIT_KIND = { AskUserQuestion: 'question', request_user_input: 'question', request_user_input_async: 'question', ExitPlanMode: 'plan' };

function parse(a) {
  if (a && typeof a === 'object') return a;
  try {
    return JSON.parse(a);
  } catch {
    return {};
  }
}

function planOf(steps, textKey) {
  if (!Array.isArray(steps) || !steps.length) return null;
  const list = steps.map((x) => ({ t: String(x?.[textKey] ?? x?.content ?? '').slice(0, 160), s: x?.status === 'completed' ? 'done' : x?.status === 'in_progress' ? 'doing' : 'todo' }));
  const doing = steps.find((x) => x?.status === 'in_progress');
  return {
    done: list.filter((x) => x.s === 'done').length,
    total: list.length,
    current: doing ? String(doing.activeForm || doing[textKey] || doing.content || '').slice(0, 160) : null,
    steps: list.slice(0, PLAN_STEPS),
  };
}

function patchPaths(text) {
  return [...String(text || '').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
}

function filesView(set) {
  if (!set.size) return null;
  const all = [...set];
  return { count: all.length, names: all.slice(-FILE_NAMES).map((p) => path.basename(p)), paths: all.slice(-FILE_NAMES) };
}

// Signals are folded record by record, so a growing log only needs its appended lines
// (status.mjs keeps one accumulator per log and feeds it the delta).
export function newAcc(agent) {
  return { agent, ctx: null, plan: null, files: new Set(), subs: new Set(), asks: new Map(), model: null, effort: null, mode: null };
}

function newTurn(acc) {
  acc.files = new Set();
  acc.subs.clear();
  acc.asks.clear();
}

function foldClaude(acc, o) {
  if (!o || typeof o !== 'object') return;
  if (typeof o.permissionMode === 'string') acc.mode = o.permissionMode;
  if (o.isSidechain) return;
  const c = o.message?.content;
  if (o.type === 'assistant') {
    const m = o.message || {};
    if (m.model && m.model !== '<synthetic>') acc.model = m.model;
    if (typeof o.effort === 'string') acc.effort = o.effort;
    const u = m.usage;
    const used = u ? (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.output_tokens) || 0) : 0;
    if (used) acc.ctx = { used, window: /\[1m\]/i.test(m.model || '') || used > CLAUDE_WINDOW ? CLAUDE_WINDOW_1M : null };
    for (const it of Array.isArray(c) ? c : []) {
      if (it?.type !== 'tool_use') continue;
      const i = it.input || {};
      if (EDIT_TOOLS.has(it.name) && (i.file_path || i.notebook_path)) acc.files.add(i.file_path || i.notebook_path);
      else if (it.name === 'TodoWrite') acc.plan = planOf(i.todos, 'content');
      if (SUB_TOOLS.has(it.name) && it.id) acc.subs.add(it.id);
      if (WAIT_KIND[it.name] && it.id) acc.asks.set(it.id, WAIT_KIND[it.name]);
    }
  } else if (o.type === 'user') {
    if (Array.isArray(c) && c.some((x) => x?.type === 'tool_result')) {
      for (const it of c) if (it?.type === 'tool_result') {
        acc.subs.delete(it.tool_use_id);
        acc.asks.delete(it.tool_use_id);
      }
    } else if (!o.isMeta) newTurn(acc); // a new prompt starts a new turn
  }
}

function foldCodex(acc, o) {
  const p = o?.payload;
  if (!p) return;
  if (o.type === 'turn_context') {
    if (p.model) acc.model = p.model;
    if (p.effort) acc.effort = p.effort;
    if (p.sandbox_policy?.type) acc.mode = p.sandbox_policy.type;
  } else if (o.type === 'event_msg') {
    if (p.type === 'task_started') newTurn(acc);
    else if (p.type === 'token_count' && p.info) {
      const last = p.info.last_token_usage;
      const used = Number(last?.total_tokens) || (Number(last?.input_tokens) || 0) + (Number(last?.output_tokens) || 0);
      if (used) acc.ctx = { used, window: Number(p.info.model_context_window) || null };
    } else if (p.type === 'item_completed' && p.item?.type === 'FileChange' && p.item.changes && typeof p.item.changes === 'object') {
      for (const f of Object.keys(p.item.changes)) acc.files.add(f);
    }
  } else if (o.type === 'response_item') {
    if (p.type === 'function_call') {
      const a = parse(p.arguments);
      if (p.name === 'update_plan') acc.plan = planOf(a.plan, 'step');
      else if (p.name === 'apply_patch') for (const f of patchPaths(a.input ?? a.patch)) acc.files.add(f);
      if (WAIT_KIND[p.name] && p.call_id) acc.asks.set(p.call_id, WAIT_KIND[p.name]);
    } else if (p.type === 'custom_tool_call' && p.name === 'apply_patch') {
      for (const f of patchPaths(p.input)) acc.files.add(f);
    } else if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && p.call_id) {
      acc.asks.delete(p.call_id);
    }
  }
}

export function foldSignals(acc, records) {
  const fold = acc.agent === 'codex' ? foldCodex : foldClaude;
  for (const o of records) fold(acc, o);
  return acc;
}

export function signalsView(acc) {
  return {
    ctx: acc.ctx,
    plan: acc.plan,
    files: filesView(acc.files),
    subRunning: acc.agent === 'codex' ? 0 : acc.subs.size,
    wait: [...acc.asks.values()].pop() || null,
    model: acc.model,
    effort: acc.effort,
    mode: acc.mode,
  };
}

export const claudeSignals = (records) => signalsView(foldSignals(newAcc('claude'), records));
export const codexSignals = (records) => signalsView(foldSignals(newAcc('codex'), records));

export function signalsFor(agent, records) {
  return agent === 'codex' ? codexSignals(records) : claudeSignals(records);
}

// The newest Codex rate-limit snapshot in the records: { at, primary, secondary, plan }.
export function limitsFrom(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const o = records[i];
    const r = o?.type === 'event_msg' && o.payload?.type === 'token_count' ? o.payload.rate_limits : null;
    if (!r || (!r.primary && !r.secondary)) continue;
    const win = (w) => (w && typeof w.used_percent === 'number' ? { usedPercent: w.used_percent, windowMinutes: Number(w.window_minutes) || null, resetsAt: w.resets_at ? Number(w.resets_at) * 1000 : null } : null);
    return { at: Date.parse(o.timestamp) || 0, primary: win(r.primary), secondary: win(r.secondary), plan: r.plan_type || null, reached: r.rate_limit_reached_type || null };
  }
  return null;
}

// Latest snapshot seen by this server (any Codex session read since it started).
let latest = null;
export function noteLimits(l) {
  if (l && (!latest || l.at > latest.at)) latest = l;
  return latest;
}
export function currentLimits() {
  if (!latest) return null;
  // A window that has already reset no longer says anything about usage.
  const now = Date.now();
  const fresh = (w) => (w && (!w.resetsAt || w.resetsAt > now) ? w : w ? { ...w, usedPercent: 0, stale: true } : null);
  return { ...latest, primary: fresh(latest.primary), secondary: fresh(latest.secondary) };
}
export function resetLimitsForTest() {
  latest = null;
}

// What a card on the board needs (the detail view gets the full signals).
export function cardSignals(sig) {
  if (!sig) return null;
  const { plan, files, ...rest } = sig;
  return {
    ...rest,
    plan: plan ? { done: plan.done, total: plan.total, current: plan.current } : null,
    files: files ? { count: files.count, names: files.names.slice(-5) } : null,
  };
}

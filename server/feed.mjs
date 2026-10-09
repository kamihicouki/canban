// Live session feed: turns the records of a session log into the items a native agent
// app shows (messages, tool calls with their result, reasoning, turn ends), and reads
// only the bytes appended since the last read. Read-only, like the source readers.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { clip, cleanPrompt } from './sources/util.mjs';
import { textOf, isHumanPrompt } from './sources/claude.mjs';

export const FEED_TAIL_BYTES = 512 * 1024; // first read of a session
export const FEED_MAX_DELTA = 1024 * 1024; // larger appends restart from the tail
export const FEED_ITEMS = 120;
const TEXT_MAX = 4000;
const OUT_MAX = 600;

// Read complete JSON lines from `start` (or the last `tailBytes`) to the last newline.
// `offset` is where the next read continues; a partial last line is left for it.
export async function readLines(file, { start = null, tailBytes = FEED_TAIL_BYTES } = {}) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    let from = start == null ? Math.max(0, size - tailBytes) : start;
    let reset = false;
    if (start != null && (start > size || size - start > FEED_MAX_DELTA)) {
      from = Math.max(0, size - tailBytes); // truncated, rewritten or far behind
      reset = true;
    }
    const buf = Buffer.alloc(size - from);
    if (buf.length) await fh.read(buf, 0, buf.length, from);
    const end = buf.lastIndexOf(10); // '\n'
    const body = end < 0 ? '' : buf.subarray(0, end).toString('utf8');
    let lines = body.split('\n');
    if (from > 0 && (start == null || reset)) lines = lines.slice(1); // started mid-line
    const records = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        records.push(JSON.parse(line));
      } catch {}
    }
    return { records, offset: end < 0 ? from : from + end + 1, size, reset };
  } finally {
    await fh.close();
  }
}

// ---- tool summaries -------------------------------------------------------
const base = (p) => (typeof p === 'string' && p ? path.basename(p) : '');
function parseArgs(a) {
  if (a && typeof a === 'object') return a;
  try {
    return JSON.parse(a);
  } catch {
    return typeof a === 'string' ? { raw: a } : {};
  }
}
const cmdText = (c) => (Array.isArray(c) ? (c[0] === 'bash' && c[1] === '-lc' ? c.slice(2).join(' ') : c.join(' ')) : String(c ?? ''));

function patchFiles(text) {
  const files = [...String(text || '').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => base(m[1].trim()));
  return files.length ? files.join(', ') : '';
}

export function claudeToolSummary(name, input = {}) {
  const i = input || {};
  switch (name) {
    case 'Bash':
      return i.description ? `${i.description} — ${i.command ?? ''}` : String(i.command ?? '');
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return base(i.file_path || i.notebook_path);
    case 'Grep':
    case 'Glob':
      return `${i.pattern ?? ''}${i.path ? ` in ${base(i.path)}` : ''}`;
    case 'Task':
    case 'Agent':
      return i.description || i.subagent_type || '';
    case 'WebFetch':
      return i.url || '';
    case 'WebSearch':
      return i.query || '';
    case 'TodoWrite':
      return Array.isArray(i.todos) ? `${i.todos.filter((t) => t.status === 'completed').length}/${i.todos.length} 完了` : '';
    default: {
      const v = Object.values(i).find((x) => typeof x === 'string');
      return v || '';
    }
  }
}

function toolLabel(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name || '');
  return m ? `${m[1]}: ${m[2]}` : name || 'tool';
}

function codexTool(p) {
  switch (p.type) {
    case 'function_call': {
      const a = parseArgs(p.arguments);
      if (p.name === 'shell' || p.name === 'exec_command' || p.name === 'container.exec' || p.name === 'shell_command') return { name: 'Shell', summary: cmdText(a.command ?? a.cmd ?? a.raw) };
      if (p.name === 'apply_patch') return { name: 'Edit', summary: patchFiles(a.input ?? a.patch ?? a.raw) };
      if (p.name === 'update_plan') return { name: 'Plan', summary: Array.isArray(a.plan) ? `${a.plan.filter((s) => s.status === 'completed').length}/${a.plan.length} 完了` : '' };
      if (p.name === 'view_image') return { name: 'Image', summary: base(a.path) };
      return { name: toolLabel(p.name), summary: Object.values(a).find((x) => typeof x === 'string') || '' };
    }
    case 'custom_tool_call':
      if (p.name === 'apply_patch') return { name: 'Edit', summary: patchFiles(p.input) };
      return { name: toolLabel(p.name), summary: typeof p.input === 'string' ? p.input.split('\n')[0] : '' };
    case 'local_shell_call':
      return { name: 'Shell', summary: cmdText(p.action?.command) };
    case 'web_search_call':
      return { name: 'WebSearch', summary: p.action?.query || '' };
    default:
      return null;
  }
}

function outText(o) {
  if (o == null) return '';
  if (typeof o === 'string') {
    const j = parseArgs(o);
    if (j && typeof j.output === 'string') return j.output;
    return o;
  }
  if (Array.isArray(o)) return o.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('\n');
  if (typeof o.content === 'string') return o.content;
  if (typeof o.output === 'string') return o.output;
  return '';
}

function codexFailed(o) {
  const t = outText(o);
  if (o && typeof o === 'object' && o.success === false) return true;
  const j = typeof o === 'string' ? parseArgs(o) : null;
  const m = /^Exit code: (\d+)/m.exec(t);
  const code = j?.metadata?.exit_code ?? (m ? Number(m[1]) : null);
  return code != null && code !== 0;
}

// ---- record → items -----------------------------------------------------------
// Items: { k: 'user' | 'assistant' | 'commentary' | 'thinking' | 'tool' | 'result' | 'turn', id, at, ... }
// A 'result' item completes an earlier 'tool' item (ref = tool id).
export function codexItems(records, ctx = {}) {
  const out = [];
  // Newer rollouts log messages as item_completed; older ones only as user_message / agent_message.
  ctx.items ||= records.some((o) => o?.type === 'event_msg' && o.payload?.type === 'item_completed' && /^(User|Agent)Message$/.test(o.payload.item?.type || ''));
  for (const o of records) {
    const p = o?.payload;
    if (!p) continue;
    const at = o.timestamp || null;
    if (o.type === 'event_msg') {
      if (p.type === 'item_completed' && p.item) {
        const it = p.item;
        const text = (it.content || []).map((c) => c.text || '').filter(Boolean).join('\n');
        if (it.type === 'UserMessage') {
          ctx.items = true;
          const t = cleanPrompt(text);
          if (t) out.push({ k: 'user', id: it.id || null, at, text: clip(t, TEXT_MAX) });
        } else if (it.type === 'AgentMessage') {
          ctx.items = true;
          if (text.trim()) out.push({ k: it.phase === 'commentary' ? 'commentary' : 'assistant', id: it.id || null, at, text: clip(text.trim(), TEXT_MAX) });
        }
      } else if (!ctx.items && p.type === 'user_message' && p.message) {
        const t = cleanPrompt(p.message);
        if (t) out.push({ k: 'user', at, text: clip(t, TEXT_MAX) });
      } else if (!ctx.items && p.type === 'agent_message' && p.message) {
        out.push({ k: 'assistant', at, text: clip(String(p.message).trim(), TEXT_MAX) });
      } else if (p.type === 'task_started') out.push({ k: 'turn', at, state: 'started' });
      else if (p.type === 'task_complete') out.push({ k: 'turn', at, state: 'completed' });
      else if (p.type === 'turn_aborted') out.push({ k: 'turn', at, state: 'aborted' });
    } else if (o.type === 'response_item') {
      if (p.type === 'reasoning') {
        const text = (p.summary || []).map((s) => s.text || '').filter(Boolean).join('\n');
        out.push({ k: 'thinking', at, text: clip(text, TEXT_MAX) });
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        out.push({ k: 'result', ref: p.call_id, at, ok: !codexFailed(p.output), out: clip(outText(p.output).trim(), OUT_MAX) });
      } else {
        const t = codexTool(p);
        if (t) {
          const id = p.call_id || p.id || null;
          out.push({ k: 'tool', id, at, name: t.name, summary: clip(t.summary.replace(/\s+/g, ' ').trim(), 240), state: p.type === 'web_search_call' ? 'ok' : 'running' });
        }
      }
    }
  }
  return out;
}

export function claudeItems(records) {
  const out = [];
  for (const o of records) {
    if (!o || o.isSidechain || (o.type !== 'user' && o.type !== 'assistant')) continue;
    const at = o.timestamp || null;
    const c = o.message?.content;
    if (o.type === 'user') {
      if (isHumanPrompt(o)) {
        const raw = textOf(c);
        if (/\[Request interrupted by user/.test(raw)) {
          out.push({ k: 'turn', at, state: 'aborted' });
          continue;
        }
        const t = cleanPrompt(raw);
        if (t) out.push({ k: 'user', id: o.uuid || null, at, text: clip(t, TEXT_MAX) });
      } else if (Array.isArray(c)) {
        for (const it of c) {
          if (it?.type !== 'tool_result') continue;
          const body = typeof it.content === 'string' ? it.content : textOf(it.content);
          out.push({ k: 'result', ref: it.tool_use_id, at, ok: !it.is_error, out: clip(String(body || '').trim(), OUT_MAX) });
        }
      }
      continue;
    }
    const items = Array.isArray(c) ? c : typeof c === 'string' ? [{ type: 'text', text: c }] : [];
    for (const it of items) {
      if (it?.type === 'text' && it.text?.trim()) out.push({ k: 'assistant', id: o.uuid || null, at, text: clip(it.text.trim(), TEXT_MAX) });
      else if (it?.type === 'thinking') out.push({ k: 'thinking', at, text: clip(it.thinking || '', TEXT_MAX) });
      else if (it?.type === 'tool_use') {
        out.push({ k: 'tool', id: it.id, at, name: toolLabel(it.name), summary: clip(String(claudeToolSummary(it.name, it.input)).replace(/\s+/g, ' ').trim(), 240), state: 'running' });
      }
    }
    const stop = o.message?.stop_reason;
    if (stop === 'end_turn' || stop === 'stop_sequence') out.push({ k: 'turn', at, state: 'completed' });
  }
  return out;
}

export function itemsFor(agent, records, ctx) {
  return agent === 'codex' ? codexItems(records, ctx) : claudeItems(records);
}

// Fold 'result' items into the tool they complete; keep the last `limit` items.
export function foldResults(items, limit = FEED_ITEMS) {
  const tools = new Map();
  const out = [];
  for (const it of items) {
    if (it.k === 'result') {
      const t = tools.get(it.ref);
      if (t) Object.assign(t, { state: it.ok ? 'ok' : 'error', out: it.out });
      continue;
    }
    if (it.k === 'turn' && it.state === 'started') continue;
    if (it.k === 'tool' && it.id) tools.set(it.id, it);
    out.push(it);
  }
  return out.slice(-limit);
}

// What the session is doing right now, for the card on the board (one line).
export function activityOf(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.k === 'result') continue;
    if (it.k === 'turn') return null;
    if (it.k === 'tool') return clip(`${it.name}${it.summary ? `: ${it.summary}` : ''}`, 120);
    if (it.k === 'thinking') return '考えています…';
    if (it.k === 'assistant' || it.k === 'commentary') return clip(it.text.split('\n').find(Boolean) || '', 120);
    if (it.k === 'user') return null;
  }
  return null;
}

// The agent's last reply in the tail (what a card shows as its latest word).
export function lastSaidOf(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].k !== 'assistant' || !items[i].text) continue;
    const plain = items[i].text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^[ \t]*(?:#{1,6}[ \t]+|[-*+][ \t]+|\d+\.[ \t]+|>[ \t]?)/gm, '')
      .replace(/(\*\*|__|\*|`)/g, '')
      .replace(/\s+/g, ' ').trim();
    if (plain) return clip(plain, 240);
  }
  return null;
}

// First read of a session: the tail, as folded items, and where to continue.
export async function readFeed(session, { limit = FEED_ITEMS } = {}) {
  const { records, offset, size } = await readLines(session.sourcePath);
  const ctx = {};
  return { items: foldResults(itemsFor(session.agent, records, ctx), limit), offset, size, codexItems: !!ctx.items };
}

// Items appended since `offset` (results unfolded: the client completes its tools).
export async function readFeedDelta(session, offset, { codexItems: seenItems = false } = {}) {
  const { records, offset: next, size, reset } = await readLines(session.sourcePath, { start: offset });
  if (reset) return { reset: true, ...(await readFeed(session)) };
  const ctx = { items: seenItems };
  const items = itemsFor(session.agent, records, ctx).filter((it) => !(it.k === 'turn' && it.state === 'started'));
  return { items, offset: next, size, codexItems: !!ctx.items };
}

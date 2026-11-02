// Confirmed message provenance, independent of task links and spawn edges.
// Files are read only. Large initial histories are explicitly marked partial.
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { readLines, FEED_MAX_DELTA } from './feed.mjs';

const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const textOf = content => (Array.isArray(content) ? content : []).map(c => typeof c?.text === 'string' ? c.text : '').join('\n');
const decode = text => text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const scopeOf = s => JSON.stringify([s.host?.id || 'local', s.homeDir || s.home || 'default']);
const nativeKey = (scope, id) => JSON.stringify([scope, id]);
const newer = (a, b) => (b.at || '').localeCompare(a.at || '') || a.id.localeCompare(b.id);
const fingerprint = e => digest(JSON.stringify([e.source, e.target, e.at, e.text]));
function mergeEvents(rows) {
  const unique = [...new Map(rows.map(e => [e.id, e])).values()];
  const modern = new Set(unique.filter(e => !e.legacy).map(fingerprint));
  return unique.filter(e => !e.legacy || !modern.has(fingerprint(e)));
}

export function parseExchangeRecords(records, receiver) {
  const events = new Map();
  for (const record of records) {
    const p = record?.payload;
    if (!['event_msg', 'response_item'].includes(record?.type) || !p) continue;
    let source, target = receiver.nativeId, text, messageId, raw, legacy = false;
    const item = p.type === 'item_completed' ? p.item : p;
    const toolDelivery = ['FunctionCallOutput', 'function_call_output'].includes(item?.type)
      && item.namespace === 'codex_app' && ['create_thread', 'send_message_to_thread'].includes(item.name);
    if (p.type === 'item_completed' && p.item?.type === 'UserMessage' || p.type === 'user_message') {
      raw = p.item ? textOf(p.item.content) : p.message;
      messageId = p.item?.id; legacy = p.type === 'user_message';
    } else if (toolDelivery) {
      raw = item.output; messageId = item.id;
    } else if (p.type === 'collab_agent_interaction_end' || p.type === 'collab_agent_spawn_end') {
      if (p.error || p.status === 'errored' || p.status === 'not_found' || p.status === 'error') continue;
      source = p.sender_thread_id; target = p.receiver_thread_id || p.new_thread_id; text = p.prompt; messageId = p.call_id;
    } else continue;
    if (raw !== undefined) {
      if (typeof raw !== 'string') continue;
      // Match the entire transport envelope, never an example quoted in a tool or message.
      const m = /^<codex_delegation>\s*<source_thread_id>([^<>]+)<\/source_thread_id>\s*<input>([\s\S]*?)<\/input>\s*<\/codex_delegation>$/.exec(raw.trim());
      if (!m || !m[1].trim() || m[1].length > 160) continue;
      source = decode(m[1].trim()); text = decode(m[2]);
    }
    if (typeof source !== 'string' || typeof target !== 'string' || typeof text !== 'string' || source === target) continue;
    const at = typeof record.timestamp === 'string' && Number.isFinite(Date.parse(record.timestamp)) ? new Date(record.timestamp).toISOString() : null;
    const id = `${receiver.id}:${messageId || digest(JSON.stringify([source, target, at, text]))}`;
    events.set(id, { id, source, target, at, text: text.slice(0, 4000), legacy });
  }
  return mergeEvents([...events.values()]);
}

export class ExchangeIndex {
  constructor({ tailBytes = 256 * 1024, maxEvents = 1000 } = {}) {
    this.tailBytes = tailBytes; this.maxEvents = maxEvents;
    this.files = new Map(); this.sessions = new Map(); this.byNative = new Map();
    this.rows = new Map(); this.incomplete = new Set(); this.pending = null;
  }

  async sync(sessions) {
    const work = (this.pending || Promise.resolve()).catch(() => {}).then(() => this.update(sessions));
    this.pending = work;
    try { await work; } finally { if (this.pending === work) this.pending = null; }
  }

  async update(sessions) {
    const codex = sessions.filter(s => s.agent === 'codex');
    this.sessions = new Map(codex.map(s => [s.id, s]));
    this.byNative = new Map(codex.map(s => [nativeKey(scopeOf(s), s.nativeId), s]));
    const local = codex.filter(s => s.sourcePath && s.host?.local !== false && !s.cloud);
    const live = new Set(local.map(s => s.id));
    for (const id of this.files.keys()) if (!live.has(id)) this.files.delete(id);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(6, local.length) }, async () => {
      while (next < local.length) await this.read(local[next++]);
    }));
    this.rows = new Map(); this.incomplete = new Set();
    for (const [owner, file] of this.files) {
      const scope = scopeOf(this.sessions.get(owner));
      if (file.partial || file.error) this.incomplete.add(scope);
      for (const event of file.events) {
        const source = this.byNative.get(nativeKey(scope, event.source));
        const target = this.byNative.get(nativeKey(scope, event.target));
        const row = { ...event, scope, sourceId: source?.id || nativeKey(scope, event.source), targetId: target?.id || nativeKey(scope, event.target) };
        // Each event is indexed on both endpoints. A peer may be absent from the current board filters.
        for (const id of [row.sourceId, row.targetId]) {
          if (!this.rows.has(id)) this.rows.set(id, []);
          this.rows.get(id).push(row);
        }
      }
    }
    for (const [id, rows] of this.rows) this.rows.set(id, [...new Map(rows.map(e => [e.id, e])).values()].sort(newer));
  }

  async read(session) {
    let st;
    try { st = await stat(session.sourcePath); } catch {
      this.files.set(session.id, { events: [], partial: false, error: true }); return;
    }
    const old = this.files.get(session.id);
    const sig = `${session.sourcePath}:${scopeOf(session)}:${st.dev}:${st.ino}`;
    if (old?.sig === sig && old.size === st.size && old.mtime === st.mtimeMs) return;
    const append = old?.sig === sig && st.size > old.size && st.size - old.offset <= FEED_MAX_DELTA;
    try {
      const tail = await readLines(session.sourcePath, append ? { start: old.offset } : { tailBytes: this.tailBytes });
      const rows = new Map((append && !tail.reset ? old.events : []).map(e => [e.id, e]));
      for (const event of parseExchangeRecords(tail.records, session)) rows.set(event.id, event);
      const all = mergeEvents([...rows.values()]).sort(newer);
      this.files.set(session.id, { sig, size: st.size, mtime: st.mtimeMs, offset: tail.offset,
        events: all.slice(0, this.maxEvents), partial: (append && !tail.reset ? old.partial : st.size > this.tailBytes) || all.length > this.maxEvents, error: false });
    } catch { this.files.set(session.id, { events: [], partial: false, error: true }); }
  }

  relation(from, peer) {
    if (!from || !peer || from.id === peer.id || scopeOf(from) !== scopeOf(peer)) return 'session';
    const ancestors = s => {
      const found = new Set();
      for (let current = s; current?.parentId && !found.has(current.parentId); current = this.sessions.get(current.parentId)) found.add(current.parentId);
      return found;
    };
    const theirs = ancestors(peer), mine = ancestors(from);
    if (theirs.has(from.id) || from.children?.includes(peer.id)) return 'subagent';
    if (mine.has(peer.id) || peer.children?.includes(from.id)) return 'parent';
    if ([...mine].some(id => theirs.has(id))) return 'collaborator';
    return 'session';
  }

  peer(from, id, nativeId) {
    const peer = this.sessions.get(id);
    return { id, title: peer?.title || nativeId, available: !!peer, relation: this.relation(from, peer), status: peer?.status || 'idle', statusKnown: peer?.statusKnown !== false && !!peer };
  }

  view(id, { includeAgents = true } = {}) {
    const session = this.sessions.get(id);
    const events = (this.rows.get(id) || []).map(e => {
      const outgoing = e.sourceId === id;
      return { id: e.id, at: e.at, text: e.text, direction: outgoing ? 'sent' : 'received',
        peer: this.peer(session, outgoing ? e.targetId : e.sourceId, outgoing ? e.target : e.source) };
    });
    const agents = (includeAgents ? [...this.sessions.values()] : []).filter(s => this.relation(session, s) !== 'session')
      .map(s => this.peer(session, s.id, s.nativeId));
    const unavailable = !session || session.host?.local === false || !!session.cloud;
    return { cardId: id, events, agents, partial: !!session && this.incomplete.has(scopeOf(session)), unavailable };
  }

  summary(id) {
    const view = this.view(id, { includeAgents: false });
    const peers = view.events.filter(e => e.peer.relation === 'session');
    return { sent: new Set(peers.filter(e => e.direction === 'sent').map(e => e.peer.id)).size,
      received: new Set(peers.filter(e => e.direction === 'received').map(e => e.peer.id)).size,
      peers: new Set(peers.map(e => e.peer.id)).size, total: peers.length,
      agentMessages: view.events.length - peers.length, partial: view.partial, available: !view.unavailable };
  }
}

export const exchangeIndex = new ExchangeIndex();

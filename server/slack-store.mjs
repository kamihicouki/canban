import { isMainThread, proxyStore } from './sqlite-client.mjs';
import { db, transaction, currentFence, readBoard } from './sqlite-backend.mjs';
import { SLACK_CACHE_MS, slackDigest, slackKey } from './slack-model.mjs';

const read = key => { const row = db().prepare('SELECT payload FROM auxiliary WHERE key=?').get(key); return row ? JSON.parse(row.payload) : null; };
const put = (key, value) => db().prepare('INSERT INTO auxiliary VALUES(?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload').run(key, JSON.stringify(value));
const remove = key => db().prepare('DELETE FROM auxiliary WHERE key=?').run(key);
const sourceKey = key => `slack:source:${key}`;
const revisionKey = (key, n) => `slack:revision:${key}:${n}`;
const cacheKey = (team, channel) => `slack:cache:${team}:${channel}`;
const messageKey = key => `slack:message:${key}`;
const newest = (a,b) => Number(b.split(':').at(-1)) - Number(a.split(':').at(-1));
function clearCache(team, channel) { const key = cacheKey(team,channel), cache = read(key); for (const id of cache?.keys || []) remove(messageKey(id)); remove(key); }
const config = () => read('slack:config') || { workspaces: [] };
export const slackRefsFor = (state, key) => Object.entries(state.cards || {}).filter(([, card]) => card.slackRefs?.includes(key)).map(([id, card]) => ({ id, title: card.title || card.slackTitle || id, kind: card.kind || 'session' }));
function refIndex(state) {
  const index = new Map();
  for (const [id, card] of Object.entries(state.cards || {})) for (const key of card.slackRefs || []) {
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({ id, title: card.title || card.slackTitle || id, kind: card.kind || 'session' });
  }
  return index;
}
// Events and history may arrive out of order. A known deletion never resurrects.
function mergeMessage(previous, message, eventAt) {
  const { versions, ...incoming } = message; // Source version counters never come from a cache or Slack.
  message = incoming;
  if (!previous) return { ...message, eventAt };
  if (previous.deleted || (eventAt && previous.eventAt && Number(eventAt) <= Number(previous.eventAt))) return previous;
  if (!message.deleted && previous.editedAt && (!message.editedAt || Number(message.editedAt) < Number(previous.editedAt))) return previous;
  return { ...previous, ...message, ...(message.deleted ? { text: previous.text, files: previous.files } : {}), eventAt: eventAt || previous.eventAt || null };
}
function saveRevision(source, reason) {
  const version = (source.versions || 0) + 1;
  const head = { ...source, versions: version };
  put(revisionKey(source.key, version), { ...head, reason });
  put(sourceKey(source.key), head);
  return head;
}

// Task and its first source commit together in the board transaction.
export function attachSlackReference(state, cardId, key) {
  const [team, channel, ts] = String(key).split(':');
  if (slackKey(team, channel, ts) !== key) throw new Error('Slack資料を確認してください');
  let source = read(sourceKey(key));
  const cache = read(cacheKey(team, channel));
  const message = cache?.at > Date.now() - SLACK_CACHE_MS && cache.keys.includes(key) && read(messageKey(key));
  if (!source && !message) throw new Error('Slackメッセージを再取得してから取り込んでください');
  if (!source) source = saveRevision(message, '取り込み');
  else if (message) {
    const next = mergeMessage(source, message);
    if (slackDigest(next) !== slackDigest(source)) source = saveRevision(next, '再取り込み');
  }
  const card = state.cards[cardId] ||= {};
  card.slackRefs = [...new Set([...(card.slackRefs || []), key])];
  return source;
}

export class SlackStore {
  constructor(dir) { this.dir = dir; if (isMainThread) return proxyStore(this, 'slack'); }
  getConfig() { return config(); }
  saveWorkspace(workspace) {
    return transaction(() => { const value = config(); const old = value.workspaces.find(w => w.id === workspace.id);
      value.workspaces = [...value.workspaces.filter(w => w.id !== workspace.id), { ...workspace, channels: old?.channels || [] }];
      put('slack:config', value); return value;
    }, { fence: currentFence });
  }
  removeWorkspace(id) { return transaction(() => { const value = config(); for (const channel of value.workspaces.find(w => w.id === id)?.channels || []) clearCache(id,channel.id); value.workspaces = value.workspaces.filter(w => w.id !== id); put('slack:config', value); remove(`slack:status:${id}`); return value; }, { fence: currentFence }); }
  selectChannels({ workspaceId, channels }) {
    if (!Array.isArray(channels) || channels.length > 100) throw new Error('読む会話は100件まで選べます');
    return transaction(() => {
      const value = config(), workspace = value.workspaces.find(w => w.id === workspaceId), board = readBoard();
      if (!workspace) throw new Error('Slack接続が見つかりません');
      const oldChannels = workspace.channels;
      workspace.channels = [...new Map(channels.map(channel => {
        if (!/^[A-Z0-9]+$/.test(channel.id || '') || typeof channel.name !== 'string') throw new Error('Slackの会話を確認してください');
        if (channel.directory && channel.directory !== '__none' && !board.directories.some(d => d.id === channel.directory)) throw new Error('カテゴリが見つかりません');
        return [channel.id, { id: channel.id, name: channel.name.slice(0, 200), directory: channel.directory || '__none' }];
      })).values()];
      for (const channel of oldChannels) if (!workspace.channels.some(c => c.id === channel.id)) clearCache(workspaceId,channel.id);
      put('slack:config', value); return value;
    }, { fence: currentFence });
  }
  connectionStatus(team) { return read(`slack:status:${team}`); }
  status(team, value) { return transaction(() => { put(`slack:status:${team}`, value); }, { fence: currentFence }); }
  view({ workspaceId, channelId } = {}) {
    const value = config(), refs = refIndex(readBoard()), cursors = {};
    const keys = value.workspaces.flatMap(w => w.channels.flatMap(c => {
      if ((workspaceId && w.id !== workspaceId) || (channelId && c.id !== channelId)) return [];
      const cache = read(cacheKey(w.id, c.id)); cursors[`${w.id}:${c.id}`] = cache?.cursor || '';
      return cache?.at > Date.now() - SLACK_CACHE_MS ? cache.keys : [];
    })).sort(newest).slice(0,500);
    const messages = keys.map(key => read(messageKey(key))).filter(m => m && (m.threadTs === m.ts || m.broadcast)).map(m => ({ ...m, refs: refs.get(m.key) || [] }));
    return { ...value, cursors, status: Object.fromEntries(value.workspaces.map(w => [w.id, read(`slack:status:${w.id}`)])), messages };
  }
  cache({ team, channel, messages, cursor = '', append = false, thread = false }) {
    return transaction(() => {
      const old = read(cacheKey(team, channel));
      const incoming = [...new Set(messages.map(m => m.key))];
      const keys = [...incoming, ...(old?.keys || []).filter(key => !incoming.includes(key))].slice(0,500).sort(newest);
      const refs = refIndex(readBoard());
      for (const message of messages) {
        const previous = read(messageKey(message.key)) || read(sourceKey(message.key));
        put(messageKey(message.key), mergeMessage(previous, message)); this.observeInner(message, '再取得', null, refs);
      }
      for (const key of old?.keys || []) if (!keys.includes(key)) remove(messageKey(key));
      const value = { at: thread ? old?.at || Date.now() : Date.now(), cursor: thread ? old?.cursor || '' : cursor, keys };
      put(cacheKey(team, channel), value); return value;
    }, { fence: currentFence });
  }
  refs(keys) { const refs = refIndex(readBoard()); return Object.fromEntries(keys.map(key => [key, refs.get(key) || []])); }
  cachedMeta(team, channel) { return read(cacheKey(team,channel)); }
  cached(team, channel) { const cache = read(cacheKey(team,channel)); return cache ? { ...cache, messages: cache.keys.map(key => read(messageKey(key))).filter(Boolean) } : null; }
  observeInner(message, reason, eventAt = null, refs = refIndex(readBoard())) {
    const previous = read(sourceKey(message.key));
    if (!previous || !refs.has(message.key)) return;
    const next = mergeMessage(previous, message, eventAt);
    if (next === previous) return;
    if (slackDigest(previous) === slackDigest(next)) { if (next.eventAt !== previous.eventAt) put(sourceKey(message.key), next); return; }
    saveRevision({ ...next, observedAt: Date.now() }, reason);
  }
  observe({ message, reason = '編集', eventAt = null }) {
    return transaction(() => {
      this.observeInner(message, reason, eventAt);
      const key = cacheKey(message.team, message.channel), cache = read(key);
      if (cache) {
        const previous = read(messageKey(message.key));
        if (previous || !message.deleted) {
          const next = mergeMessage(previous, message, eventAt);
          if (next !== previous) put(messageKey(message.key), next);
          if (!cache.keys.includes(message.key)) {
            cache.keys.unshift(message.key); cache.keys.sort(newest);
            for (const key of cache.keys.splice(500)) remove(messageKey(key));
            put(key, cache);
          }
        }
      }
    }, { fence: currentFence });
  }
  sources(cardId) { const card = readBoard().cards[cardId]; return (card?.slackRefs || []).map(key => read(sourceKey(key))).filter(Boolean); }
  revisions({ key, before = null }) {
    const source = read(sourceKey(key)); if (!source) return { revisions: [], before: null };
    const top = Math.min(source.versions, Number(before) || source.versions + 1) - (before ? 1 : 0);
    const revisions = []; for (let n = top; n > Math.max(0, top - 25); n--) { const revision = read(revisionKey(key,n)); if (revision) revisions.push(revision); }
    return { revisions, before: top > 25 ? top - 24 : null };
  }
  tracked(key) { if (!slackRefsFor(readBoard(),key).length) return null; return read(sourceKey(key)); }
  retained() { const refs = refIndex(readBoard()); return db().prepare("SELECT payload FROM auxiliary WHERE key LIKE 'slack:source:%'").all().map(row => JSON.parse(row.payload)).map(source => ({ ...source, refs: refs.get(source.key) || [] })); }
  forget(key) {
    return transaction(() => {
      if (slackRefsFor(readBoard(), key).length) throw new Error('カードの紐づけを外してから履歴を削除してください');
      const source = read(sourceKey(key)); for (let n = 1; n <= (source?.versions || 0); n++) remove(revisionKey(key,n));
      remove(sourceKey(key)); return { deleted: key };
    }, { fence: currentFence });
  }
}

// Who has a board open: every server whose board is live keeps a heartbeat entry in
// SQLite presence table ({ app, cardId, cardIds, at } per process), so a board in Codex can
// show that Claude Desktop has it (or cards) open, and the other way round.
// cardIds lists every card open in a detail pane; cardId is the first one (older boards read that).
// Canban's own file; entries expire when their board stops polling.
import crypto from 'node:crypto';
import { database } from './sqlite-client.mjs';

export const PRESENCE_TTL_MS = 90e3;
const BEAT_MS = 30e3;

export function appLabel(client) {
  const n = String(client?.name || '').toLowerCase();
  if (n.includes('codex')) return 'Codex';
  if (n.includes('claude')) return 'Claude デスクトップ';
  if (n.includes('chrome')) return 'Chrome';
  return client?.name ? String(client.name).slice(0, 40) : 'ボード';
}

export class Presence {
  constructor(dir, { self = crypto.randomUUID(), app = () => 'ボード', ttlMs = PRESENCE_TTL_MS, beatMs = BEAT_MS } = {}) {
    this.database = database(dir);
    this.self = self;
    this.app = app;
    this.ttlMs = ttlMs;
    this.beatMs = beatMs;
    this.last = null; // { cardId, at } last written
  }

  async read(now = Date.now()) {
    return Object.fromEntries((await this.database.call('system','presenceRead',[now-this.ttlMs])).filter(([,v]) => now - Number(v.at) < this.ttlMs));
  }

  // This board is live (and looking at `cardId`, or a list of cards): refresh its entry when that changed or it is due.
  async beat(cardId = null, now = Date.now()) {
    const ids = [].concat(cardId || []).filter((x) => typeof x === 'string');
    const key = ids.join('\0');
    if (this.last && this.last.key === key && now - this.last.at < this.beatMs) return false;
    await this.database.call('system','presencePut',[this.self,{ app: this.app(),cardId:ids[0] ?? null,cardIds:ids,at:now }]);
    this.last = { key, at: now };
    return true;
  }

  async leave() {
    if (!this.last) return;
    await this.database.call('system','presenceDelete',[this.self]);
    this.last = null;
  }

  // Other live boards: [{ app, cardId }] (one row per open card), sorted so the result compares by value.
  async others(now = Date.now()) {
    const rows = [];
    for (const [k, v] of Object.entries(await this.read(now))) {
      if (k === this.self) continue;
      const app = String(v.app || 'ボード');
      const ids = Array.isArray(v.cardIds) ? v.cardIds.filter((x) => typeof x === 'string') : typeof v.cardId === 'string' ? [v.cardId] : [];
      if (!ids.length) rows.push({ app, cardId: null });
      else for (const cardId of ids) rows.push({ app, cardId });
    }
    return rows.sort((a, b) => `${a.app}\0${a.cardId}`.localeCompare(`${b.app}\0${b.cardId}`));
  }
}

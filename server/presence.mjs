// Who has a board open: every server whose board is live keeps a heartbeat entry in
// <dataDir>/presence.json ({ app, cardId, at } per process), so a board in Codex can
// show that Claude Desktop has it (or a card) open, and the other way round.
// Canban's own file; entries expire when their board stops polling.
import fs from 'node:fs';
import path from 'node:path';

export const PRESENCE_TTL_MS = 90e3;
const BEAT_MS = 30e3;

export function appLabel(client) {
  const n = String(client?.name || '').toLowerCase();
  if (n.includes('codex')) return 'Codex';
  if (n.includes('claude')) return 'Claude デスクトップ';
  return client?.name ? String(client.name).slice(0, 40) : 'ボード';
}

export class Presence {
  constructor(dir, { self = String(process.pid), app = () => 'ボード', ttlMs = PRESENCE_TTL_MS, beatMs = BEAT_MS } = {}) {
    this.file = path.join(dir, 'presence.json');
    this.self = self;
    this.app = app;
    this.ttlMs = ttlMs;
    this.beatMs = beatMs;
    this.last = null; // { cardId, at } last written
  }

  read(now = Date.now()) {
    let j = {};
    try {
      j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {}
    const out = {};
    for (const [k, v] of Object.entries(j && typeof j === 'object' ? j : {})) if (v && now - Number(v.at) < this.ttlMs) out[k] = v;
    return out;
  }

  write(entries) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entries));
      fs.renameSync(tmp, this.file);
    } catch {}
  }

  // This board is live (and looking at `cardId`): refresh its entry when that changed or it is due.
  beat(cardId = null, now = Date.now()) {
    if (this.last && this.last.cardId === cardId && now - this.last.at < this.beatMs) return false;
    const all = this.read(now);
    all[this.self] = { app: this.app(), cardId, at: now };
    this.write(all);
    this.last = { cardId, at: now };
    return true;
  }

  leave() {
    if (!this.last) return;
    const all = this.read();
    delete all[this.self];
    this.write(all);
    this.last = null;
  }

  // Other live boards: [{ app, cardId }], sorted so the result compares by value.
  others(now = Date.now()) {
    return Object.entries(this.read(now))
      .filter(([k]) => k !== this.self)
      .map(([, v]) => ({ app: String(v.app || 'ボード'), cardId: typeof v.cardId === 'string' ? v.cardId : null }))
      .sort((a, b) => `${a.app}\0${a.cardId}`.localeCompare(`${b.app}\0${b.cardId}`));
  }
}

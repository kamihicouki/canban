// Full-text search over session conversations (user + agent messages).
// The index lives in Canban's own data dir (<dataDir>/search.sqlite, SQLite FTS5 with
// the trigram tokenizer so Japanese substrings match). Agent logs are only read.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { stat, readTailJsonLines } from './sources/readonly.mjs';
import { codexMessagesFromRecords } from './sources/codex.mjs';
import { claudeMessagesFromRecords } from './sources/claude.mjs';

const WINDOW_MS = 90 * 86400e3; // index sessions active in the last 90 days
const BATCH = 200; // sessions (re)indexed per step
const READ_BYTES = 4 * 1024 * 1024; // conversation tail read per session
const MAX_CHARS = 400_000;

export class SearchIndex {
  constructor(dir) {
    this.file = path.join(dir, 'search.sqlite');
    this.dir = dir;
    this.db = null;
    this.running = null;
    this.progress = { indexed: 0, total: 0, updatedAt: null };
  }

  open() {
    if (this.db) return this.db;
    fs.mkdirSync(this.dir, { recursive: true });
    const db = new DatabaseSync(this.file);
    db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS files (session_id TEXT PRIMARY KEY, path TEXT, mtime REAL, size INTEGER);
      CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(session_id UNINDEXED, title, body, tokenize = 'trigram');`);
    this.db = db;
    return db;
  }

  // Index up to BATCH local sessions that are new or changed, newest first.
  step(sessions, now = Date.now()) {
    if (this.running) return this.running;
    this.running = (async () => {
      const db = this.open();
      const local = sessions
        .filter((s) => (!s.host || s.host.local !== false) && s.sourcePath && (s.updatedAt || 0) >= now - WINDOW_MS)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      const known = new Map(db.prepare('SELECT session_id, mtime, size FROM files').all().map((r) => [r.session_id, r]));
      let done = 0;
      let fresh = 0;
      for (const s of local) {
        const st = await stat(s.sourcePath);
        if (!st) continue;
        const k = known.get(s.id);
        if (k && k.mtime === st.mtimeMs && k.size === st.size) {
          fresh++;
          continue;
        }
        if (done >= BATCH) continue;
        const records = await readTailJsonLines(s.sourcePath, READ_BYTES);
        const msgs = s.agent === 'codex' ? codexMessagesFromRecords(records, 5000) : claudeMessagesFromRecords(records, 5000);
        const body = msgs.map((m) => m.text).join('\n').slice(-MAX_CHARS);
        db.exec('BEGIN');
        try {
          db.prepare('DELETE FROM docs WHERE session_id = ?').run(s.id);
          db.prepare('INSERT INTO docs (session_id, title, body) VALUES (?, ?, ?)').run(s.id, s.title || '', `${s.preview || ''}\n${body}`);
          db.prepare('INSERT OR REPLACE INTO files (session_id, path, mtime, size) VALUES (?, ?, ?, ?)').run(s.id, s.sourcePath, st.mtimeMs, st.size);
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
        done++;
        fresh++;
      }
      this.progress = { indexed: fresh, total: local.length, updatedAt: now };
      return this.progress;
    })().finally(() => (this.running = null));
    return this.running;
  }

  // Session ids (with a snippet) whose conversation contains `q` (3+ characters).
  query(q, limit = 300) {
    const text = String(q || '').trim();
    if ([...text].length < 3 || !fs.existsSync(this.file)) return [];
    const db = this.open();
    const phrase = `"${text.replace(/"/g, '""')}"`;
    try {
      return db
        .prepare(`SELECT session_id AS id, snippet(docs, 2, '[', ']', '…', 12) AS snippet FROM docs WHERE docs MATCH ? LIMIT ?`)
        .all(phrase, limit);
    } catch {
      return [];
    }
  }
}

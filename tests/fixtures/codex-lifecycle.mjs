#!/usr/bin/env node
// Disposable fixture app-server. Mirrors the vendor lifecycle persistence boundary.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
const home = process.env.CODEX_HOME;
if (!home || !fs.existsSync(path.join(home, '.canban-lifecycle-fixture'))) process.exit(2);
const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); if (!m.id) return;
  try {
    if (m.method !== 'initialize') {
      const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(m.params.threadId);
      if (!row) throw Error('missing fixture thread');
      if (m.method === 'thread/delete') {
        db.prepare('DELETE FROM threads WHERE id = ?').run(m.params.threadId);
        fs.rmSync(row.rollout_path, { force: true });
      } else if (['thread/archive', 'thread/unarchive'].includes(m.method)) {
        db.prepare('UPDATE threads SET archived = ? WHERE id = ?').run(m.method === 'thread/archive' ? 1 : 0, m.params.threadId);
      } else throw Error('unexpected method');
    }
    process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ id: m.id, error: { message: error.message } }) + '\n'); }
});

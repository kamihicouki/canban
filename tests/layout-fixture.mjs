// Synthetic active session for layout/HUD regression; no real accounts or transcripts.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeFixtures } from './helpers.mjs';

export function makeLayoutFixtures() {
  const fx = makeFixtures();
  const now = Date.now();
  const db = new DatabaseSync(path.join(fx.codexHome, 'state_5.sqlite'));
  db.prepare('UPDATE threads SET updated_at=?,updated_at_ms=? WHERE id=?').run(Math.floor(now / 1000), now, 't1');
  db.close();
  fs.appendFileSync(fx.rollout, JSON.stringify({ timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type: 'task_started' } }) + '\n');
  return fx;
}

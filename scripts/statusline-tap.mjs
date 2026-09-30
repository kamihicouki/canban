#!/usr/bin/env node
// Claude Code statusLine for folders made by Canban's account runner (server/runner.mjs).
// Claude passes the session state as JSON on stdin; for subscribers it includes
// rate_limits.five_hour / seven_day ({ used_percentage, resets_at }). The tap records
// those in <usage dir>/home-<id>.json, then runs the folder's original statusLine
// command with the same input, so the status line looks as it did.
// Usage: statusline-tap.mjs <usage dir> <home id>
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [usage, homeId] = process.argv.slice(2);
const input = fs.readFileSync(0);

try {
  const r = JSON.parse(input.toString('utf8'))?.rate_limits;
  const win = (w) => (w && typeof w.used_percentage === 'number' ? { used_percentage: w.used_percentage, resets_at: Number(w.resets_at) || null } : null);
  if (r && /^[a-z0-9-]+$/.test(homeId || '') && usage) {
    const rec = { at: Date.now(), five_hour: win(r.five_hour), seven_day: win(r.seven_day) };
    if (rec.five_hour || rec.seven_day) {
      fs.mkdirSync(usage, { recursive: true });
      const file = path.join(usage, `home-${homeId}.json`);
      fs.writeFileSync(`${file}.${process.pid}`, JSON.stringify(rec));
      fs.renameSync(`${file}.${process.pid}`, file);
    }
  }
} catch {}

let original = null;
try {
  original = JSON.parse(fs.readFileSync(path.join(path.dirname(usage), 'accounts', homeId, '.canban-home.json'), 'utf8')).statusLine;
} catch {}
if (typeof original === 'string' && original.trim()) {
  const r = spawnSync('/bin/sh', ['-c', original], { input, stdio: ['pipe', 'inherit', 'inherit'], timeout: 10e3 });
  process.exitCode = r.status ?? 0;
}

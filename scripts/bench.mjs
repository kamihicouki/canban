#!/usr/bin/env node
// Performance check against your real agent data (read-only). Canban's own data is
// copied to a temp dir, so the configured Canban data directory is unchanged.
//   npm run bench                       local sessions
//   npm run bench -- --remote           also enabled SSH hosts
//   npm run bench -- --save a.json      write results; --compare a.json shows the diff
//   npm run bench -- --procs 10         start N servers and watch CPU / leadership for 60 s
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDataDirectory } from '../server/data-directory.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);

const realData = resolveDataDirectory();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-bench-'));
try {
  const board = JSON.parse(fs.readFileSync(path.join(realData, 'board.json'), 'utf8'));
  if (!flag('--remote')) board.remoteHosts = {};
  fs.writeFileSync(path.join(tmp, 'board.json'), JSON.stringify(board));
} catch {}
process.env.CANBAN_DATA_DIR = tmp;
process.env.CANBAN_BACKGROUND = '0';

const procs = Number(opt('--procs')) || 0;
if (procs) await watchProcs(procs);
else await benchOps();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);

async function benchOps() {
  const { perf } = await import('../server/perf.mjs');
  const { Store } = await import('../server/store.mjs');
  const board = await import('../server/board.mjs');
  const store = new Store(tmp);
  const rows = [];
  const run = async (label, fn) => {
    const t = performance.now();
    const r = await fn();
    rows.push({ op: label, ms: Math.round(performance.now() - t) });
    return r;
  };
  perf.startLoopMonitor();
  await run('allSessions (cold)', () => board.allSessions(store.load()));
  await new Promise((r) => setTimeout(r, 4200)); // past the local cache TTL
  const { sessions } = await run('allSessions (warm, cache expired)', () => board.allSessions(store.load()));
  await run('allSessions (warm, cached)', () => board.allSessions(store.load()));
  await run('buildBoard (warm)', () => board.buildBoard(store, { days: 30 }));
  await new Promise((r) => setTimeout(r, 4200));
  await run('buildBoard (cache expired)', () => board.buildBoard(store, { days: 30 }));
  const recent = [...sessions].filter((s) => !s.subagent).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  if (recent) await run('sessionDetail (latest)', () => board.sessionDetail(store, recent.id));
  const dispatch = await import('../server/dispatch.mjs').catch(() => null);
  if (dispatch?.tickDispatch) await run('tick.dispatch (no requests)', () => dispatch.tickDispatch(store));

  const summary = perf.summary();
  const result = {
    at: new Date().toISOString(),
    sessions: sessions.length,
    rows,
    ops: summary.ops,
    loop: summary.loop,
    rssMB: summary.rssMB,
  };
  printResult(result, opt('--compare') ? JSON.parse(fs.readFileSync(opt('--compare'), 'utf8')) : null);
  if (opt('--save')) fs.writeFileSync(opt('--save'), JSON.stringify(result, null, 2));
}

function printResult(r, prev) {
  const prevRow = new Map((prev?.rows || []).map((x) => [x.op, x.ms]));
  console.log(`sessions: ${r.sessions}   rss: ${r.rssMB}MB   event loop p99/max: ${r.loop?.p99}/${r.loop?.max}ms`);
  console.log('\nscenario'.padEnd(40) + 'ms'.padStart(8) + (prev ? 'prev'.padStart(8) : ''));
  for (const x of r.rows) console.log(x.op.padEnd(39) + String(x.ms).padStart(8) + (prev ? String(prevRow.get(x.op) ?? '-').padStart(8) : ''));
  console.log('\noperation'.padEnd(26) + 'count'.padStart(6) + 'p50'.padStart(7) + 'p95'.padStart(7) + 'max'.padStart(7) + 'budget'.padStart(8));
  for (const [name, o] of Object.entries(r.ops)) {
    const over = o.budget != null && o.p95 > o.budget ? '  ⚠ over' : '';
    console.log(name.padEnd(25) + String(o.count).padStart(6) + String(o.p50).padStart(7) + String(o.p95).padStart(7) + String(o.max).padStart(7) + String(o.budget ?? '-').padStart(8) + over);
  }
}

// Start N servers on the same data dir (as Codex does, one per thread) and sample
// their CPU; exactly one should be the background leader.
async function watchProcs(n) {
  delete process.env.CANBAN_BACKGROUND;
  const children = [];
  for (let i = 0; i < n; i++) {
    const c = spawn('/bin/sh', [path.join(root, 'scripts', 'launch.sh')], { env: { ...process.env, CANBAN_DATA_DIR: tmp }, stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => (err += d));
    c.logs = () => err;
    children.push(c);
  }
  const pids = () => children.map((c) => c.pid).join(',');
  const samples = [];
  for (let t = 0; t < 12; t++) {
    await new Promise((r) => setTimeout(r, 5000));
    const out = execFileSync('ps', ['-o', 'pcpu=,rss=', '-p', pids()], { encoding: 'utf8' }).trim().split('\n');
    const cpu = out.reduce((s, l) => s + Number(l.trim().split(/\s+/)[0] || 0), 0);
    const rss = out.reduce((s, l) => s + Number(l.trim().split(/\s+/)[1] || 0), 0) / 1024;
    samples.push({ cpu, rss });
    console.log(`t=${(t + 1) * 5}s  total CPU ${cpu.toFixed(1)}%  total RSS ${rss.toFixed(0)}MB`);
  }
  const leaders = children.filter((c) => /background leader/.test(c.logs())).length;
  console.log(`\nleaders: ${leaders} (expected 1)   mean CPU ${(samples.reduce((s, x) => s + x.cpu, 0) / samples.length).toFixed(1)}%`);
  for (const c of children) c.kill();
}

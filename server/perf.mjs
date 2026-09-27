// Keeps an eye on how heavy Canban is: timings of the main operations against a
// budget, event-loop delay and memory. Over-budget runs are logged (rate-limited)
// and surfaced on the board. Budgets are documented in docs/performance.md.
import { monitorEventLoopDelay } from 'node:perf_hooks';

export const BUDGETS = {
  buildBoard: 300,
  sessionDetail: 300,
  'sessions.all': 300,
  'codex.list': 50, // includes delta reads while Codex is writing
  'claude.list': 100,
  'remote.list': 50,
  status: 100,
  'tick.rules': 1000,
  'tick.search': 3000,
  'tick.dispatch': 100,
  'dispatch.inspect': 100,
};
const RING = 200;
const WARN_EVERY_MS = 60e3;
const SLOW_KEEP_MS = 10 * 60e3;

class Perf {
  constructor() {
    this.ops = new Map(); // name -> { samples: number[], count, max, last }
    this.slow = []; // { name, ms, budget, at }
    this.warnedAt = new Map();
    this.loop = null;
    this.log = (line) => process.stderr.write(`[canban] ${line}\n`);
  }

  startLoopMonitor() {
    if (this.loop) return;
    this.loop = monitorEventLoopDelay({ resolution: 20 });
    this.loop.enable();
  }

  record(name, ms, now = Date.now()) {
    const op = this.ops.get(name) || { samples: [], count: 0, max: 0, last: 0 };
    op.samples.push(ms);
    if (op.samples.length > RING) op.samples.shift();
    op.count++;
    op.max = Math.max(op.max, ms);
    op.last = ms;
    this.ops.set(name, op);
    const budget = BUDGETS[name];
    if (budget != null && ms > budget) {
      this.slow.push({ name, ms: Math.round(ms), budget, at: now });
      this.slow = this.slow.filter((s) => now - s.at < SLOW_KEEP_MS).slice(-20);
      if (now - (this.warnedAt.get(name) || 0) > WARN_EVERY_MS) {
        this.warnedAt.set(name, now);
        this.log(`slow: ${name} ${Math.round(ms)}ms > ${budget}ms`);
      }
    }
  }

  async timed(name, fn) {
    const t = performance.now();
    try {
      return await fn();
    } finally {
      this.record(name, performance.now() - t);
    }
  }

  // Recent over-budget runs, for the board footer.
  recentSlow(now = Date.now()) {
    return this.slow.filter((s) => now - s.at < SLOW_KEEP_MS);
  }

  summary(extra = {}) {
    const ops = {};
    for (const [name, op] of this.ops) {
      const sorted = [...op.samples].sort((a, b) => a - b);
      const q = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] || 0);
      ops[name] = { count: op.count, p50: q(0.5), p95: q(0.95), max: Math.round(op.max), last: Math.round(op.last), budget: BUDGETS[name] ?? null };
    }
    const loop = this.loop
      ? { p99: Math.round(this.loop.percentile(99) / 1e6), max: Math.round(this.loop.max / 1e6) }
      : null;
    return { pid: process.pid, rssMB: Math.round(process.memoryUsage().rss / 1e6), loop, ops, slow: this.recentSlow(), ...extra };
  }

  reset() {
    this.ops.clear();
    this.slow = [];
    this.warnedAt.clear();
    this.loop?.reset();
  }
}

export const perf = new Perf();

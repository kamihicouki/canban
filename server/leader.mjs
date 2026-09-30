// SQLite election: every background mode respects the same process-wide lease.
import crypto from 'node:crypto';
import { database, executionContext } from './sqlite-client.mjs';
export class Leader {
  constructor(dir, { mode = 'auto', heartbeatMs = 30000, onChange = () => {} } = {}) {
    this.database = database(dir); this.mode = mode; this.heartbeatMs = heartbeatMs; this.onChange = onChange;
    this.uuid = crypto.randomUUID(); this.isLeader = false; this.token = null; this.timer = null;
  }
  async owner() { return (await this.database.call('system','lease',['background']))?.pid ?? null; }
  async check(now = Date.now()) {
    const before = this.isLeader;
    const token = this.mode === 'never' ? null : await this.database.call('system','acquire',[{ key:'background',owner:this.uuid,pid:process.pid,now }]);
    this.token = token; this.isLeader = !!token;
    if (before !== this.isLeader) this.onChange(this.isLeader);
    return this.isLeader;
  }
  tryAcquire(now) { return this.check(now); }
  async start() {
    await this.check();
    this.timer = setInterval(() => this.check().catch(() => { this.isLeader = false; this.onChange(false); }),this.heartbeatMs);
    this.timer.unref(); return this;
  }
  async run(fn) {
    if (!await this.check()) return;
    return executionContext.run(this.token,fn);
  }
  async release() {
    clearInterval(this.timer);
    if (this.token) await this.database.call('system','release',[this.token]);
    this.token = null; this.isLeader = false;
  }
}

const leaders = new Map();
export function leaderFor(dir, options) {
  if (!leaders.has(dir)) leaders.set(dir, new Leader(dir, options || { mode: process.env.CANBAN_BACKGROUND === '0' ? 'never' : 'auto' }));
  return leaders.get(dir);
}

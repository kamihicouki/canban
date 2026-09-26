// Reads sessions from remote machines over SSH by piping collect.py into `python3 -`.
// Results are cached per host; a stale result is served immediately while a refresh
// runs in the background, so a slow or unreachable host never blocks the board.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeCodexRow, codexMessagesFromRecords } from '../sources/codex.mjs';
import { normalizeClaudeSummary, claudeMessagesFromRecords } from '../sources/claude.mjs';

const SCRIPT = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'collect.py'), 'utf8');

export function hostRef(h) {
  return { id: h.id, alias: h.alias, label: h.label, local: false };
}

export class RemotePool {
  constructor({ ssh = process.env.CANBAN_SSH || 'ssh', ttlMs = 60000, timeoutMs = 20000, extraArgs = {} } = {}) {
    this.ssh = ssh;
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
    this.extraArgs = extraArgs; // merged into ARGS (tests point the collector at fixtures)
    this.cache = new Map(); // hostId -> { sessions, summaries: Map(file -> summary), fetchedAt, errors }
    this.status = new Map(); // hostId -> { state, error, fetchedAt, count }
    this.inflight = new Map();
  }

  run(host, args) {
    return new Promise((resolve) => {
      const sshArgs = [...(host.sshArgs || []), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-T', '--', host.alias, 'python3', '-'];
      const child = spawn(this.ssh, sshArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        done({ ok: false, error: `タイムアウト（${Math.round(this.timeoutMs / 1000)} 秒）` });
      }, this.timeoutMs);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => done({ ok: false, error: e.message }));
      child.on('close', (code) => {
        if (!out.trim()) {
          const msg = err.trim().split('\n').filter(Boolean).pop() || `ssh が終了しました（コード ${code}）`;
          return done({ ok: false, error: /python3: (command )?not found/.test(err) ? 'リモートに python3 がありません' : msg });
        }
        try {
          done(JSON.parse(out));
        } catch {
          done({ ok: false, error: '応答を解析できませんでした' });
        }
      });
      child.stdin.on('error', () => {});
      // Embed ARGS as a JSON string literal (valid in Python) and parse it there: raw JSON
      // is not Python (true/false/null).
      child.stdin.end(`ARGS = __import__('json').loads(${JSON.stringify(JSON.stringify({ ...this.extraArgs, ...args }))})\n${SCRIPT}`);
    });
  }

  async refresh(host) {
    if (this.inflight.has(host.id)) return this.inflight.get(host.id);
    const prev = this.cache.get(host.id);
    this.status.set(host.id, { ...(this.status.get(host.id) || {}), state: 'connecting' });
    const p = (async () => {
      const known = {};
      for (const [file, s] of prev?.summaries || []) known[file] = s.sig;
      const res = await this.run(host, { mode: 'list', known });
      if (!res.ok) {
        this.status.set(host.id, { state: 'error', error: res.error, fetchedAt: prev?.fetchedAt ?? null, count: prev?.sessions.length ?? 0 });
        return;
      }
      const ref = hostRef(host);
      const summaries = new Map();
      for (const file of res.claude?.unchanged || []) {
        const s = prev?.summaries.get(file);
        if (s) summaries.set(file, s);
      }
      for (const s of res.claude?.summaries || []) summaries.set(s.file, s);
      const desktop = res.claude?.desktop || {};
      const sessions = [
        ...(res.codex?.rows || []).map((r) => normalizeCodexRow(r, ref)),
        ...[...summaries.values()].map((s) => normalizeClaudeSummary(s, desktop[s.sessionId], ref)).filter(Boolean),
      ];
      const errors = [res.codex?.error, res.claude?.error].filter(Boolean);
      this.cache.set(host.id, { sessions, summaries, fetchedAt: Date.now(), errors });
      this.status.set(host.id, { state: errors.length ? 'error' : 'ok', error: errors.join(' / ') || null, fetchedAt: Date.now(), count: sessions.length });
    })().finally(() => this.inflight.delete(host.id));
    this.inflight.set(host.id, p);
    return p;
  }

  // Sessions from every given host. Hosts with no data yet are awaited (bounded by
  // the ssh timeout); hosts with cached data return it and refresh in the background.
  async sessions(hosts, { force = false } = {}) {
    const waits = [];
    for (const h of hosts) {
      const c = this.cache.get(h.id);
      const stale = !c || force || Date.now() - c.fetchedAt > this.ttlMs;
      if (!stale) continue;
      const p = this.refresh(h);
      if (!c || force) waits.push(p);
    }
    await Promise.all(waits);
    return hosts.flatMap((h) => this.cache.get(h.id)?.sessions || []);
  }

  hostStatus(hostId) {
    return this.status.get(hostId) || { state: 'idle', error: null, fetchedAt: null, count: 0 };
  }

  async messages(host, session, limit = 12) {
    if (!session.sourcePath) return [];
    const res = await this.run(host, { mode: 'messages', agent: session.agent, path: session.sourcePath });
    if (!res.ok) throw new Error(`${host.label}: ${res.error}`);
    return session.agent === 'codex' ? codexMessagesFromRecords(res.records, limit) : claudeMessagesFromRecords(res.records, limit);
  }
}

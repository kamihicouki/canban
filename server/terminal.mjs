// The card's terminal: a login shell on a pseudo terminal at the session's project root (its git top level, else
// its folder), kept per card while this Canban process lives. The UI only reaches it through tool calls, so the
// output is a buffer the board long-polls by offset, and the input is short writes. Local sessions only.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { cleanEnv } from './dispatch.mjs';

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'terminal-pty.py');
const KEEP_CHARS = 512 * 1024; // the scrollback a reopened card replays
const MAX_TERMINALS = 8;
const READ_WAIT_MAX = 25000;

export function projectRoot(cwd) {
  return new Promise((resolve) => {
    if (!cwd || !fs.existsSync(cwd)) { resolve(null); return; }
    execFile('git', ['--no-optional-locks', '-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 3000 },
      (err, out) => resolve(!err && String(out).trim() ? String(out).trim() : cwd));
  });
}

const clampSize = (n, def) => (Number.isFinite(n) ? Math.min(500, Math.max(2, Math.round(n))) : def);

export class Terminals {
  constructor({ spawner = spawn, python = 'python3', shell = process.env.SHELL || '/bin/zsh' } = {}) {
    this.spawner = spawner;
    this.python = python;
    this.shell = shell;
    this.byId = new Map();
    this.byKey = new Map();
  }

  // Reuses the card's terminal while its shell runs; a finished one is replaced.
  open({ key, cwd, cols, rows }) {
    const old = this.byKey.get(key);
    if (old && !old.exited) return this.view(old);
    if (old) this.drop(old);
    if (this.byId.size >= MAX_TERMINALS) throw new Error(`ターミナルは同時に ${MAX_TERMINALS} 個までです。使わないものを閉じてください`);
    const id = `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const env = { ...cleanEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'canban', LANG: process.env.LANG || 'ja_JP.UTF-8' };
    const child = this.spawner(this.python, [HELPER, this.shell, cwd || os.homedir(), String(clampSize(cols, 80)), String(clampSize(rows, 24))],
      { cwd: cwd || os.homedir(), env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    const t = { id, key, cwd, child, chunks: [], start: 0, end: 0, exited: false, code: null, waiters: new Set(), decoder: new StringDecoder('utf8') };
    const push = (text) => {
      if (!text) return;
      t.chunks.push(text);
      t.end += text.length;
      let kept = t.end - t.start;
      while (kept > KEEP_CHARS && t.chunks.length > 1) { const first = t.chunks.shift(); t.start += first.length; kept -= first.length; }
      this.wake(t);
    };
    child.stdout.on('data', (b) => push(t.decoder.write(b)));
    child.stderr.on('data', (b) => push(`\r\n[canban] ${String(b).trim()}\r\n`));
    child.on('error', (e) => { push(`\r\n[canban] ターミナルを起動できません: ${e.message}\r\n`); this.finish(t, null); });
    child.on('close', (code) => { push(t.decoder.end()); this.finish(t, code); });
    for (const s of [child.stdin, child.stdio[3]]) s?.on('error', () => {});
    this.byId.set(id, t);
    this.byKey.set(key, t);
    return this.view(t);
  }

  view(t) { return { id: t.id, cwd: t.cwd, start: t.start, end: t.end, exited: t.exited, code: t.code }; }

  get(id) {
    const t = this.byId.get(id);
    if (!t) throw new Error('ターミナルは終了しました。開き直してください');
    return t;
  }

  // Output from `since` on, waiting up to `timeoutMs` when there is none yet.
  async read({ id, since = 0, timeoutMs = 20000 }) {
    const t = this.get(id);
    if (since >= t.end && !t.exited) {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); t.waiters.delete(done); resolve(); };
        const timer = setTimeout(done, Math.min(READ_WAIT_MAX, Math.max(0, timeoutMs)));
        t.waiters.add(done);
      });
    }
    const from = Math.max(since, t.start);
    let data = '', at = t.start;
    for (const c of t.chunks) {
      if (at + c.length > from) data += at >= from ? c : c.slice(from - at);
      at += c.length;
    }
    return { ...this.view(t), offset: t.end, data, skipped: since < t.start };
  }

  write({ id, data }) {
    const t = this.get(id);
    if (!t.exited && typeof data === 'string' && data) t.child.stdin.write(data);
    return { ok: !t.exited };
  }

  resize({ id, cols, rows }) {
    const t = this.get(id);
    if (!t.exited) t.child.stdio[3]?.write(`resize ${clampSize(cols, 80)} ${clampSize(rows, 24)}\n`);
    return { ok: !t.exited };
  }

  close({ id }) {
    const t = this.byId.get(id);
    if (t) this.drop(t);
    return { ok: true };
  }

  closeAll() { for (const t of [...this.byId.values()]) this.drop(t); }

  finish(t, code) {
    if (t.exited) return;
    t.exited = true;
    t.code = code;
    this.wake(t);
  }

  wake(t) { for (const w of [...t.waiters]) w(); }

  drop(t) {
    this.byId.delete(t.id);
    if (this.byKey.get(t.key) === t) this.byKey.delete(t.key);
    if (!t.exited) { try { t.child.kill('SIGHUP'); } catch {} }
    t.exited = true;
    this.wake(t);
  }
}

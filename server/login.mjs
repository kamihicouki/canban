// Login processes belong to one managed account folder. Only URL/status crosses
// into the UI; tokens remain inside the vendor CLI and its credential store.
import fs from 'node:fs';
import { isolatedClaudeEnvironment } from './claude-auth-env.mjs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanEnv, resolveBin } from './dispatch.mjs';
import { loginBrowsers, loginTarget, openLoginBrowser } from './login-browsers.mjs';

export const MARKER = '.canban-account-profile';
export const LOGIN_TARGET_FILE = '.canban-login-target.json';

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const VERSION = JSON.parse(fs.readFileSync(path.join(SCRIPTS, '..', 'package.json'), 'utf8')).version;
const FINAL = new Set(['succeeded', 'failed', 'cancelled']);
const HOSTS = {
  codex: new Set(['auth.openai.com', 'chatgpt.com']),
  claude: new Set(['claude.ai', 'claude.com', 'console.anthropic.com', 'platform.claude.com', 'accounts.anthropic.com']),
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function authUrl(agent, text) {
  const u = new URL(text);
  // Claude uses code=true on its authorize page to request a pasteable code.
  // A real callback code (or token / fragment) must never be displayed here.
  const codeFlag = agent === 'claude' && ['/oauth/authorize', '/cai/oauth/authorize'].includes(u.pathname) && u.searchParams.getAll('code').length === 1 && u.searchParams.get('code') === 'true';
  if (u.protocol !== 'https:' || !HOSTS[agent]?.has(u.hostname) || u.username || u.password || u.hash ||
      ['id_token', 'access_token', 'refresh_token'].some((k) => u.searchParams.has(k)) || (u.searchParams.has('code') && !codeFlag)) throw new Error('CLIが返した認証URLを確認できませんでした');
  return u.toString();
}
export function loginEnvironment(home, env = process.env) {
  const out = cleanEnv(env);
  for (const k of ['BROWSER', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CANBAN_AUTH_SOCKET', 'CANBAN_AUTH_NONCE', 'CANBAN_AUTH_NODE', 'CANBAN_AUTH_HELPER']) delete out[k];
  for (const k of Object.keys(out)) if (/^CLAUDE_(BG|PTY)_/.test(k)) delete out[k];
  out[home.agent === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = home.dir;
  return home.agent === 'claude' ? isolatedClaudeEnvironment(out, home.dir) : out;
}
export function loginPreference(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home.dir, LOGIN_TARGET_FILE), 'utf8')); } catch { return null; }
}
function remember(home, target) {
  const file = path.join(home.dir, LOGIN_TARGET_FILE);
  if (fs.readFileSync(path.join(home.dir, MARKER), 'utf8').trim() !== home.id) throw new Error('Canbanのアカウントフォルダではありません');
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(target, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid())) throw new Error('認証用の作業領域を確認できません');
  fs.chmodSync(dir, 0o700);
}
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
export async function loginPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

export class LoginManager {
  constructor({ platform = process.platform, browsers = loginBrowsers, openBrowser = openLoginBrowser, spawnChild = spawn,
    resolveCli = resolveBin, checkPort = loginPortAvailable, onComplete = async () => null,
    runtimeDir = path.join('/tmp', `canban-auth-${process.getuid?.() ?? 'user'}`), timeoutMs = 15 * 60e3, rpcTimeoutMs = 30000 } = {}) {
    Object.assign(this, { platform, browsers, openBrowser, spawnChild, resolveCli, checkPort, onComplete, runtimeDir, timeoutMs, rpcTimeoutMs });
    this.sessions = new Map();
    this.closed = false;
  }
  catalog() { return this.browsers().map(({ executable, ...b }) => b); }
  view(s) {
    if (!s) throw new Error('認証処理が見つかりません。ログインを開始し直してください');
    return { sessionId: s.id, homeId: s.home.id, agent: s.home.agent, state: s.state, started: true, opened: false,
      target: s.target, authUrl: s.url || null, browserOpened: !!s.browserOpened, browserError: s.browserError || null,
      manualCodeRequired: !!s.manualCodeRequired, error: s.error || null, account: s.account || null };
  }
  status(id) { return this.view(this.sessions.get(id)); }
  active(home) { return [...this.sessions.values()].find((s) => s.home.dir === home.dir && !FINAL.has(s.state)); }
  async start(home, options) {
    if (this.closed) throw new Error('Canbanを開き直してください');
    if (this.platform !== 'darwin') throw new Error('バックグラウンド認証は現在macOSのみ対応しています');
    if (this.active(home)) throw new Error('このアカウントは認証中です。完了するかキャンセルしてください');
    const target = loginTarget(options || loginPreference(home) || { mode: 'manual' }, this.browsers());
    const bin = this.resolveCli(home.agent);
    if (!bin) throw new Error(`${home.agent === 'codex' ? 'Codex' : 'Claude'} CLIが見つかりません`);
    for (const [id, s] of this.sessions) if (FINAL.has(s.state) && Date.now() - s.finishedAt > 10 * 60e3) this.sessions.delete(id);
    const s = { id: crypto.randomUUID(), home, target, state: 'starting', pending: new Map(), nextId: 0 };
    this.sessions.set(s.id, s);
    s.timer = setTimeout(() => this.finish(s, 'failed', '認証がタイムアウトしました。ログインを開始し直してください'), this.timeoutMs);
    s.timer.unref();
    s.launch = this.launch(s, bin).catch(() => this.finish(s, 'failed', '認証処理を開始できませんでした。CLIのインストールと通信状態を確認してください'));
    return this.view(s);
  }
  async codexLock(s) {
    privateDir(this.runtimeDir);
    const dir = path.join(this.runtimeDir, 'codex.lock');
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Serialize stale-lock recovery across Chrome / desktop server processes.
      const reclaim = `${dir}.reclaim`;
      try { fs.mkdirSync(reclaim, { mode: 0o700 }); }
      catch { throw new Error('別のCodex認証が進行中です。しばらく待ってからやり直してください'); }
      try {
        let owner;
        try { owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')); } catch {}
        if (!owner || alive(owner.pid)) throw new Error('別のCodex認証が進行中です。完了するか、その認証をキャンセルしてください');
        fs.rmSync(dir, { recursive: true });
        fs.mkdirSync(dir, { mode: 0o700 });
      } finally { fs.rmSync(reclaim, { recursive: true }); }
    }
    fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, sessionId: s.id }), { mode: 0o600 });
    s.lock = dir;
  }
  async launch(s, bin) {
    const env = loginEnvironment(s.home);
    if (s.home.agent === 'codex') {
      try {
        await this.codexLock(s);
        if (!await this.checkPort(1455)) throw new Error('Codexの認証ポートが使用中です。既存の認証を完了してからやり直してください');
      } catch (e) { await this.finish(s, 'failed', e.message); return; }
    } else {
      await this.listen(s);
      Object.assign(env, { BROWSER: path.join(SCRIPTS, 'auth-browser.sh'), CANBAN_AUTH_NODE: process.execPath,
        CANBAN_AUTH_HELPER: path.join(SCRIPTS, 'auth-browser.mjs'), CANBAN_AUTH_SOCKET: s.socketPath, CANBAN_AUTH_NONCE: s.nonce });
    }
    if (s.finishing || s.cancelling || this.closed) return;
    remember(s.home, s.target);
    const file = s.home.agent === 'codex' ? bin : '/bin/bash';
    const args = s.home.agent === 'codex' ? ['app-server', '-c', 'cli_auth_credentials_store="file"'] : [path.join(SCRIPTS, 'auth-claude.sh'), bin, 'auth', 'login', '--claudeai'];
    s.child = this.spawnChild(file, args, { cwd: s.home.dir, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    s.exited = new Promise((resolve) => {
      s.child.once('close', (code) => { s.exitCode = code; s.didExit = true; resolve();
        if (!s.finishing) this.finish(s, code === 0 && s.home.agent === 'claude' ? 'succeeded' : 'failed', code === 0 ? '認証が完了する前にCLIが終了しました' : 'CLIの認証に失敗しました。ログインをやり直してください');
      });
    });
    s.child.once('error', () => this.finish(s, 'failed', '認証用CLIを起動できませんでした'));
    s.child.stdin.on('error', () => {});
    // Never forward CLI stdout/stderr to the MCP stream or persist it in a log.
    s.child.stderr.on('data', () => {});
    if (s.home.agent === 'claude') {
      let tail = '';
      s.child.stdout.on('data', (data) => {
        tail = (tail + data.toString()).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').slice(-2048);
        if (/paste.{0,30}code|enter.{0,30}code/i.test(tail)) s.manualCodeRequired = true;
      });
      return;
    }
    s.lines = readline.createInterface({ input: s.child.stdout });
    s.lines.on('line', (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      const w = s.pending.get(m.id);
      if (w) { s.pending.delete(m.id); clearTimeout(w.timer); m.error ? w.reject(new Error('Codexの認証APIがエラーを返しました')) : w.resolve(m.result); }
      if (m.method === 'account/login/completed') {
        if (!s.loginId) { s.completions ||= []; if (s.completions.length < 20) s.completions.push(m.params); }
        else this.codexCompleted(s, m.params);
      }
    });
    await this.rpc(s, 'initialize', { clientInfo: { name: 'canban-account-login', title: 'Canban', version: VERSION }, capabilities: {} });
    if (s.finishing || s.cancelling) return;
    s.child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const result = await this.rpc(s, 'account/login/start', { type: 'chatgpt' });
    if (s.finishing || s.cancelling) return;
    if (result?.type !== 'chatgpt' || !result.loginId) throw new Error('認証APIの応答が不正です');
    s.loginId = result.loginId;
    const completed = s.completions?.find((p) => p?.loginId === s.loginId);
    s.completions = null;
    if (completed) { this.codexCompleted(s, completed); return; }
    await this.receivedUrl(s, result.authUrl);
  }
  codexCompleted(s, result) {
    if (result?.loginId !== s.loginId) return;
    this.finish(s, result.success ? 'succeeded' : 'failed', 'Codexの認証が完了しませんでした。ログインをやり直してください');
  }
  rpc(s, method, params, timeout = this.rpcTimeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++s.nextId;
      const timer = setTimeout(() => { s.pending.delete(id); reject(new Error('認証APIが応答しませんでした')); }, timeout);
      s.pending.set(id, { resolve, reject, timer });
      try { s.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); } catch { clearTimeout(timer); s.pending.delete(id); reject(new Error('認証プロセスが終了しました')); }
    });
  }
  async listen(s) {
    privateDir(this.runtimeDir);
    s.nonce = crypto.randomBytes(24).toString('hex');
    s.socketPath = path.join(this.runtimeDir, `s-${s.id.slice(0, 16)}.sock`);
    s.server = net.createServer({ allowHalfOpen: true }, (socket) => {
      socket.setTimeout(5000, () => socket.destroy());
      let data = '';
      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        data += chunk;
        if (data.length > 16384) return socket.destroy();
        if (!data.includes('\n')) return;
        try {
          const m = JSON.parse(data.split('\n')[0]);
          if (m.nonce !== s.nonce || s.finishing || s.cancelling) return socket.end('NO');
          let url;
          try { url = authUrl(s.home.agent, m.url); }
          catch { socket.end('NO'); this.finish(s, 'failed', 'CLIが返した認証URLを確認できませんでした'); return; }
          socket.end('OK');
          this.receivedUrl(s, url).catch(() => this.finish(s, 'failed', '認証URLを確認できませんでした'));
        } catch { socket.end('NO'); }
      });
    });
    await new Promise((resolve, reject) => { s.server.once('error', reject); s.server.listen(s.socketPath, resolve); });
    fs.chmodSync(s.socketPath, 0o600);
    if (s.finishing) { s.server.close(); try { fs.unlinkSync(s.socketPath); } catch {} }
  }
  async receivedUrl(s, text) {
    if (s.finishing || s.cancelling) return;
    const url = authUrl(s.home.agent, text);
    if (s.url === url) return;
    s.url = url;
    s.state = 'waiting';
    if (s.target.mode === 'auto') await this.open(s.id);
  }
  async open(id, options) {
    const s = this.sessions.get(id);
    if (!s || s.finishing || s.cancelling || !s.url) throw new Error('有効な認証URLがありません。ログインを開始し直してください');
    s.browserError = null;
    try {
      let target;
      try { target = loginTarget(options || s.target, this.browsers()); }
      catch (e) { s.browserError = e.message; return this.view(s); }
      if (target.mode !== 'auto') throw new Error('自動で開くブラウザを選んでください');
      s.target = target;
      await this.openBrowser(target, s.url, this.browsers());
      if (s.finishing || s.cancelling) return this.view(s);
      s.browserOpened = true;
      remember(s.home, target);
    } catch (e) { if (!s.finishing && !s.cancelling) s.browserError = e.browserReason || '選んだブラウザを開けませんでした。認証URLをコピーして開くか、ブラウザを選び直してください'; }
    return this.view(s);
  }
  submitCode(id, code) {
    const s = this.sessions.get(id);
    if (!s || s.home.agent !== 'claude' || s.state !== 'waiting' || s.finishing || s.cancelling) throw new Error('認証コードを送信できる状態ではありません');
    if (typeof code !== 'string' || !code.trim() || code.length > 4096 || /[\r\n\x00-\x1f\x7f]/.test(code)) throw new Error('認証画面でコピーしたコードを1行で入力してください');
    s.child.stdin.write(`${code.trim()}\n`);
    s.manualCodeRequired = false;
    return this.view(s);
  }
  async stop(s) {
    if (!s.child || s.didExit) return;
    // A PTY child has its own process group. Capture only descendants of our
    // detached child, using process metadata rather than command lines.
    const groups = new Set(Number.isInteger(s.child.pid) && s.child.pid > 1 ? [s.child.pid] : []);
    if (s.home.agent === 'claude' && groups.size) {
      const rows = await new Promise((resolve) => execFile('/bin/ps', ['-axo', 'pid=,ppid=,pgid='], { timeout: 1000, maxBuffer: 1024 * 1024 }, (error, out) => resolve(error ? [] : out.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number)))));
      const owned = new Set(groups);
      let changed;
      do { changed = false; for (const [pid, parent] of rows) if (owned.has(parent) && !owned.has(pid)) { owned.add(pid); changed = true; } } while (changed);
      for (const [pid, , group] of rows) if (owned.has(pid) && owned.has(group) && group > 1) groups.add(group);
    }
    if (s.home.agent === 'claude') { try { s.child.stdin.write('\x03'); } catch {} }
    try { s.child.stdin.end(); } catch {}
    if (s.home.agent === 'claude') {
      // Give script time to reap its child before terminating the PTY parent.
      await Promise.race([s.exited, sleep(500)]);
      if (s.didExit) return;
    }
    const kill = (signal) => {
      for (const group of groups) { try { process.kill(-group, signal); } catch {} }
    };
    kill('SIGTERM');
    await Promise.race([s.exited, sleep(1000)]);
    kill('SIGKILL'); await Promise.race([s.exited, sleep(1000)]);
  }
  async finish(s, state, error) {
    if (s.cancelling) state = 'cancelled';
    if (s.finishing) return s.finishing;
    s.finishing = (async () => {
      clearTimeout(s.timer);
      s.url = null;
      s.manualCodeRequired = false;
      s.state = state === 'succeeded' ? 'verifying' : state;
      s.error = state === 'failed' ? error : null;
      if (state === 'succeeded') {
        try {
          s.account = await this.onComplete(s.home);
          if (!s.account?.key) throw new Error('missing account');
          s.state = 'succeeded';
        } catch { s.state = 'failed'; s.error = '認証後のアカウントを確認できませんでした。ボードを再読み込みしてください'; }
      }
      for (const w of s.pending.values()) { clearTimeout(w.timer); w.reject(new Error('認証処理が終了しました')); }
      s.pending.clear();
      await this.stop(s);
      s.lines?.close();
      s.child?.stdout.removeAllListeners('data');
      s.child?.stderr.removeAllListeners('data');
      s.child = null; s.lines = null; s.completions = null; s.nonce = null;
      s.server?.close();
      if (s.socketPath) { try { fs.unlinkSync(s.socketPath); } catch {} }
      if (s.lock) { try {
        const owner = JSON.parse(fs.readFileSync(path.join(s.lock, 'owner.json'), 'utf8'));
        if (owner.sessionId === s.id) fs.rmSync(s.lock, { recursive: true });
      } catch {} }
      s.finishedAt = Date.now();
    })();
    return s.finishing;
  }
  async cancel(id) {
    const s = this.sessions.get(id);
    if (!s) return this.view(s);
    if (!s.finishing) { s.cancelling = true; s.state = 'cancelled'; s.url = null; }
    if (!s.finishing && s.loginId && !s.didExit) {
      // Stop exposing the URL before the remote cancellation acknowledgement.
      s.url = null;
      try { await this.rpc(s, 'account/login/cancel', { loginId: s.loginId }, 2000); } catch {}
    }
    await this.finish(s, 'cancelled');
    return this.view(s);
  }
  async shutdown() {
    this.closed = true;
    await Promise.all([...this.sessions.values()].map((s) => this.cancel(s.id)));
  }
}

const managers = new Set();
export function managedLogins(options) { const manager = new LoginManager(options); managers.add(manager); return manager; }
export async function shutdownLogins() { await Promise.all([...managers].map((m) => m.shutdown())); managers.clear(); }

// Subscription usage only: no prompts, threads or billable model turns are created.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { cleanEnv, resolveBin } from './dispatch.mjs';
import { credentialIdentity, claudeCredentials } from './account-credentials.mjs';

export class UsageError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const failure = (code) => { throw new UsageError(code); };
const windowValue = (used, minutes, reset) => Number.isFinite(used) && used >= 0 && used <= 100
  ? { usedPercent: used, windowMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : null, resetsAt: Number.isFinite(reset) && reset > 0 ? reset : null } : null;
export function codexSnapshot(result, now = Date.now()) {
  const l = result?.rateLimitsByLimitId?.codex || result?.rateLimits;
  const win = (w) => w ? windowValue(w.usedPercent, w.windowDurationMins, w.resetsAt == null ? null : w.resetsAt * 1000) : null;
  const primary = win(l?.primary), secondary = win(l?.secondary);
  if (!primary && !secondary) failure('unsupported');
  return { at: now, primary, secondary, plan: l.planType || null, source: 'live' };
}
export function claudeSnapshot(result, now = Date.now()) {
  const win = (w, minutes) => w ? windowValue(w.utilization, minutes, w.resets_at ? Date.parse(w.resets_at) : null) : null;
  const primary = win(result?.five_hour, 300), secondary = win(result?.seven_day, 10080);
  if (!primary && !secondary) failure('unsupported');
  return { at: now, primary, secondary, plan: null, source: 'live' };
}

// A short-lived stdio app-server, pinned to the selected home and its file credentials.
export async function codexUsage({ key, home }, { spawner = spawn, bin = resolveBin('codex'), timeoutMs = 15000, now = Date.now } = {}) {
  if (key === 'codex:apikey') failure('unsupported');
  if (await credentialIdentity('codex', home) !== key) failure('login_required');
  if (!bin) failure('unavailable');
  const env = { ...cleanEnv(), CODEX_HOME: home.dir };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) delete env[key];
  const child = spawner(bin, ['app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="file"'],
    { cwd: home.dir, env, stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map(); let id = 0, bytes = 0;
  const reject = (code) => { for (const p of pending.values()) p.reject(new UsageError(code)); pending.clear(); };
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    bytes += line.length;
    if (bytes > 1024 * 1024) { reject('unavailable'); child.kill(); return; }
    let message; try { message = JSON.parse(line); } catch { return; }
    const p = pending.get(message.id); if (!p) return;
    pending.delete(message.id);
    if (message.error) p.reject(new UsageError('unavailable')); else p.resolve(message.result);
  });
  child.on('error', () => reject('unavailable'));
  child.on('exit', () => reject('unavailable'));
  child.stdin.on('error', () => reject('unavailable'));
  const timer = setTimeout(() => { reject('timeout'); child.kill(); }, timeoutMs);
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const request = ++id; pending.set(request, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id: request, method, params })}\n`);
  });
  try {
    await rpc('initialize', { clientInfo: { name: 'canban_usage', version: '1' }, capabilities: { explicitGatewayOauth: true } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const account = await rpc('account/read', { refreshToken: false });
    if (account?.account?.type !== 'chatgpt') failure(account?.account ? 'unsupported' : 'login_required');
    const result = await rpc('account/rateLimits/read', {});
    if ((result?.accountId && `codex:${result.accountId}` !== key) || await credentialIdentity('codex', home) !== key) failure('identity_changed');
    return codexSnapshot(result, now());
  } finally { clearTimeout(timer); lines.close(); child.stdin.end(); child.kill(); }
}

export async function claudeUsage({ key, home }, { fetcher = fetch, credentials = claudeCredentials, timeoutMs = 8000, now = Date.now } = {}) {
  if (await credentialIdentity('claude', home) !== key) failure('login_required');
  const saved = await credentials(home), auth = saved?.claudeAiOauth;
  if (!auth?.accessToken || (Number.isFinite(auth.expiresAt) && auth.expiresAt <= now())) failure('login_required');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  const get = async (endpoint) => {
    // Fixed official origin; redirects cannot forward this bearer token elsewhere.
    const r = await fetcher(`https://api.anthropic.com/api/oauth/${endpoint}`, { signal: controller.signal, redirect: 'error',
      headers: { Authorization: `Bearer ${auth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json', 'User-Agent': 'canban/0.16.0' } });
    if (r.status === 401 || r.status === 403) failure('login_required');
    if (r.status === 429) failure('rate_limited');
    if (!r.ok) failure('unavailable');
    return r.json();
  };
  try {
    const profile = await get('profile');
    if (`claude:${profile?.account?.uuid}` !== key) failure('identity_changed');
    const result = await get('usage');
    if (await credentialIdentity('claude', home) !== key) failure('identity_changed');
    return { ...claudeSnapshot(result, now()), plan: auth.subscriptionType || null };
  } catch (error) {
    if (error instanceof UsageError) throw error;
    failure(controller.signal.aborted ? 'timeout' : 'unavailable');
  } finally { clearTimeout(timer); }
}

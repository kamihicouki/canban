// Private provider credentials. Never return these objects through MCP or persist them in Canban.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

export async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}
export function claudeConfigFile(home) {
  return home.default && path.resolve(home.dir) === path.join(os.homedir(), '.claude') && !process.env.CLAUDE_CONFIG_DIR
    ? path.join(os.homedir(), '.claude.json') : path.join(home.dir, '.claude.json');
}
export async function credentialIdentity(agent, home) {
  const value = await readJson(agent === 'codex' ? path.join(home.dir, 'auth.json') : claudeConfigFile(home));
  const id = agent === 'codex' ? value?.tokens?.account_id : value?.oauthAccount?.accountUuid;
  return typeof id === 'string' && id ? `${agent}:${id}` : null;
}
export function claudeKeychainService(home) {
  const custom = !home.default || path.resolve(home.dir) !== path.join(os.homedir(), '.claude') || !!process.env.CLAUDE_CONFIG_DIR;
  return `Claude Code-credentials${custom ? `-${crypto.createHash('sha256').update(home.dir.normalize('NFC')).digest('hex').slice(0, 8)}` : ''}`;
}
const readKeychain = (service) => new Promise((resolve) => {
  execFile('/usr/bin/security', ['find-generic-password', '-a', process.env.USER || os.userInfo().username, '-w', '-s', service],
    { timeout: 5000, maxBuffer: 256 * 1024 }, (error, stdout) => {
      try { resolve(error ? null : JSON.parse(stdout.trim())); } catch { resolve(null); }
    });
});
export async function claudeCredentials(home, { platform = process.platform, keychain = readKeychain } = {}) {
  // Claude Code uses Keychain first on macOS, then its supported plaintext fallback.
  const secured = platform === 'darwin' ? await keychain(claudeKeychainService(home)) : null;
  return secured?.claudeAiOauth?.accessToken ? secured : await readJson(path.join(home.dir, '.credentials.json'));
}

// Keep refreshed credentials in the same vendor store, never in board settings.
// Recheck immediately before writing so another CLI login cannot be overwritten.
export async function updateClaudeCredentials(home, expected, next, { platform = process.platform, keychain = readKeychain, writeKeychain: persistKeychain = writeKeychain } = {}) {
  const service = claudeKeychainService(home);
  const secured = platform === 'darwin' ? await keychain(service) : null;
  const file = path.join(home.dir, '.credentials.json');
  const current = secured?.claudeAiOauth?.accessToken ? secured : await readJson(file);
  const same = current?.claudeAiOauth?.accessToken === expected?.claudeAiOauth?.accessToken &&
    current?.claudeAiOauth?.refreshToken === expected?.claudeAiOauth?.refreshToken;
  if (!current || !same) return false;
  const value = { ...current, claudeAiOauth: next.claudeAiOauth };
  if (secured?.claudeAiOauth?.accessToken) {
    await persistKeychain(service, value);
    const persisted = await keychain(service);
    if (persisted?.claudeAiOauth?.accessToken !== value.claudeAiOauth.accessToken ||
        persisted?.claudeAiOauth?.refreshToken !== value.claudeAiOauth.refreshToken) throw new Error('credential_store_unavailable');
  } else {
    const target = await fs.realpath(file);
    const tmp = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      await fs.rename(tmp, target);
    } finally { await fs.unlink(tmp).catch(() => {}); }
  }
  return true;
}

const writeKeychain = (service, value) => new Promise((resolve, reject) => {
  // security's interactive input avoids putting tokens in process arguments.
  const quote = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const child = execFile('/usr/bin/security', ['-i'], { timeout: 5000, maxBuffer: 256 * 1024 }, (error) => {
    if (error) reject(new Error('credential_store_unavailable')); else resolve();
  });
  child.stdin.on('error', () => {});
  child.stdin.end(`add-generic-password -U -a ${quote(process.env.USER || os.userInfo().username)} -s ${quote(service)} -w ${quote(JSON.stringify(value))}\n`);
});

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

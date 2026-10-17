// Static SSH identity resolution only. Never invokes ssh -G, Match exec or a shell.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const safe = value => typeof value === 'string' && /^[A-Za-z0-9_.-]+$/.test(value) && !value.startsWith('-');
const unknown = reason => ({ state: 'unknown', reason });
const pattern = (value, glob) => new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i').test(value);
function tokens(line) {
  const out = []; let value = '', quote = null;
  for (const ch of line) {
    if (ch === '#' && !quote) break;
    if (ch === '"' || ch === "'") { if (!quote) quote = ch; else if (quote === ch) quote = null; else value += ch; }
    else if (/\s/.test(ch) && !quote) { if (value) out.push(value); value = ''; }
    else value += ch;
  }
  if (quote) throw new Error('SSH の引用符を確認してください');
  if (value) out.push(value); return out;
}
export async function resolveSshTarget(input, { readConfig = file => fs.readFile(file, 'utf8'), configFile = path.join(os.homedir(), '.ssh', 'config'), defaultUser = os.userInfo().username } = {}) {
  const parts = String(input.alias || input.hostname || '').split('@');
  const alias = parts.at(-1), explicitUser = input.user || input.sshUser || (parts.length === 2 ? parts[0] : null);
  if (!safe(alias) || parts.length > 2 || explicitUser && !safe(explicitUser) || input.hostname && !safe(input.hostname)) return unknown('SSH の接続先を確認できません');
  const values = {};
  if (input.hostname) values.hostname = input.hostname;
  if (explicitUser) values.user = explicitUser;
  if (input.port != null || input.sshPort != null) values.port = String(input.port ?? input.sshPort);
  const stack = new Set(); let count = 0, matched = true;
  async function read(file) {
    file = path.resolve(file);
    if (stack.has(file) || ++count > 32) throw new Error('SSH Include が循環しています');
    stack.add(file);
    let content;
    try { content = await readConfig(file); }
    catch (e) { if (e.code === 'ENOENT' && file === path.resolve(configFile)) content = ''; else throw e; }
    for (const line of String(content).split(/\r?\n/)) {
      const words = tokens(line.replace(/^\s*(\w+)\s*=\s*/, '$1 ')); if (!words.length) continue;
      const key = words.shift().toLowerCase();
      if (key === 'match' || key === 'proxycommand' || key === 'canonicalizehostname') throw new Error('動的な SSH 設定は静的に照合できません');
      if (key === 'host') {
        if (!words.length) throw new Error('SSH Host が不正です');
        matched = words.some(w => !w.startsWith('!') && pattern(alias,w)) && !words.some(w => w.startsWith('!') && pattern(alias,w.slice(1)));
      } else if (key === 'include' && matched) {
        for (let include of words) {
          if (/[%$*?`\\]/.test(include)) throw new Error('SSH Include を確定できません');
          if (include.startsWith('~/')) include = path.join(os.homedir(),include.slice(2));
          await read(path.isAbsolute(include) ? include : path.join(path.dirname(file),include));
        }
      } else if (matched && ['hostname','user','port'].includes(key)) {
        if (words.length !== 1 || /[%$`\\]/.test(words[0])) throw new Error('SSH 設定の値を確定できません');
        values[key] ??= words[0];
      }
    }
    stack.delete(file);
  }
  try { await read(configFile); } catch { return unknown('SSH の動的条件・Include・設定値を確認してください'); }
  const hostname = values.hostname || alias, user = values.user || defaultUser, port = Number(values.port || 22);
  if (!safe(hostname) || !safe(user) || !Number.isInteger(port) || port < 1 || port > 65535) return unknown('SSH のホスト・ユーザー・ポートを確認できません');
  return { state: 'resolved', hostname: hostname.toLowerCase(), user, port };
}
export async function matchDesktopTarget({ requested, claudeEnvironments = [], codexHosts = [] }, options = {}) {
  const target = await resolveSshTarget(requested, options);
  if (target.state !== 'resolved') return target;
  const key = t => `${t.hostname}\0${t.user}\0${t.port}`;
  async function matches(items, toInput) {
    const out = [];
    for (const item of items) {
      if (requested.account && item.account && requested.account !== item.account) continue;
      const t = await resolveSshTarget(toInput(item), options);
      if (t.state === 'resolved' && key(t) === key(target)) out.push(item);
    }
    return out;
  }
  const [environments, hosts] = await Promise.all([matches(claudeEnvironments, e => ({alias:e.sshHost,port:e.sshPort,user:e.sshUser})), matches(codexHosts, h => ({alias:h.alias,hostname:h.hostname,user:h.sshUser,port:h.sshPort}))]);
  if (environments.length > 1 || hosts.length > 1) return { state:'ambiguous',reason:'同じ接続先が複数あります。環境とアカウントを選び直してください' };
  return { ...target, claudeEnvironment: environments[0] || null, codexHost: hosts[0] || null };
}

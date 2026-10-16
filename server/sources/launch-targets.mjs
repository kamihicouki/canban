// Where a new session can start, as the desktop apps list it (read-only):
// - Claude Desktop "環境": ccd-session-presets.json of the signed-in account (a folder
//   on this Mac, or a folder over SSH from ssh_configs.json).
// - Codex "プロジェクト" and "実行場所": the app's projects (local / remote) and the
//   Codex Cloud environments it last fetched (.codex-global-state.json).
import path from 'node:path';
import { exists, readJson } from './readonly.mjs';
import { codexAppState } from './codex-app.mjs';
import { codexHome } from './codex.mjs';

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const SAFE_HOST = /^[A-Za-z0-9_.@-]{1,253}$/;

async function json(file) {
  if (!exists(file)) return null;
  try { return await readJson(file); } catch { return null; }
}

// appDir: Claude Desktop's data folder (~/Library/Application Support/Claude).
export async function claudeEnvironments(appDir) {
  const [config, presets, ssh] = await Promise.all(['config.json', 'ccd-session-presets.json', 'ssh_configs.json'].map((f) => json(path.join(appDir, f))));
  const account = str(config?.lastKnownAccountUuid);
  const list = account ? presets?.byAccount?.[account]?.presets : null;
  const sshHosts = new Map((Array.isArray(ssh?.configs) ? ssh.configs : []).map((c) => [str(c?.id), c]));
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    const id = str(p?.id), name = str(p?.name), cwd = str(p?.target?.cwd);
    if (!id || !name || !cwd?.startsWith('/') && !cwd?.startsWith('~')) continue;
    const kind = p.target.kind;
    if (kind === 'local') out.push({ id, name: name.slice(0, 120), kind, cwd, lastUsedAt: p.lastUsedAt || p.createdAt || 0 });
    else if (kind === 'ssh') {
      const host = sshHosts.get(str(p.target.sshConfigId));
      const sshHost = str(host?.sshHost);
      if (!sshHost || !SAFE_HOST.test(sshHost)) continue;
      out.push({ id, name: name.slice(0, 120), kind, cwd, sshHost, sshLabel: str(host.name) || sshHost, sshPort: Number.isInteger(host.sshPort) ? host.sshPort : null, lastUsedAt: p.lastUsedAt || p.createdAt || 0 });
    }
  }
  return { account: account ? `claude:${account}` : null, environments: out.sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.name.localeCompare(b.name)) };
}

// ChatGPT "projects" synced into ~/.codex/.chatgpt-projects are not in the Codex picker.
export async function codexLaunchTargets({ home = codexHome() } = {}) {
  const app = await codexAppState({ home });
  const hidden = path.join(home, '.chatgpt-projects') + path.sep;
  const projects = app.projectOrder.map((id) => app.projects.get(id))
    .filter((p) => p.roots.length && !p.roots.every((r) => r.startsWith(hidden)))
    .map((p) => ({ id: p.id, name: p.name, root: p.roots[0], roots: p.roots, hostId: p.hostId || 'local' }));
  return { projects, cloudEnvironments: app.cloudEnvironments };
}

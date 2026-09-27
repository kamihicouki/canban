// Remote machines registered as connections in the Codex desktop app (read-only).
// Source: ~/.codex/.codex-global-state.json → "codex-managed-remote-connections"
// (through the shared, mtime-cached reader in codex-app.mjs).
import { codexHome } from './codex.mjs';
import { codexAppState } from './codex-app.mjs';

const SAFE_ALIAS = /^[A-Za-z0-9._@][A-Za-z0-9._@-]{0,127}$/; // no leading '-': never an ssh option

export async function listRemoteHosts({ home = codexHome() } = {}) {
  const conns = (await codexAppState({ home })).remoteConnections;
  const hosts = [];
  for (const c of conns) {
    if (!c || typeof c.hostId !== 'string') continue;
    const alias = typeof c.alias === 'string' && c.alias ? c.alias : c.hostname;
    if (!alias || !SAFE_ALIAS.test(alias)) continue; // never pass anything that looks like an ssh option
    const sshArgs = [];
    if (c.hostname && c.hostname !== alias && SAFE_ALIAS.test(c.hostname)) sshArgs.push('-o', `HostName=${c.hostname}`);
    if (Number.isInteger(c.sshPort) && c.sshPort > 0 && c.sshPort < 65536) sshArgs.push('-p', String(c.sshPort));
    hosts.push({
      id: c.hostId,
      alias,
      label: (typeof c.displayName === 'string' && c.displayName) || alias,
      local: false,
      sshPort: Number.isInteger(c.sshPort) ? c.sshPort : null,
      sshArgs,
    });
  }
  return hosts;
}

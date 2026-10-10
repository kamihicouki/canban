// Agent adapters: how to reopen a session in the agent's desktop app, and the
// shell command that resumes it in a terminal. Add an entry here to support a new agent.

import { claudeAuthOverrides } from './claude-auth-env.mjs';
import { CODEX_AUTH_OVERRIDES } from './codex-auth-env.mjs';
import { isCloudSession } from './sources/codex-dots.mjs';

export function shq(s) {
  const v = String(s ?? '');
  return /^[\w@%+=:,./~-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

const CLAUDE_DESKTOP_ID = /^local_[A-Za-z0-9-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const AGENTS = {
  codex: {
    label: 'Codex',
    app: 'Codex',
    cli: (s) => `codex resume ${shq(s.nativeId)}`,
    desktop(s) {
      const url = new URL(`codex://threads/${encodeURIComponent(s.nativeId)}`);
      if (s.host && !s.host.local) url.searchParams.set('hostId', s.host.id);
      return { url: url.toString(), exact: true, label: 'Codex で開く' };
    },
  },
  claude: {
    label: 'Claude Code',
    app: 'Claude',
    cli: (s) => `claude --resume ${shq(s.resumePath || s.nativeId)}`,
    desktop(s) {
      if (s.host && !s.host.local) return null; // the desktop app cannot attach to a remote CLI transcript
      if (s.desktopSessionId && CLAUDE_DESKTOP_ID.test(s.desktopSessionId) && !s.archived) {
        return { url: `claude://code/continue?session=${s.desktopSessionId}`, exact: true, label: 'Claude で開く' };
      }
      if (UUID.test(s.nativeId)) {
        // Claude desktop imports the CLI transcript and opens it (the import is done by Claude itself).
        return {
          url: `claude://resume?session=${s.nativeId}`,
          exact: true,
          label: 'Claude で開く',
          note: 'CLI のセッションを Claude デスクトップに取り込んで開きます。',
        };
      }
      if (!s.cwd) return null;
      return {
        url: `claude://code/new?folder=${encodeURIComponent(s.cwd)}`,
        exact: false,
        label: 'Claude でフォルダを開く',
        note: 'このセッションは Claude デスクトップでは開けないため、同じフォルダで新しいセッションを開きます。続きはターミナルで再開できます。',
      };
    },
  },
};

// ---- headless turns (requests) -------------------------------------------
// argv (no shell) for one non-interactive turn in an existing session; the prompt is
// written to stdin. `permission` comes from permissions.mjs and is never raised here.
export const HEADLESS = {
  codex: {
    bin: 'codex',
    args(s, p) {
      const args = ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', `sandbox_mode="${p.sandbox}"`, '-c', 'approval_policy="never"'];
      if (p.sandbox === 'workspace-write' && typeof p.network === 'boolean') args.push('-c', `sandbox_workspace_write.network_access=${p.network}`);
      return [...args, s.nativeId, '-'];
    },
  },
  claude: {
    bin: 'claude',
    // `json` prints one result object at the end, which keeps run logs small.
    args: (s, p) => ['-p', '--resume', s.resumePath || s.nativeId, '--output-format', 'json', '--permission-mode', p.mode],
  },
};

export function headlessArgs(s, permission, { images = [] } = {}) {
  if (isCloudSession(s)) return null;
  const h = HEADLESS[s.agent];
  if (!h || !s.nativeId) return null;
  const args = h.args(s, permission);
  if (images.length && s.agent === 'codex') args.splice(2, 0, ...images.flatMap(i => ['--image', i.path]));
  if (images.length && s.agent === 'claude') {
    args[args.indexOf('--output-format') + 1] = 'stream-json';
    args.push('--input-format', 'stream-json', '--verbose');
  }
  return { bin: h.bin, args };
}

// A session from another config folder (CLAUDE_CONFIG_DIR / CODEX_HOME profile) resumes there.
export function homePrefix(s) {
 if (!s.homeDir || (s.host && !s.host.local)) return '';
 if (s.agent === 'claude') return `env ${[...new Set([...claudeAuthOverrides(), 'CLAUDE_CONFIG_DIR'])].map(key => `-u ${shq(key)}`).join(' ')} ${s.claudeDefaultConfig ? '' : `CLAUDE_CONFIG_DIR=${shq(s.homeDir)} `}`;
  return `env ${CODEX_AUTH_OVERRIDES.map(key => `-u ${shq(key)}`).join(' ')} CODEX_HOME=${shq(s.homeDir)} `;
}

export function resumeCommand(s) {
  if (isCloudSession(s)) return null;
  const agent = AGENTS[s.agent];
  if (!agent) return null;
  const inner = `${s.cwd ? `cd ${shq(s.cwd)} 2>/dev/null${s.resumePath ? ' &&' : ';'} ` : ''}${homePrefix(s)}${agent.cli(s)}`;
  return s.host && !s.host.local ? `ssh -t ${shq(s.host.alias)} ${shq(inner)}` : inner;
}

export function desktopLink(s) {
  return AGENTS[s.agent]?.desktop(s) ?? null;
}

export function launchInfo(s) {
  return { desktop: desktopLink(s), terminal: { command: resumeCommand(s) } };
}

// ---- new sessions (task cards) ---------------------------------------------
// host: { local } or { local:false, id, alias, sshPort? }; cwd: absolute folder on that host.
export function newSessionLink(agent, { host, cwd, prompt }) {
  const remote = host && host.local === false;
  if (agent === 'codex') {
    const url = new URL('codex://threads/new');
    if (prompt) url.searchParams.set('prompt', prompt);
    if (cwd) url.searchParams.set('path', cwd);
    if (remote) url.searchParams.set('hostId', host.id);
    return { url: url.toString(), label: 'Codex で開始' };
  }
  if (agent === 'claude') {
    const url = new URL('claude://code/new');
    if (prompt) url.searchParams.set('q', prompt);
    if (remote) {
      url.searchParams.set('ssh_host', host.alias);
      if (host.sshPort) url.searchParams.set('ssh_port', String(host.sshPort));
      if (cwd) url.searchParams.set('ssh_folder', cwd);
    } else if (cwd) url.searchParams.set('folder', cwd);
    return { url: url.toString(), label: 'Claude で開始' };
  }
  return null;
}

// prefix: homePrefix() of the account to start with (local only).
export function newSessionCommand(agent, { host, cwd, prompt, images = [], prefix = '' }) {
  const bin = agent === 'codex' ? 'codex' : agent === 'claude' ? 'claude' : null;
  if (!bin) return null;
  const imageArgs = agent === 'codex' ? images.map(i => ` --image ${shq(i.path)}`).join('') : '';
  const inner = `${cwd ? `cd ${shq(cwd)} 2>/dev/null; ` : ''}${prefix}${bin}${imageArgs}${prompt ? `${imageArgs ? ' --' : ''} ${shq(prompt)}` : ''}`;
  return host && host.local === false ? `ssh -t ${shq(host.alias)} ${shq(inner)}` : inner;
}

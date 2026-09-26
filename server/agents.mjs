// Agent adapters: how to reopen a session in the agent's desktop app, and the
// shell command that resumes it in a terminal. Add an entry here to support a new agent.

export function shq(s) {
  const v = String(s ?? '');
  return /^[\w@%+=:,./~-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

const CLAUDE_DESKTOP_ID = /^local_[A-Za-z0-9-]{1,64}$/;

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
    cli: (s) => `claude --resume ${shq(s.nativeId)}`,
    desktop(s) {
      if (s.host && !s.host.local) return null; // the desktop app cannot attach to a remote CLI transcript
      if (s.desktopSessionId && CLAUDE_DESKTOP_ID.test(s.desktopSessionId) && !s.archived) {
        return { url: `claude://code/continue?session=${s.desktopSessionId}`, exact: true, label: 'Claude で開く' };
      }
      if (!s.cwd) return null;
      return {
        url: `claude://code/new?folder=${encodeURIComponent(s.cwd)}`,
        exact: false,
        label: 'Claude でフォルダを開く',
        note: 'このセッションは Claude デスクトップに記録が無いため、同じフォルダで新しいセッションを開きます。続きはターミナルで再開できます。',
      };
    },
  },
};

export function resumeCommand(s) {
  const agent = AGENTS[s.agent];
  if (!agent) return null;
  const inner = `${s.cwd ? `cd ${shq(s.cwd)} 2>/dev/null; ` : ''}${agent.cli(s)}`;
  return s.host && !s.host.local ? `ssh -t ${shq(s.host.alias)} ${shq(inner)}` : inner;
}

export function desktopLink(s) {
  return AGENTS[s.agent]?.desktop(s) ?? null;
}

export function launchInfo(s) {
  return { desktop: desktopLink(s), terminal: { command: resumeCommand(s) } };
}

import path from 'node:path';

export function projectName(cwd) {
  if (!cwd) return null;
  const clean = String(cwd).replace(/^file:\/\//, '').replace(/\/+$/, '');
  // Worktrees such as ~/.codex/worktrees/<id>/<repo> or .claude/worktrees/<name> -> repo name
  const wt = /\/\.(?:codex|claude)\/worktrees\/[^/]+\/([^/]+)/.exec(clean);
  if (wt) return wt[1];
  const cwt = /^(.*)\/\.claude\/worktrees\/[^/]+$/.exec(clean);
  if (cwt) return path.basename(cwt[1]);
  return path.basename(clean) || clean;
}

export function clip(s, n) {
  if (!s) return '';
  s = String(s);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// Strip injected context blocks (system reminders, command wrappers) from a user prompt.
export function cleanPrompt(s) {
  if (!s) return '';
  let t = String(s);
  t = t.replace(/<(system-reminder|recommended_plugins|app-context|environment_context|user_instructions|command-message|local-command-stdout|local-command-caveat)[^>]*>[\s\S]*?<\/\1>/g, '');
  t = t.replace(/<command-name>([\s\S]*?)<\/command-name>/g, '$1');
  t = t.replace(/<command-args>([\s\S]*?)<\/command-args>/g, ' $1');
  return t.trim();
}

export function firstLine(s) {
  if (!s) return '';
  return String(s).split('\n').map((l) => l.trim()).find(Boolean) || '';
}

// Where a session lives. Local sessions keep the v0.1 card ids (`codex:<id>`) so
// existing boards stay valid; remote ones are namespaced by SSH alias.
export const LOCAL_HOST = Object.freeze({ id: 'local', alias: null, label: 'このマシン', local: true });

export function sessionKey(agent, host, nativeId) {
  return host?.local === false ? `${agent}@${host.alias}:${nativeId}` : `${agent}:${nativeId}`;
}

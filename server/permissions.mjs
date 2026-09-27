// What a headless turn is allowed to do: inherited from the session's own latest
// settings, never raised. Codex records them per turn (`turn_context`) and in the
// state DB; Claude Code records `permissionMode` on each prompt. Workspace settings
// (.codex/, .claude/settings*.json) are applied by the CLI itself from the cwd.

export const CODEX_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];
export const CLAUDE_MODES = ['default', 'manual', 'plan', 'dontAsk', 'acceptEdits', 'auto', 'bypassPermissions'];

// Modes that lift the sandbox / all permission checks. They are inherited, but a
// person has to confirm each request and the model may not send to them by default.
const ELEVATED = new Set(['danger-full-access', 'bypassPermissions']);

// Codex state DB `threads.sandbox_policy`: either the legacy {"type": "<mode>"} or the
// newer {"type":"managed","file_system":{"type":"restricted","entries":[{access}]}}.
export function codexSandboxFromDb(value) {
  let p = value;
  if (typeof p === 'string') {
    try {
      p = JSON.parse(p);
    } catch {
      return CODEX_SANDBOXES.includes(value) ? { sandbox: value } : null;
    }
  }
  if (!p || typeof p !== 'object') return null;
  if (CODEX_SANDBOXES.includes(p.type)) return { sandbox: p.type, network: typeof p.network_access === 'boolean' ? p.network_access : null };
  if (p.type === 'managed' && p.file_system) {
    const fsys = p.file_system;
    const network = p.network === 'enabled' ? true : p.network === 'restricted' ? false : null;
    if (fsys.type !== 'restricted') return { sandbox: 'danger-full-access', network };
    const writes = (fsys.entries || []).some((e) => e?.access === 'write');
    return { sandbox: writes ? 'workspace-write' : 'read-only', network };
  }
  return null;
}

// Latest turn_context in rollout records, else the DB row, else the most restrictive.
export function codexPermission(records, session = {}) {
  let tc = null;
  for (const o of records || []) if (o?.type === 'turn_context' && o.payload) tc = o.payload;
  let sandbox = null;
  let network = null;
  let approval = null;
  let source = 'fallback';
  if (tc && CODEX_SANDBOXES.includes(tc.sandbox_policy?.type)) {
    sandbox = tc.sandbox_policy.type;
    network = typeof tc.sandbox_policy.network_access === 'boolean' ? tc.sandbox_policy.network_access : null;
    approval = typeof tc.approval_policy === 'string' ? tc.approval_policy : null;
    source = 'session';
  } else {
    const db = codexSandboxFromDb(session.sandboxPolicy);
    if (db) {
      ({ sandbox, network = null } = db);
      approval = session.approvalMode || null;
      source = 'database';
    }
  }
  if (!sandbox) sandbox = 'read-only';
  return {
    agent: 'codex',
    sandbox,
    network,
    approval, // what the session used; headless turns always run with approval "never"
    elevated: ELEVATED.has(sandbox),
    source,
    label: `${sandbox}${sandbox === 'workspace-write' && network ? ' + ネットワーク' : ''} / 承認なし（承認が必要な操作は失敗）`,
  };
}

export function claudePermission(records) {
  let mode = null;
  for (const o of records || []) if (o?.type === 'user' && typeof o.permissionMode === 'string') mode = o.permissionMode;
  const known = CLAUDE_MODES.includes(mode);
  const m = known ? mode : 'default';
  return {
    agent: 'claude',
    mode: m,
    elevated: ELEVATED.has(m),
    source: known ? 'session' : 'fallback',
    label: `permission-mode ${m}${m === 'default' || m === 'manual' ? '（確認が必要なツールは拒否）' : ''}`,
  };
}

export function permissionFor(session, records) {
  return session.agent === 'codex' ? codexPermission(records, session) : claudePermission(records);
}

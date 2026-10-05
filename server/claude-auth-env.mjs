// A selected Claude profile must not inherit a different account/API gateway.
export const CLAUDE_AUTH_OVERRIDES = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDECODE',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_CLIENT_ID',
  'CLAUDE_CODE_CUSTOM_OAUTH_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_ACCOUNT_UUID', 'CLAUDE_CODE_ORGANIZATION_UUID',
  'CLAUDE_CODE_USER_EMAIL',
];
export const claudeAuthOverrides = (env = process.env) => [...new Set([
  ...CLAUDE_AUTH_OVERRIDES,
  ...Object.keys(env).filter(key => /^CLAUDE_CODE_|^CLAUDE_(BG|PTY)_/.test(key)),
])];
export function isolatedClaudeEnvironment(env, homeDir) {
  const out = { ...env };
  for (const key of claudeAuthOverrides(env)) delete out[key];
  out.CLAUDE_CONFIG_DIR = homeDir;
  return out;
}

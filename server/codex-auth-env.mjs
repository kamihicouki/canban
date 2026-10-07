// Keep resume, headless execution, login and usage on the selected home.
export const CODEX_AUTH_OVERRIDES = [
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT_ID', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN',
];

export function isolatedCodexEnvironment(env, homeDir) {
  const out = { ...env };
  for (const key of CODEX_AUTH_OVERRIDES) delete out[key];
  delete out.CODEX_HOME;
  if (homeDir) out.CODEX_HOME = homeDir;
  return out;
}

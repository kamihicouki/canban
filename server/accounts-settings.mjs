// Account settings (pure: normalized on every board read, stored in board.json as
// settings.accounts). See server/accounts.mjs for what they drive.
//   labels   { key: name }                display names
//   marks    { key: { short, color } }    initial and color in the header rings / card chips
//   hidden   [key]                        accounts left out of the header rings
//   claudeHomes / codexHomes [path]       extra CLAUDE_CONFIG_DIR / CODEX_HOME folders
//   discover boolean                      find ~/.claude-*, ~/.codex-*, desktop profiles
// Keys are `<agent>:<account id>`.

export const ACCOUNT_KEY = /^(codex|claude):[A-Za-z0-9._@:-]{1,128}$/;
// Account colors avoid green / orange / red, which the usage rings use for how full they are.
export const ACCOUNT_COLORS = ['blue', 'purple', 'pink', 'sky', 'lime', 'yellow', 'gray'];

export function defaultAccounts() {
  // marks: { key: { short, color } } tell accounts apart in the header; hidden: keys left out of it.
  return { labels: {}, marks: {}, hidden: [], claudeHomes: [], codexHomes: [], discover: true, refresh: { enabled: true, intervalMinutes: 5 }, usage: {}, profiles: [] };
}

const timestamp = (v) => Number.isFinite(v) && v > 0 ? v : null;
const PLANS = new Set(['free', 'go', 'plus', 'pro', 'prolite', 'promax', 'max', 'team', 'business', 'self_serve_business_prolite', 'self_serve_business_usage_based', 'ent26', 'enterprise_cbp_automation', 'enterprise_cbp_usage_based', 'enterprise', 'edu', 'edu_pro', 'unknown']);
const usageWindow = (w) => w && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100
  ? { usedPercent: w.usedPercent, windowMinutes: Number.isFinite(w.windowMinutes) && w.windowMinutes > 0 ? w.windowMinutes : null, resetsAt: timestamp(w.resetsAt) } : null;
export function normalizeUsage(values) {
  const out = {};
  for (const [key, v] of Object.entries(values || {}).slice(0, 50)) {
    if (!ACCOUNT_KEY.test(key) || !v || typeof v !== 'object') continue;
    out[key] = { at: timestamp(v.at), attemptedAt: timestamp(v.attemptedAt), status: v.status === 'ok' ? 'ok' : 'error',
      code: ['login_required', 'unsupported', 'identity_changed', 'unavailable', 'timeout', 'rate_limited'].includes(v.code) ? v.code : null,
      primary: usageWindow(v.primary), secondary: usageWindow(v.secondary), source: 'live',
      plan: PLANS.has(v.plan) ? v.plan : null };
  }
  return out;
}

function normalizeHomes(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((p) => String(p || '').trim().replace(/\/+$/, '')).filter((p) => p.startsWith('/') || p.startsWith('~/')))].slice(0, 10);
}
export function normalizeAccounts(x) {
  const labels = {};
  for (const [k, v] of Object.entries(x?.labels && typeof x.labels === 'object' ? x.labels : {})) {
    const name = String(v ?? '').trim().slice(0, 60);
    if (ACCOUNT_KEY.test(k) && name) labels[k] = name;
  }
  const marks = {};
  for (const [k, v] of Object.entries(x?.marks && typeof x.marks === 'object' ? x.marks : {})) {
    if (!ACCOUNT_KEY.test(k) || !v || typeof v !== 'object') continue;
    const short = [...String(v.short ?? '').trim()].slice(0, 2).join('');
    const color = ACCOUNT_COLORS.includes(v.color) ? v.color : null;
    if (short || color) marks[k] = { ...(short ? { short } : {}), ...(color ? { color } : {}) };
  }
  const hidden = [...new Set((Array.isArray(x?.hidden) ? x.hidden : []).filter((k) => typeof k === 'string' && ACCOUNT_KEY.test(k)))].slice(0, 50);
  const interval = Number(x?.refresh?.intervalMinutes);
  const refresh = { enabled: x?.refresh?.enabled !== false, intervalMinutes: Number.isInteger(interval) && interval >= 1 && interval <= 1440 ? interval : 5 };
  const profiles = (Array.isArray(x?.profiles) ? x.profiles : []).filter((p) => p && /^[a-f0-9-]{36}$/.test(p.id) && ['claude', 'codex'].includes(p.agent) && typeof p.dir === 'string' && p.dir.startsWith('/')).slice(0, 20).map((p) => ({
    id: p.id, agent: p.agent, dir: p.dir, key: ACCOUNT_KEY.test(p.key) ? p.key : null,
    expectedKey: ACCOUNT_KEY.test(p.expectedKey) ? p.expectedKey : null, pending: p.pending === true, startedAt: timestamp(p.startedAt),
  }));
  return { labels, marks, hidden, claudeHomes: normalizeHomes(x?.claudeHomes), codexHomes: normalizeHomes(x?.codexHomes), discover: x?.discover !== false,
    refresh, usage: normalizeUsage(x?.usage), profiles };
}

// A change from the board: { label: { key, name } } renames ('' clears); { mark: { key, short, color } }
// sets the initial / color ('' / null clears); { visible: { key, on } } shows or hides it in the
// header; claudeHomes / codexHomes / discover replace. Returns the unnormalized next value.
export function applyAccountPatch(cur, { label, mark, visible, claudeHomes, codexHomes, discover, refresh, usage, profile, removeProfile } = {}) {
  const check = (key) => {
    if (typeof key !== 'string' || !ACCOUNT_KEY.test(key)) throw new Error('アカウントが不正です');
  };
  const a = { ...cur, labels: { ...cur.labels }, marks: { ...cur.marks }, hidden: [...cur.hidden] };
  if (label) {
    check(label.key);
    a.labels[label.key] = label.name;
  }
  if (mark) {
    check(mark.key);
    const m = { ...(a.marks[mark.key] || {}) };
    if (mark.short !== undefined) m.short = mark.short;
    if (mark.color !== undefined) m.color = mark.color;
    a.marks[mark.key] = m;
  }
  if (visible) {
    check(visible.key);
    a.hidden = visible.on ? a.hidden.filter((k) => k !== visible.key) : [...a.hidden, visible.key];
  }
  if (claudeHomes !== undefined) a.claudeHomes = claudeHomes;
  if (codexHomes !== undefined) a.codexHomes = codexHomes;
  if (discover !== undefined) a.discover = discover;
  if (refresh !== undefined) {
    if (refresh.intervalMinutes !== undefined && (!Number.isInteger(refresh.intervalMinutes) || refresh.intervalMinutes < 1 || refresh.intervalMinutes > 1440)) throw new Error('更新間隔は 1〜1440 分で指定してください');
    a.refresh = { ...cur.refresh, ...refresh };
  }
  // These two patches are server-internal; the public settings tool does not accept them.
  if (usage) a.usage = { ...cur.usage, ...normalizeUsage(usage) };
  if (profile) a.profiles = [...(cur.profiles || []).filter((p) => p.id !== profile.id), profile];
  if (removeProfile) a.profiles = (cur.profiles || []).filter((p) => p.id !== removeProfile);
  return a;
}

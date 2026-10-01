// Account settings (pure: normalized on every board read, stored in board.json as
// settings.accounts). See server/accounts.mjs for what they drive.
//   labels   { key: name }                display names
//   marks    { key: { short, color } }    initial and color in the header rings / card chips
//   hidden   [key]                        accounts left out of the header rings
//   claudeHomes / codexHomes [path]       extra CLAUDE_CONFIG_DIR / CODEX_HOME folders
//   discover boolean                      find ~/.claude-*, ~/.codex-*, desktop profiles
//   runner   { enabled, shareProjects, shareConfig, limitAt }   Canban-made account folders (server/runner.mjs)
// Keys are `<agent>:<account id>`.

export const ACCOUNT_KEY = /^(codex|claude):[A-Za-z0-9._@:-]{1,128}$/;
// Account colors avoid green / orange / red, which the usage rings use for how full they are.
export const ACCOUNT_COLORS = ['blue', 'purple', 'pink', 'sky', 'lime', 'yellow', 'gray'];

export function defaultAccounts() {
  // marks: { key: { short, color } } tell accounts apart in the header; hidden: keys left out of it.
  return { labels: {}, marks: {}, hidden: [], claudeHomes: [], codexHomes: [], discover: true, runner: defaultRunner() };
}

function normalizeHomes(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((p) => String(p || '').trim().replace(/\/+$/, '')).filter((p) => p.startsWith('/') || p.startsWith('~/')))].slice(0, 10);
}
// The account runner is off until turned on: nothing is written for the agents before that.
export function defaultRunner() {
  return { enabled: false, shareProjects: true, shareConfig: true, limitAt: 95 };
}
function normalizeRunner(r) {
  const d = defaultRunner();
  const limit = Number(r?.limitAt);
  return {
    enabled: r?.enabled === true,
    shareProjects: r?.shareProjects !== undefined ? !!r.shareProjects : d.shareProjects,
    shareConfig: r?.shareConfig !== undefined ? !!r.shareConfig : d.shareConfig,
    limitAt: Number.isFinite(limit) ? Math.min(100, Math.max(50, Math.round(limit))) : d.limitAt,
  };
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
  return { labels, marks, hidden, claudeHomes: normalizeHomes(x?.claudeHomes), codexHomes: normalizeHomes(x?.codexHomes), discover: x?.discover !== false, runner: normalizeRunner(x?.runner) };
}

// A change from the board: { label: { key, name } } renames ('' clears); { mark: { key, short, color } }
// sets the initial / color ('' / null clears); { visible: { key, on } } shows or hides it in the
// header; claudeHomes / codexHomes / discover replace. Returns the unnormalized next value.
export function applyAccountPatch(cur, { label, mark, visible, claudeHomes, codexHomes, discover, runner } = {}) {
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
  if (runner && typeof runner === 'object') a.runner = { ...cur.runner, ...runner };
  return a;
}

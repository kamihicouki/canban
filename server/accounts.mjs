// Accounts and config homes (read-only).
//
// Homes: an agent's config folder. Besides the default (~/.claude, ~/.codex or the
// env override) a user may run other accounts from their own folder through
// CLAUDE_CONFIG_DIR / CODEX_HOME. Those are found automatically (~/.claude-*,
// ~/.claude-profiles/*, ~/.codex-* holding session data) or added in the settings.
//
// Accounts: who ran a session. Canban lists every account's sessions together, so
// switching accounts in an app does not hide anything here.
//   Claude  the desktop app keeps sessions under claude-code-sessions/<account>/<org>/;
//           each home's .claude.json names the account its CLI is signed in to.
//           Several desktop profiles (Application Support/Claude-*, Claude-Profiles/*,
//           each its own app data folder) are read as well; folders shared between
//           accounts through symlinks are read once and belong to their real location.
//   Codex   threads.creator_account_id; each home's auth.json names its account
//           (only the id, e-mail and plan are read — never a token).
// Sessions without a recorded account are attributed to their home's account when
// the home is not the default one (a profile folder normally serves one account).
//
// Usage: Codex rate limits per account come from the logs (signals.mjs); Claude's
// 5-hour / weekly usage per organization from each desktop profile's plan-usage-history.json.
import os from 'node:os';
import path from 'node:path';
import { exists, listDir, listSubdirs, readJson, realpath, stat } from './sources/readonly.mjs';

const DISCOVER_TTL_MS = 60e3;
const MAX_HOMES = 12;

// ---- homes -------------------------------------------------------------------
let config = { claudeHomes: [], codexHomes: [], discover: true };
let discovered = { at: 0, claude: [], codex: [] };

export function defaultClaudeHome() {
  return process.env.CANBAN_CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}
export function defaultCodexHome() {
  return process.env.CANBAN_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}
export function claudeDesktopSessionsDir() {
  return process.env.CANBAN_CLAUDE_DESKTOP_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
}

// Claude desktop app data folders: the default one (next to claude-code-sessions) and
// other profiles beside it, one per real folder. { id, dir, sessionsDir, default }
let desktopCache = { at: 0, roots: [] };
export async function claudeDesktopRoots(now = Date.now()) {
  if (now - desktopCache.at < DISCOVER_TTL_MS) return desktopCache.roots;
  const sessionsDir = claudeDesktopSessionsDir();
  const def = path.dirname(sessionsDir);
  const defReal = (await realpath(def)) || def;
  // name: the profile's folder name when the default folder is a link to one (a profile switcher).
  const roots = [{ id: 'default', dir: def, sessionsDir, default: true, name: defReal !== def ? path.basename(defReal) : null }];
  const seen = new Set([defReal]);
  if (config.discover) {
    const parent = path.dirname(def);
    const cands = [];
    for (const name of await listSubdirs(parent)) {
      if (name === 'Claude-Profiles') for (const p of await listSubdirs(path.join(parent, name))) !p.startsWith('_') && cands.push([`${name}/${p}`, path.join(parent, name, p)]);
      else if (/^Claude-/.test(name)) cands.push([name, path.join(parent, name)]);
    }
    for (const [id, dir] of cands) {
      if (roots.length >= MAX_HOMES || !exists(path.join(dir, 'config.json'))) continue;
      const real = (await realpath(dir)) || dir;
      if (seen.has(real)) continue;
      seen.add(real);
      roots.push({ id, dir, sessionsDir: path.join(dir, 'claude-code-sessions'), default: false, name: path.basename(real).replace(/^Claude-/, '') });
    }
  }
  desktopCache = { at: now, roots };
  return roots;
}

// Every <account>/<org> session folder of every desktop profile, once per real folder.
// owner: the account whose folder it really is; reach: accounts that see it (links).
export async function claudeDesktopFolders() {
  const byReal = new Map();
  for (const r of await claudeDesktopRoots()) {
    for (const a of await listSubdirs(r.sessionsDir)) {
      for (const b of await listSubdirs(path.join(r.sessionsDir, a))) {
        const dir = path.join(r.sessionsDir, a, b);
        const real = (await realpath(dir)) || dir;
        const f = byReal.get(real) || { dir, real, owner: null, org: null, reach: new Set(), orgs: new Map() };
        f.reach.add(a);
        f.orgs.set(b, a);
        if (dir === real) Object.assign(f, { dir, owner: a, org: b });
        byReal.set(real, f);
      }
    }
  }
  for (const f of byReal.values()) {
    if (f.owner) continue;
    // Reached only through links: the real path still names its account and org.
    const org = path.basename(f.real);
    const acct = path.basename(path.dirname(f.real));
    const known = f.orgs.get(org) === acct || f.reach.has(acct);
    Object.assign(f, known ? { owner: acct, org } : { owner: [...f.reach][0], org: [...f.orgs.keys()][0] });
  }
  return [...byReal.values()];
}

// Settings → homes (called with state.settings.accounts whenever the board state is read).
export function configureAccounts(s = {}) {
  const same = JSON.stringify([s.claudeHomes, s.codexHomes, s.discover]) === JSON.stringify([config.claudeHomes, config.codexHomes, config.discover]);
  config = { claudeHomes: s.claudeHomes || [], codexHomes: s.codexHomes || [], discover: s.discover !== false };
  if (!same) discovered.at = desktopCache.at = 0;
  return !same;
}

// Automatic discovery only looks at the user's own home folder, and is off while a
// test (or the user) pins the homes through CANBAN_*_HOME.
async function discover(now = Date.now()) {
  if (now - discovered.at < DISCOVER_TTL_MS) return discovered;
  const out = { at: now, claude: [], codex: [] };
  const pinned = process.env.CANBAN_CLAUDE_HOME || process.env.CANBAN_CODEX_HOME;
  if (config.discover && !pinned) {
    const home = os.homedir();
    for (const e of await listDir(home)) {
      if (!e.isDirectory()) continue;
      const dir = path.join(home, e.name);
      if (/^\.claude-/.test(e.name)) {
        if (e.name === '.claude-profiles') {
          for (const p of await listDir(dir)) if (p.isDirectory() && isClaudeHome(path.join(dir, p.name))) out.claude.push(path.join(dir, p.name));
        } else if (isClaudeHome(dir)) out.claude.push(dir);
      } else if (/^\.codex-/.test(e.name) && (await isCodexHome(dir))) out.codex.push(dir);
    }
  }
  discovered = out;
  return out;
}
const isClaudeHome = (dir) => exists(path.join(dir, 'projects')) && exists(path.join(dir, '.claude.json'));
async function isCodexHome(dir) {
  return (await listDir(dir)).some((e) => /^state_\d+\.sqlite$/.test(e.name));
}

function slug(dir, taken) {
  const base = path.basename(dir).replace(/^\.+/, '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) || 'home';
  let id = base;
  for (let i = 2; taken.has(id) || id === 'default'; i++) id = `${base}-${i}`;
  taken.add(id);
  return id;
}

function buildHomes(agent, def, extra, found) {
  const norm = (p) => path.resolve(String(p).replace(/^~(?=\/|$)/, os.homedir()));
  const seen = new Set([norm(def)]);
  const taken = new Set();
  const homes = [{ id: 'default', agent, dir: def, default: true, source: 'default' }];
  for (const [list, source] of [[extra, 'settings'], [found, 'discovered']]) {
    for (const p of list) {
      const dir = norm(p);
      if (seen.has(dir) || homes.length >= MAX_HOMES) continue;
      seen.add(dir);
      homes.push({ id: slug(dir, taken), agent, dir, default: false, source, missing: !exists(dir) });
    }
  }
  return homes;
}

export async function claudeHomes() {
  const d = await discover();
  return buildHomes('claude', defaultClaudeHome(), config.claudeHomes, d.claude);
}
export async function codexHomes() {
  const d = await discover();
  return buildHomes('codex', defaultCodexHome(), config.codexHomes, d.codex);
}

// Environment for running the agent's CLI against a session's home.
export function homeEnv(session) {
  if (!session?.homeDir) return {};
  return session.agent === 'codex' ? { CODEX_HOME: session.homeDir } : { CLAUDE_CONFIG_DIR: session.homeDir };
}

// ---- account files (mtime-cached) ------------------------------------------------
const fileCache = new Map(); // path -> { mtimeMs, size, value }
async function cachedJson(file, pick) {
  const st = await stat(file);
  if (!st) return null;
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
  let value = null;
  try {
    value = pick(await readJson(file));
  } catch {
    return hit?.value ?? null; // mid-write: keep what we had
  }
  fileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

const str = (v, n = 200) => (typeof v === 'string' && v ? v.slice(0, n) : null);

// The CLI's signed-in account of a Claude home. The default ~/.claude keeps it in
// ~/.claude.json; a CLAUDE_CONFIG_DIR home keeps it inside the folder.
function claudeJsonPath(home) {
  const legacy = path.join(os.homedir(), '.claude');
  return home.default && path.resolve(home.dir) === legacy && !process.env.CLAUDE_CONFIG_DIR ? path.join(os.homedir(), '.claude.json') : path.join(home.dir, '.claude.json');
}
async function claudeHomeAccount(home) {
  return cachedJson(claudeJsonPath(home), (j) => {
    const a = j?.oauthAccount;
    if (!a || !str(a.accountUuid)) return null;
    return { id: a.accountUuid, email: str(a.emailAddress), name: str(a.displayName) || str(a.fullName), orgId: str(a.organizationUuid), orgName: str(a.organizationName) };
  });
}

function jwtClaims(token) {
  try {
    const part = String(token).split('.')[1];
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}
async function codexHomeAccount(home) {
  return cachedJson(path.join(home.dir, 'auth.json'), (j) => {
    const t = j?.tokens;
    if (t && str(t.account_id)) {
      const c = jwtClaims(t.id_token) || {};
      const auth = c['https://api.openai.com/auth'] || {};
      return { id: t.account_id, email: str(c.email), name: str(c.name), plan: str(auth.chatgpt_plan_type, 40) };
    }
    if (j?.OPENAI_API_KEY || j?.auth_mode === 'apikey') return { id: 'apikey', email: null, name: 'API キー', plan: null };
    return null;
  });
}

// Claude desktop: accounts, the org folders they see, and who is signed in to each profile.
async function desktopAccounts() {
  const roots = await claudeDesktopRoots();
  const folders = await claudeDesktopFolders();
  const accounts = new Map(); // account -> Set(org)
  for (const f of folders) {
    for (const [org, acct] of f.orgs) (accounts.get(acct) || accounts.set(acct, new Set()).get(acct)).add(org);
    if (f.owner) (accounts.get(f.owner) || accounts.set(f.owner, new Set()).get(f.owner)).add(f.org);
  }
  const active = new Map(); // profile id -> account
  const profileName = new Map(); // account -> desktop profile name (a label when nothing better is known)
  const usage = {};
  for (const r of roots) {
    const a = await cachedJson(path.join(r.dir, 'config.json'), (j) => str(j?.lastKnownAccountUuid));
    if (a) active.set(r.id, a);
    if (a && r.name && !profileName.has(a)) profileName.set(a, r.name);
    for (const [org, v] of Object.entries((await claudePlanUsage(r.dir)) || {})) if (!usage[org] || v.at > usage[org].at) usage[org] = v;
  }
  return { accounts, active, usage, profileName };
}

// Latest Claude plan usage per organization in one profile: { orgId -> { at, u } }.
async function claudePlanUsage(dir) {
  return cachedJson(path.join(dir, 'plan-usage-history.json'), (j) => {
    const by = {};
    for (const x of Array.isArray(j?.samples) ? j.samples : []) {
      if (!x || typeof x.org !== 'string' || !x.u || typeof x.t !== 'number' || !Object.keys(x.u).length) continue;
      if (!by[x.org] || x.t > by[x.org].at) by[x.org] = { at: x.t, u: x.u };
    }
    return by;
  });
}

// ---- registry --------------------------------------------------------------------
let registry = { at: 0, accounts: new Map(), homes: { claude: [], codex: [] }, desktopActive: null, orgToAccount: new Map(), planUsage: {} };
const REFRESH_MS = 3000;

export const accountKey = (agent, id) => (id ? `${agent}:${id}` : null);

function upsert(map, agent, id, patch) {
  const key = accountKey(agent, id);
  const cur = map.get(key) || { key, agent, id, email: null, name: null, orgId: null, orgName: null, plan: null, profile: null, signedIn: [], homes: [] };
  for (const [k, v] of Object.entries(patch)) {
    if (Array.isArray(v)) cur[k] = [...new Set([...cur[k], ...v])];
    else if (v != null && cur[k] == null) cur[k] = v;
  }
  map.set(key, cur);
  return cur;
}

// Re-read the account files (cheap: all mtime-cached). Called before each listing.
export async function refreshAccounts({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - registry.at < REFRESH_MS) return registry;
  const [ch, xh, desk] = await Promise.all([claudeHomes(), codexHomes(), desktopAccounts()]);
  const map = new Map();
  const orgToAccount = new Map();
  const homes = { claude: [], codex: [] };
  for (const h of ch) {
    const a = await claudeHomeAccount(h);
    homes.claude.push({ ...h, account: accountKey('claude', a?.id) });
    if (a) {
      upsert(map, 'claude', a.id, { ...a, signedIn: [`cli:${h.id}`], homes: [h.id] });
      if (a.orgId) orgToAccount.set(a.orgId, accountKey('claude', a.id));
    }
  }
  for (const [id, orgs] of desk.accounts) {
    const signedIn = [...desk.active].filter(([, a]) => a === id).map(([p]) => (p === 'default' ? 'desktop' : `desktop:${p}`));
    upsert(map, 'claude', id, { signedIn, orgId: [...orgs][0] || null, profile: desk.profileName.get(id) || null });
  }
  // <account>/<org> names the org's account, also when the folder is a link to another one.
  for (const [id, orgs] of desk.accounts) for (const o of orgs) if (!orgToAccount.has(o)) orgToAccount.set(o, accountKey('claude', id));
  for (const h of xh) {
    const a = await codexHomeAccount(h);
    homes.codex.push({ ...h, account: accountKey('codex', a?.id) });
    if (a) upsert(map, 'codex', a.id, { ...a, signedIn: [`cli:${h.id}`], homes: [h.id] });
  }
  registry = { at: now, accounts: map, homes, desktopActive: accountKey('claude', desk.active.get('default')), orgToAccount, planUsage: desk.usage };
  return registry;
}

export function homeAccount(agent, homeId) {
  return registry.homes[agent]?.find((h) => h.id === (homeId || 'default'))?.account || null;
}

// The account a session belongs to (see the header). Adds unknown ids to the registry.
export function sessionAccount(s) {
  if (s.host?.local === false) return null;
  const known = s.agent === 'claude' ? accountKey('claude', s.desktopAccount) : accountKey('codex', s.creatorAccount);
  const key = known || (s.home ? homeAccount(s.agent, s.home) : null);
  if (key && !registry.accounts.has(key)) upsert(registry.accounts, s.agent, key.slice(s.agent.length + 1), {});
  return key;
}

// Codex sessions without a recorded account ran as whoever the home is signed in to.
export function limitsAccount(s) {
  return s.account || homeAccount(s.agent, s.home);
}

// The Claude desktop app (the default profile, which handles claude:// links) shows only
// the sessions in the signed-in account's folders; a linked folder shows in both.
export function desktopAccountMismatch(s) {
  if (s.agent !== 'claude' || !s.desktopAccount || !registry.desktopActive) return null;
  const reach = (s.desktopReach?.length ? s.desktopReach : [s.desktopAccount]).map((a) => accountKey('claude', a));
  if (reach.includes(registry.desktopActive)) return null;
  return { session: s.account || reach[0], active: registry.desktopActive };
}

// ---- views -----------------------------------------------------------------------
function shortId(id) {
  return id === 'apikey' ? 'API キー' : String(id).slice(0, 8);
}
export function accountLabel(key, labels = {}) {
  if (!key) return null;
  const a = registry.accounts.get(key);
  return labels[key] || a?.email || a?.name || a?.profile || a?.orgName || shortId(key.split(':').slice(1).join(':'));
}

// Plan usage windows (Claude's keys; unknown keys are ignored).
const CLAUDE_WINDOWS = { fh: 300, sd: 10080 };
function claudeLimits(accountKeyOf) {
  const out = [];
  for (const [org, v] of Object.entries(registry.planUsage)) {
    const key = accountKeyOf(org);
    if (!key) continue;
    const win = (k) => (typeof v.u[k] === 'number' ? { usedPercent: v.u[k], windowMinutes: CLAUDE_WINDOWS[k], resetsAt: null } : null);
    out.push({ key, agent: 'claude', at: v.at, primary: win('fh'), secondary: win('sd'), plan: null, source: 'desktop' });
  }
  return out;
}

// Usage per account: Codex rate limits from the logs, Claude plan usage from the desktop app.
export function accountLimits(codexLimits = new Map(), now = Date.now()) {
  const fresh = (w) => (w && w.resetsAt && w.resetsAt <= now ? { ...w, usedPercent: 0, stale: true } : w);
  const out = [];
  for (const [key, l] of codexLimits) if (key) out.push({ ...l, key, agent: 'codex', primary: fresh(l.primary), secondary: fresh(l.secondary), source: 'log' });
  out.push(...claudeLimits((org) => registry.orgToAccount.get(org)));
  return out;
}

// Accounts with their usage for the board / model. `codexLimits` maps account keys to
// the newest rate-limit snapshot seen in the logs.
// Header marks: an initial and a color per account. Unset colors are dealt out in a
// stable order (agent, then key) so the same account keeps its color.
const MARK_COLORS = ['blue', 'purple', 'pink', 'sky', 'lime', 'yellow', 'gray'];
function defaultShort(label) {
  const c = [...String(label || '').replace(/^[^\p{L}\p{N}]+/u, '')][0] || '?';
  return c.toUpperCase();
}

export function accountsView({ labels = {}, marks = {}, hidden = [], sessions = [], codexLimits = new Map(), now = Date.now() } = {}) {
  const counts = new Map();
  for (const s of sessions) {
    const k = s.account || `__none:${s.agent}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const limits = new Map(accountLimits(codexLimits, now).map((l) => [l.key, l]));
  const accounts = [...registry.accounts.values()].map((a) => ({
    key: a.key,
    agent: a.agent,
    label: accountLabel(a.key, labels),
    customLabel: labels[a.key] || null,
    email: a.email,
    name: a.name,
    orgName: a.orgName,
    profile: a.profile,
    plan: limits.get(a.key)?.plan || a.plan,
    signedIn: a.signedIn,
    homes: a.homes,
    count: counts.get(a.key) || 0,
    limits: limits.get(a.key) || null,
  }));
  accounts.sort((x, y) => (x.agent === y.agent ? y.count - x.count : x.agent === 'codex' ? -1 : 1));
  const taken = new Set(accounts.map((a) => marks[a.key]?.color).filter(Boolean));
  const free = MARK_COLORS.filter((c) => !taken.has(c));
  [...accounts].sort((x, y) => (x.agent + x.key < y.agent + y.key ? -1 : 1)).forEach((a, i) => {
    a.short = marks[a.key]?.short || defaultShort(a.label);
    a.color = marks[a.key]?.color || free[i % Math.max(free.length, 1)] || MARK_COLORS[i % MARK_COLORS.length];
    a.inHeader = !hidden.includes(a.key);
  });
  return {
    accounts,
    unknown: { codex: counts.get('__none:codex') || 0, claude: counts.get('__none:claude') || 0 },
    homes: [...registry.homes.codex, ...registry.homes.claude].map((h) => ({ id: h.id, agent: h.agent, dir: h.dir, default: h.default, source: h.source, missing: !!h.missing, account: h.account })),
    desktopActive: registry.desktopActive,
    discover: config.discover,
  };
}

export function resetAccountsForTest() {
  registry = { at: 0, accounts: new Map(), homes: { claude: [], codex: [] }, desktopActive: null, orgToAccount: new Map(), planUsage: {} };
  discovered = { at: 0, claude: [], codex: [] };
  desktopCache = { at: 0, roots: [] };
  config = { claudeHomes: [], codexHomes: [], discover: true };
  fileCache.clear();
}

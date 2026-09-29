// Combines read-only session listings (local + enabled remote hosts) with the
// Canban store into a board snapshot.
import { listCodexSessions, codexMessagesFromRecords } from './sources/codex.mjs';
import { listClaudeSessions, claudeMessagesFromRecords } from './sources/claude.mjs';
import { exists } from './sources/readonly.mjs';
import { readLines, itemsFor, foldResults } from './feed.mjs';
import { permissionFor } from './permissions.mjs';
import { RequestStore, requestSummary } from './requests.mjs';
import { listRemoteHosts } from './sources/remotes.mjs';
import { codexAppState, annotateCodexApp, codexProjectList } from './sources/codex-app.mjs';
import { LOCAL_HOST } from './sources/util.mjs';
import { RemotePool } from './remote/pool.mjs';
import { launchInfo } from './agents.mjs';
import { installedTerminals } from './launcher.mjs';
import { annotateStatus, STATUSES } from './status.mjs';
import { currentLimits, cardSignals } from './signals.mjs';
import { peekGit, refreshGit } from './gitlive.mjs';
import { RuleEngine } from './rules.mjs';
import { PrService } from './git.mjs';
import { SearchIndex } from './search.mjs';
import { resolveDirectory } from './store.mjs';
import { perf } from './perf.mjs';

const LOCAL_TTL_MS = 4000;
let localCache = null;
export const pool = new RemotePool();
export const prs = new PrService();
const PR_WINDOW_MS = 30 * 86400e3; // look up PRs for sessions active in the last 30 days

// The live watcher saw a change the listing must pick up (a new session, a desktop rename).
export function dropLocalCache() {
  localCache = null;
}

async function localSessions({ force = false } = {}) {
  if (!force && localCache && Date.now() - localCache.at < LOCAL_TTL_MS) return localCache.value;
  const [codex, claude] = await Promise.all([perf.timed('codex.list', () => listCodexSessions()), perf.timed('claude.list', () => listClaudeSessions())]);
  const value = { sessions: [...codex.sessions, ...claude.sessions], errors: [codex.error, claude.error].filter(Boolean) };
  localCache = { at: Date.now(), value };
  return value;
}

export async function hostsWithState(state) {
  const remotes = await listRemoteHosts();
  return remotes.map((h) => ({ ...h, enabled: !!state.remoteHosts?.[h.id]?.enabled, status: pool.hostStatus(h.id) }));
}

// Called with the local sessions after every listing (the live watcher indexes them).
const sessionHooks = new Set();
export function onSessions(fn) {
  sessionHooks.add(fn);
  return () => sessionHooks.delete(fn);
}

export function allSessions(state, opts) {
  return perf.timed('sessions.all', () => allSessionsImpl(state, opts));
}

async function allSessionsImpl(state, { force = false } = {}) {
  const hosts = await hostsWithState(state);
  const enabled = hosts.filter((h) => h.enabled);
  const [local, remote] = await Promise.all([localSessions({ force }), perf.timed('remote.list', () => pool.sessions(enabled, { force }))]);
  const all = [...local.sessions, ...remote];
  const app = await codexAppState();
  annotateCodexApp(all, app); // Codex projects, pins and follow-ups kept by the Codex app
  await perf.timed('status', () => annotateStatus(all));
  for (const fn of sessionHooks) fn(local.sessions);
  const now = Date.now();
  await prs.annotate(all.filter((s) => (s.updatedAt || 0) >= now - PR_WINDOW_MS || state.cards[s.id]?.listId));
  const errors = [...local.errors];
  for (const h of enabled) {
    const st = pool.hostStatus(h.id);
    if (st.state === 'error' && st.error) errors.push(`${h.label}: ${st.error}`);
  }
  return { sessions: [...local.sessions, ...remote], errors, hosts, app };
}

// Cards without an explicit order sort by recency: newest at the top.
export function effectiveOrder(session, card) {
  return typeof card?.order === 'number' ? card.order : -(session.updatedAt || 0);
}

const dirView = (d) => (d ? { id: d.id, name: d.name, color: d.color } : null);
function matchesDirectory(f, dir) {
  if (!f.directory) return true;
  return f.directory === '__none' ? !dir : dir?.id === f.directory;
}

function matches(session, card, f, labelsById, hits, dir) {
  if (f.agent && f.agent !== 'all' && session.agent !== f.agent) return false;
  if (f.host && (session.host?.id || 'local') !== f.host) return false;
  if (f.project && session.project !== f.project) return false;
  if (f.folder && session.folder !== f.folder) return false;
  if (f.section && (f.section === '__none' ? session.codexSection : session.codexSection?.id !== f.section)) return false;
  if (!matchesDirectory(f, dir)) return false;
  if (f.status && (session.status || 'idle') !== f.status) return false;
  if (!f.includeArchived && session.archived) return false;
  if (!f.includeSubagents && session.subagent) return false;
  if (!f.includeHidden && card?.hidden) return false;
  if (f.pinnedOnly && !session.pinnedInAgent) return false;
  // Sessions the user placed on the board stay visible regardless of age.
  if (f.days && !card?.listId && (session.updatedAt || 0) < Date.now() - f.days * 86400000) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    const labelNames = (card?.labels || []).map((id) => labelsById.get(id)?.name || '');
    const hay = [session.title, session.preview, session.project, dir?.name, session.branch, session.cwd, session.host?.label, card?.note, ...labelNames]
      .filter(Boolean)
      .join('\n')
      .toLowerCase();
    if (!hay.includes(q) && !hits?.has(session.id)) return false;
  }
  return true;
}

function matchesTask(t, links, status, f, labelsById, dir) {
  if (!f.includeHidden && t.hidden) return false;
  if (!matchesDirectory(f, dir)) return false;
  if (f.status && status !== f.status) return false;
  const anyLink = (pred) => links.some(pred);
  if (f.pinnedOnly && !anyLink((s) => s.pinnedInAgent)) return false;
  if (f.folder && !anyLink((s) => s.folder === f.folder)) return false;
  if (f.section && !anyLink((s) => (f.section === '__none' ? !s.codexSection : s.codexSection?.id === f.section))) return false;
  if (f.agent && f.agent !== 'all' && !(anyLink((s) => s.agent === f.agent) || t.target?.agent === f.agent)) return false;
  if (f.host && !(anyLink((s) => (s.host?.id || 'local') === f.host) || (t.target?.hostId || 'local') === f.host)) return false;
  if (f.project && !anyLink((s) => s.project === f.project)) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    const hay = [t.title, t.description, t.note, dir?.name, ...(t.labels || []).map((id) => labelsById.get(id)?.name || ''), ...links.map((s) => s.title)]
      .filter(Boolean).join('\n').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export function normalizeFilters(f = {}) {
  const days = f.days === 0 || f.days === '0' ? 0 : Number(f.days ?? 30);
  return {
    agent: ['codex', 'claude'].includes(f.agent) ? f.agent : 'all',
    host: typeof f.host === 'string' && f.host ? f.host : null,
    project: f.project || null,
    folder: typeof f.folder === 'string' && f.folder ? f.folder : null,
    section: typeof f.section === 'string' && f.section ? f.section : null,
    directory: typeof f.directory === 'string' && f.directory ? f.directory : null,
    status: STATUSES.includes(f.status) ? f.status : null,
    q: typeof f.q === 'string' ? f.q.trim() : '',
    includeArchived: !!f.includeArchived,
    includeSubagents: !!f.includeSubagents,
    includeHidden: !!f.includeHidden,
    pinnedOnly: !!f.pinnedOnly,
    groupBranch: !!f.groupBranch,
    fulltext: !!f.fulltext,
    days: Number.isFinite(days) && days > 0 ? days : 0,
  };
}

function hostView(h) {
  return { id: h.id, alias: h.alias, label: h.label, local: false, enabled: h.enabled, status: pool.hostStatus(h.id) };
}

const searches = new Map();
export function searchFor(store) {
  if (!searches.has(store.dir)) searches.set(store.dir, new SearchIndex(store.dir));
  return searches.get(store.dir);
}

// Background indexing step for full-text search (local sessions).
export function tickSearch(...args) {
  return perf.timed('tick.search', () => tickSearchImpl(...args));
}

async function tickSearchImpl(store) {
  const state = store.load();
  const { sessions } = await allSessions(state);
  return searchFor(store).step(sessions);
}

// Full-text hits: id -> snippet (local index + enabled remote hosts).
async function fullTextHits(store, q, hosts) {
  const hits = new Map(searchFor(store).query(q).map((r) => [r.id, r.snippet]));
  const enabled = hosts.filter((h) => h.enabled);
  const remote = await Promise.all(enabled.map((h) => pool.search(h, q).catch(() => new Set())));
  for (const ids of remote) for (const id of ids) if (!hits.has(id)) hits.set(id, null);
  return hits;
}

const engines = new WeakMap();
function engineFor(store) {
  if (!engines.has(store)) engines.set(store, new RuleEngine(store));
  return engines.get(store);
}

function listResolver(state) {
  const ids = new Set(state.lists.map((l) => l.id));
  return (id) => {
    const l = state.cards[id]?.listId;
    return l && ids.has(l) ? l : state.defaultListId;
  };
}

// ---- task cards ----------------------------------------------------------
export function taskEntries(state) {
  return Object.entries(state.cards).filter(([, c]) => c.kind === 'task');
}

// session id -> task id for sessions linked to a task card
export function linkedToTask(state) {
  const m = new Map();
  for (const [id, t] of taskEntries(state)) for (const sid of t.links || []) m.set(sid, id);
  return m;
}

const PENDING_MS = 3600e3;
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const sameCwd = (a, b) => !!a && !!b && a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

// Match sessions started from task cards ("pending" launches) to the sessions that appeared.
export function matchPending(state, sessions) {
  const used = new Set(linkedToTask(state).keys());
  const resolved = [];
  for (const [taskId, t] of taskEntries(state)) {
    for (const p of t.pending || []) {
      const head = norm(p.prompt).slice(0, 40);
      const cands = sessions
        .filter((s) =>
          !used.has(s.id) &&
          s.agent === p.agent &&
          (s.host?.local === false ? s.host.id : 'local') === (p.hostId || 'local') &&
          (s.createdAt || 0) >= p.startedAt - 10e3 &&
          (s.createdAt || 0) <= p.startedAt + PENDING_MS &&
          (sameCwd(s.cwd, p.cwd) || (head && norm(s.preview).startsWith(head))))
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      if (cands[0]) {
        used.add(cands[0].id);
        resolved.push({ taskId, sessionId: cands[0].id, startedAt: p.startedAt });
      }
    }
  }
  return resolved;
}

const STATUS_RANK = { running: 4, waiting: 5, aborted: 3, completed: 2, idle: 1 };
function aggregateStatus(list) {
  return list.reduce((best, s) => (STATUS_RANK[s] > STATUS_RANK[best] ? s : best), 'idle');
}

// Evaluate the automatic-move rules against current statuses and apply the moves.
// A session linked to a task card moves the task card instead.
export async function runRules(store, state, sessions, now = Date.now()) {
  const toTask = linkedToTask(state);
  const baseListOf = listResolver(state);
  const listOf = (id) => baseListOf(toTask.get(id) || id);
  const tops = new Map();
  for (const s of sessions) {
    const l = listOf(s.id);
    const o = effectiveOrder(s, state.cards[s.id]);
    if (!tops.has(l) || o < tops.get(l)) tops.set(l, o);
  }
  const moves = await engineFor(store).evaluate({
    rules: state.settings.rules,
    sessions,
    listOf,
    topOrder: (l) => {
      const o = (tops.get(l) ?? 1000) - 1000;
      tops.set(l, o);
      return o;
    },
    now,
  });
  const seen = new Set();
  const mapped = [];
  for (const m of moves) {
    const cardId = toTask.get(m.cardId) || m.cardId;
    if (seen.has(cardId)) continue;
    seen.add(cardId);
    mapped.push({ ...m, cardId });
  }
  return store.applyAutoMoves(mapped);
}

// Background evaluation so rules work while the board is closed.
export function tickRules(...args) {
  return perf.timed('tick.rules', () => tickRulesImpl(...args));
}

async function tickRulesImpl(store) {
  let state = store.load();
  const pendingTasks = taskEntries(state).some(([, t]) => t.pending?.length);
  if (!pendingTasks && !state.settings.rules.some((r) => r.enabled)) return [];
  const { sessions } = await allSessions(state);
  if ((await store.resolvePending(matchPending(state, sessions))).length) state = store.load();
  return runRules(store, state, sessions);
}

export function buildBoard(...args) {
  return perf.timed('buildBoard', () => buildBoardImpl(...args));
}

async function buildBoardImpl(store, rawFilters = {}, { force = false } = {}) {
  const filters = normalizeFilters(rawFilters);
  let state = store.load();
  const { sessions, errors, hosts, app } = await allSessions(state, { force });
  if ((await store.resolvePending(matchPending(state, sessions))).length) state = store.load();
  if ((await runRules(store, state, sessions)).length) state = store.load();
  const byId = new Map(sessions.map((x) => [x.id, x]));
  const toTask = linkedToTask(state);
  const hits = filters.fulltext && [...filters.q].length >= 3 ? await fullTextHits(store, filters.q, hosts) : null;
  if (state.settings.seenAllAt == null) {
    await store.markAllSeen(); // first run: nothing is "new" yet
    state = store.load();
  }
  const seenAll = state.settings.seenAllAt || 0;
  const statusCounts = Object.fromEntries(STATUSES.map((k) => [k, 0]));
  const { requests: allRequests, paused } = requestsFor(store.dir).load();
  const reqs = requestSummary(allRequests, paused);
  const labelsById = new Map(state.labels.map((l) => [l.id, l]));
  const listIds = new Set(state.lists.map((l) => l.id));
  const buckets = new Map(state.lists.map((l) => [l.id, []]));
  const projects = new Map();
  const folders = new Map(); // folder names hidden behind a Codex project
  const sections = new Map(); // Codex sidebar sections
  const dirCounts = new Map();
  const hostCounts = new Map();

  for (const s of sessions) {
    const card = state.cards[s.id];
    const visibleKind = (filters.includeSubagents || !s.subagent) && (filters.includeArchived || !s.archived);
    if (visibleKind) statusCounts[s.status || 'idle']++;
    if (s.project && visibleKind) projects.set(s.project, (projects.get(s.project) || 0) + 1);
    if (s.folder && s.folder !== s.project && visibleKind) folders.set(s.folder, (folders.get(s.folder) || 0) + 1);
    if (s.codexSection) sections.set(s.codexSection.id, { ...s.codexSection, count: (sections.get(s.codexSection.id)?.count || 0) + 1 });
    if (visibleKind) hostCounts.set(s.host?.id || 'local', (hostCounts.get(s.host?.id || 'local') || 0) + 1);
    const dir = resolveDirectory(state, card, s.cwd);
    if (dir && visibleKind && !toTask.has(s.id)) dirCounts.set(dir.id, (dirCounts.get(dir.id) || 0) + 1);
    if (toTask.has(s.id)) continue; // shown inside its task card
    if (!matches(s, card, filters, labelsById, hits, dir)) continue;
    const listId = card?.listId && listIds.has(card.listId) ? card.listId : state.defaultListId;
    const kids = (s.children || []).map((id) => byId.get(id)).filter(Boolean);
    const launch = launchInfo(s);
    buckets.get(listId).push({
      id: s.id,
      agent: s.agent,
      host: s.host?.local === false ? { id: s.host.id, alias: s.host.alias, label: s.host.label } : null,
      title: s.title,
      project: s.project,
      folder: s.folder,
      codexProject: s.codexProject || null,
      directory: dirView(dir),
      cwd: s.cwd,
      branch: s.branch,
      model: s.model,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      archived: s.archived,
      subagent: s.subagent,
      automation: s.automation,
      preview: s.preview,
      prUrl: s.prUrl || null,
      canDesktop: !!launch.desktop,
      desktopExact: !!launch.desktop?.exact,
      order: effectiveOrder(s, card),
      labels: card?.labels || [],
      note: card?.note || '',
      priority: card?.priority || null,
      due: card?.due || null,
      hidden: !!card?.hidden,
      placed: !!card?.listId,
      status: s.status || 'idle',
      activity: s.activity || null,
      signals: cardSignals(s.signals),
      git: s.status === 'running' || s.status === 'waiting' ? peekGit(s.cwd) : null,
      unread: (s.updatedAt || 0) > Math.max(seenAll, card?.seenAt || 0),
      requests: reqs.get(s.id) || null,
      codexFollowUps: s.codexFollowUps || 0,
      pinnedInAgent: !!s.pinnedInAgent,
      codexSection: s.codexSection || null,
      autoMoved: card?.movedBy ? { ruleId: card.movedBy.ruleId, at: card.movedBy.at } : null,
      subagents: kids.length ? { total: kids.length, running: kids.filter((k) => k.status === 'running' || k.status === 'waiting').length } : null,
      repo: s.repo || null,
      pr: prView(s.pr),
      snippet: hits?.get(s.id) || null,
    });
  }

  // Task cards: user-created cards that may have sessions linked to them.
  const now = Date.now();
  for (const [id, t] of taskEntries(state)) {
    const links = (t.links || []).map((sid) => byId.get(sid)).filter(Boolean);
    const status = aggregateStatus(links.map((x) => x.status || 'idle'));
    const updatedAt = Math.max(t.createdAt || 0, ...links.map((x) => x.updatedAt || 0));
    const dir = resolveDirectory(state, t, t.target?.cwd || links.find((x) => x.cwd)?.cwd);
    if (dir && !t.hidden) dirCounts.set(dir.id, (dirCounts.get(dir.id) || 0) + 1);
    if (!matchesTask(t, links, status, filters, labelsById, dir)) continue;
    const listId = t.listId && listIds.has(t.listId) ? t.listId : state.defaultListId;
    buckets.get(listId).push({
      id,
      kind: 'task',
      title: t.title,
      description: t.description || '',
      directory: dirView(dir),
      project: links.find((x) => x.project)?.project || null,
      target: t.target || null,
      links: links.map((x) => ({ id: x.id, agent: x.agent, title: x.title, status: x.status || 'idle', host: x.host?.local === false ? { label: x.host.label } : null, updatedAt: x.updatedAt })),
      missingLinks: (t.links || []).length - links.length,
      pending: (t.pending || []).map((p) => ({ agent: p.agent, startedAt: p.startedAt, expired: now - p.startedAt > PENDING_MS })),
      createdAt: t.createdAt,
      updatedAt,
      order: typeof t.order === 'number' ? t.order : t.createdAt || 0,
      labels: t.labels || [],
      note: t.note || '',
      priority: t.priority || null,
      due: t.due || null,
      hidden: !!t.hidden,
      placed: true,
      status,
      unread: links.some((x) => (x.updatedAt || 0) > Math.max(seenAll, t.seenAt || 0)),
      autoMoved: t.movedBy ? { ruleId: t.movedBy.ruleId, at: t.movedBy.at } : null,
      pr: prView(links.map((x) => x.pr).find(Boolean)),
    });
  }

  const lists = state.lists.map((l) => {
    let cards = buckets.get(l.id).sort((a, b) => a.order - b.order);
    if (filters.groupBranch) cards = groupByBranch(cards);
    return { ...l, isDefault: l.id === state.defaultListId, count: cards.length, cards };
  });

  return {
    generatedAt: Date.now(),
    filters,
    lists,
    labels: state.labels,
    directories: state.directories.map((d) => ({ ...d, count: dirCounts.get(d.id) || 0 })),
    defaultListId: state.defaultListId,
    projects: [...projects.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    codexSections: [...sections.values()].sort((a, b) => b.count - a.count),
    folders: [...folders.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    codexProjects: codexProjectList(app, sessions).map(({ id, name, roots, hostId, count }) => ({ id, name, roots, hostId, count })),
    hosts: [{ ...LOCAL_HOST, enabled: true, status: { state: 'ok' }, count: hostCounts.get('local') || 0 }, ...hosts.map((h) => ({ ...hostView(h), count: hostCounts.get(h.id) || 0 }))],
    settings: state.settings,
    terminals: installedTerminals(),
    statusCounts,
    limits: currentLimits(),
    search: searchFor(store).progress,
    git: { available: prs.status.available, reason: prs.status.reason, github: prs.status.github, gitlab: prs.status.gitlab },
    folders: recentFolders(sessions),
    tasks: taskEntries(state).map(([id, t]) => ({ id, title: t.title })),
    recentAutoMoves: Object.entries(state.cards)
      .filter(([, c]) => c.movedBy && Date.now() - c.movedBy.at < 5 * 60e3)
      .map(([cardId, c]) => ({ cardId, toListId: c.listId, ruleId: c.movedBy.ruleId, at: c.movedBy.at, title: byId.get(cardId)?.title || state.cards[cardId]?.title || cardId })),
    totals: {
      sessions: sessions.length,
      codex: sessions.filter((s) => s.agent === 'codex').length,
      claude: sessions.filter((s) => s.agent === 'claude').length,
      shown: lists.reduce((n, l) => n + l.count, 0),
    },
    errors,
    perf: { slow: perf.recentSlow() },
  };
}

// Queue, history and the inherited permissions for the detail's "send" section.
function dispatchView(dir, state, cardId, permission) {
  const rs = requestsFor(dir);
  const { requests, paused } = rs.load();
  const mine = requests.filter((r) => r.cardId === cardId);
  const view = (r) => ({ ...r, logPath: r.hostId === 'local' ? r.logPath : null });
  return {
    settings: state.settings.dispatch,
    permission,
    paused: paused[cardId] || null,
    queue: mine.filter((r) => r.state === 'queued').sort((a, b) => a.order - b.order || a.createdAt - b.createdAt).map(view),
    active: mine.filter((r) => r.state === 'starting' || r.state === 'running').map(view),
    history: mine.filter((r) => !['queued', 'starting', 'running'].includes(r.state)).sort((a, b) => (b.endedAt || b.createdAt) - (a.endedAt || a.createdAt)).slice(0, 20).map(view),
  };
}

const requestStores = new Map();
export function requestsFor(dir) {
  if (!requestStores.has(dir)) requestStores.set(dir, new RequestStore(dir));
  return requestStores.get(dir);
}

export function prView(pr) {
  return pr ? { provider: pr.provider || 'github', number: pr.number, url: pr.url, title: pr.title, state: pr.state, isDraft: pr.isDraft, checks: pr.checks } : null;
}

const DEFAULT_BRANCH = new Set(['main', 'master', 'develop', 'trunk', 'HEAD', 'dev']);
export const branchKey = (s) => (s.repo && s.branch && !DEFAULT_BRANCH.has(s.branch) ? `${s.repo}#${s.branch}` : null);

// Collapse session cards that share repo + branch into the first one (in list order).
function groupByBranch(cards) {
  const lead = new Map();
  const out = [];
  for (const c of cards) {
    const k = c.kind === 'task' ? null : branchKey(c);
    if (!k) {
      out.push(c);
      continue;
    }
    const first = lead.get(k);
    if (!first) {
      const copy = { ...c, grouped: [] };
      lead.set(k, copy);
      out.push(copy);
    } else first.grouped.push({ id: c.id, title: c.title, status: c.status, agent: c.agent });
  }
  return out;
}

// Folders sessions ran in, most recent first (targets for new sessions from task cards).
function recentFolders(sessions, limit = 60) {
  const seen = new Map();
  for (const s of [...sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))) {
    if (!s.cwd || s.subagent) continue;
    const hostId = s.host?.local === false ? s.host.id : 'local';
    const key = `${hostId}\u0000${s.cwd}`;
    if (!seen.has(key)) seen.set(key, { hostId, hostLabel: s.host?.label || 'このマシン', cwd: s.cwd, project: s.project });
    if (seen.size >= limit) break;
  }
  return [...seen.values()];
}

export async function findSession(store, cardId) {
  const state = store.load();
  const { sessions, hosts } = await allSessions(state);
  const s = sessions.find((x) => x.id === cardId);
  if (!s) throw new Error(`セッションが見つかりません: ${cardId}`);
  return { session: s, state, host: s.host?.local === false ? hosts.find((h) => h.id === s.host.id) : null };
}

export function sessionDetail(...args) {
  return perf.timed('sessionDetail', () => sessionDetailImpl(...args));
}

async function sessionDetailImpl(store, cardId, { messages = 12 } = {}) {
  const { session: s, state, host } = await findSession(store, cardId);
  const card = state.cards[cardId] || {};
  let recent = [];
  let permission = null; // remote: checked when sending (saves an ssh round trip)
  let messagesError = null;
  let feed = null; // local: the live conversation and where canban_watch continues it
  try {
    if (host) recent = await pool.messages(host, s, messages);
    else if (s.sourcePath && exists(s.sourcePath)) {
      // One tail read serves the messages, the live feed and the permissions shown for sending.
      const { records, offset, size } = await readLines(s.sourcePath, { tailBytes: 768 * 1024 });
      recent = s.agent === 'codex' ? codexMessagesFromRecords(records, messages) : claudeMessagesFromRecords(records, messages);
      permission = permissionFor(s, records);
      const ctx = {};
      feed = { items: foldResults(itemsFor(s.agent, records, ctx)), offset, size, codexItems: !!ctx.items };
    }
  } catch (e) {
    messagesError = e.message;
  }
  // Local sessions: the folder's git state (one `git status`, cached by HEAD / index). A slow
  // repo does not hold the detail up; the live watch brings the state when it is ready.
  const git = !host && s.cwd ? await Promise.race([refreshGit(s.cwd).then((r) => r.value, () => null), new Promise((r) => setTimeout(() => r(peekGit(s.cwd)), 150))]) : null;
  const toTask = linkedToTask(state);
  const taskId = toTask.get(cardId) || null;
  const listCard = taskId ? state.cards[taskId] : card;
  const listId = listCard.listId && state.lists.some((l) => l.id === listCard.listId) ? listCard.listId : state.defaultListId;
  const { sessions: all } = await allSessions(state);
  const byId = new Map(all.map((x) => [x.id, x]));
  const key = branchKey(s);
  const sameBranch = key
    ? all.filter((x) => x.id !== s.id && branchKey(x) === key).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 20)
        .map((x) => ({ id: x.id, agent: x.agent, title: x.title, status: x.status || 'idle', updatedAt: x.updatedAt }))
    : [];
  const children = (s.children || []).map((id) => byId.get(id)).filter(Boolean)
    .map((c) => ({ id: c.id, title: c.title, status: c.status || 'idle', updatedAt: c.updatedAt, agentName: c.agentName || null }));
  const { host: h, ...rest } = s;
  return {
    session: { ...rest, host: h?.local === false ? { id: h.id, alias: h.alias, label: h.label } : null },
    card: {
      listId, labels: card.labels || [], note: card.note || '', priority: card.priority || null, due: card.due || null, hidden: !!card.hidden,
      directory: dirView(resolveDirectory(state, card, s.cwd)), directoryId: card.directoryId || null,
    },
    list: state.lists.find((l) => l.id === listId),
    task: taskId ? { id: taskId, title: state.cards[taskId].title } : null,
    children,
    sameBranch,
    pr: s.pr || null,
    repo: s.repo || null,
    parentId: s.parentId || null,
    tasks: taskEntries(state).map(([id, t]) => ({ id, title: t.title })),
    launch: launchInfo(s),
    settings: state.settings,
    terminals: installedTerminals(),
    recentMessages: recent,
    messagesError,
    feed,
    git,
    dispatch: dispatchView(store.dir, state, cardId, permission),
  };
}

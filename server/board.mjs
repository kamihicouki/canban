// Combines read-only session listings (local + enabled remote hosts) with the
// Canban store into a board snapshot.
import { listCodexSessions, codexSessionMessages } from './sources/codex.mjs';
import { listClaudeSessions, claudeSessionMessages } from './sources/claude.mjs';
import { listRemoteHosts } from './sources/remotes.mjs';
import { LOCAL_HOST } from './sources/util.mjs';
import { RemotePool } from './remote/pool.mjs';
import { launchInfo } from './agents.mjs';
import { installedTerminals } from './launcher.mjs';
import { annotateStatus, STATUSES } from './status.mjs';
import { RuleEngine } from './rules.mjs';
import { PrService } from './git.mjs';

const LOCAL_TTL_MS = 4000;
let localCache = null;
export const pool = new RemotePool();
export const prs = new PrService();
const PR_WINDOW_MS = 30 * 86400e3; // look up PRs for sessions active in the last 30 days

async function localSessions({ force = false } = {}) {
  if (!force && localCache && Date.now() - localCache.at < LOCAL_TTL_MS) return localCache.value;
  const [codex, claude] = await Promise.all([listCodexSessions(), listClaudeSessions()]);
  const value = { sessions: [...codex.sessions, ...claude.sessions], errors: [codex.error, claude.error].filter(Boolean) };
  localCache = { at: Date.now(), value };
  return value;
}

export async function hostsWithState(state) {
  const remotes = await listRemoteHosts();
  return remotes.map((h) => ({ ...h, enabled: !!state.remoteHosts?.[h.id]?.enabled, status: pool.hostStatus(h.id) }));
}

export async function allSessions(state, { force = false } = {}) {
  const hosts = await hostsWithState(state);
  const enabled = hosts.filter((h) => h.enabled);
  const [local, remote] = await Promise.all([localSessions({ force }), pool.sessions(enabled, { force })]);
  const all = [...local.sessions, ...remote];
  await annotateStatus(all);
  const now = Date.now();
  await prs.annotate(all.filter((s) => (s.updatedAt || 0) >= now - PR_WINDOW_MS || state.cards[s.id]?.listId));
  const errors = [...local.errors];
  for (const h of enabled) {
    const st = pool.hostStatus(h.id);
    if (st.state === 'error' && st.error) errors.push(`${h.label}: ${st.error}`);
  }
  return { sessions: [...local.sessions, ...remote], errors, hosts };
}

// Cards without an explicit order sort by recency: newest at the top.
export function effectiveOrder(session, card) {
  return typeof card?.order === 'number' ? card.order : -(session.updatedAt || 0);
}

function matches(session, card, f, labelsById) {
  if (f.agent && f.agent !== 'all' && session.agent !== f.agent) return false;
  if (f.host && (session.host?.id || 'local') !== f.host) return false;
  if (f.project && session.project !== f.project) return false;
  if (f.status && (session.status || 'idle') !== f.status) return false;
  if (!f.includeArchived && session.archived) return false;
  if (!f.includeSubagents && session.subagent) return false;
  if (!f.includeHidden && card?.hidden) return false;
  // Sessions the user placed on the board stay visible regardless of age.
  if (f.days && !card?.listId && (session.updatedAt || 0) < Date.now() - f.days * 86400000) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    const labelNames = (card?.labels || []).map((id) => labelsById.get(id)?.name || '');
    const hay = [session.title, session.preview, session.project, session.branch, session.cwd, session.host?.label, card?.note, ...labelNames]
      .filter(Boolean)
      .join('\n')
      .toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function matchesTask(t, links, status, f, labelsById) {
  if (!f.includeHidden && t.hidden) return false;
  if (f.status && status !== f.status) return false;
  const anyLink = (pred) => links.some(pred);
  if (f.agent && f.agent !== 'all' && !(anyLink((s) => s.agent === f.agent) || t.target?.agent === f.agent)) return false;
  if (f.host && !(anyLink((s) => (s.host?.id || 'local') === f.host) || (t.target?.hostId || 'local') === f.host)) return false;
  if (f.project && !anyLink((s) => s.project === f.project)) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    const hay = [t.title, t.description, t.note, ...(t.labels || []).map((id) => labelsById.get(id)?.name || ''), ...links.map((s) => s.title)]
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
    status: STATUSES.includes(f.status) ? f.status : null,
    q: typeof f.q === 'string' ? f.q.trim() : '',
    includeArchived: !!f.includeArchived,
    includeSubagents: !!f.includeSubagents,
    includeHidden: !!f.includeHidden,
    groupBranch: !!f.groupBranch,
    days: Number.isFinite(days) && days > 0 ? days : 0,
  };
}

function hostView(h) {
  return { id: h.id, alias: h.alias, label: h.label, local: false, enabled: h.enabled, status: pool.hostStatus(h.id) };
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
export async function tickRules(store) {
  let state = store.load();
  const pendingTasks = taskEntries(state).some(([, t]) => t.pending?.length);
  if (!pendingTasks && !state.settings.rules.some((r) => r.enabled)) return [];
  const { sessions } = await allSessions(state);
  if ((await store.resolvePending(matchPending(state, sessions))).length) state = store.load();
  return runRules(store, state, sessions);
}

export async function buildBoard(store, rawFilters = {}, { force = false } = {}) {
  const filters = normalizeFilters(rawFilters);
  let state = store.load();
  const { sessions, errors, hosts } = await allSessions(state, { force });
  if ((await store.resolvePending(matchPending(state, sessions))).length) state = store.load();
  if ((await runRules(store, state, sessions)).length) state = store.load();
  const byId = new Map(sessions.map((x) => [x.id, x]));
  const toTask = linkedToTask(state);
  if (state.settings.seenAllAt == null) {
    await store.markAllSeen(); // first run: nothing is "new" yet
    state = store.load();
  }
  const seenAll = state.settings.seenAllAt || 0;
  const statusCounts = Object.fromEntries(STATUSES.map((k) => [k, 0]));
  const labelsById = new Map(state.labels.map((l) => [l.id, l]));
  const listIds = new Set(state.lists.map((l) => l.id));
  const buckets = new Map(state.lists.map((l) => [l.id, []]));
  const projects = new Map();
  const hostCounts = new Map();

  for (const s of sessions) {
    const card = state.cards[s.id];
    const visibleKind = (filters.includeSubagents || !s.subagent) && (filters.includeArchived || !s.archived);
    if (visibleKind) statusCounts[s.status || 'idle']++;
    if (s.project && visibleKind) projects.set(s.project, (projects.get(s.project) || 0) + 1);
    if (visibleKind) hostCounts.set(s.host?.id || 'local', (hostCounts.get(s.host?.id || 'local') || 0) + 1);
    if (toTask.has(s.id)) continue; // shown inside its task card
    if (!matches(s, card, filters, labelsById)) continue;
    const listId = card?.listId && listIds.has(card.listId) ? card.listId : state.defaultListId;
    const kids = (s.children || []).map((id) => byId.get(id)).filter(Boolean);
    const launch = launchInfo(s);
    buckets.get(listId).push({
      id: s.id,
      agent: s.agent,
      host: s.host?.local === false ? { id: s.host.id, alias: s.host.alias, label: s.host.label } : null,
      title: s.title,
      project: s.project,
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
      unread: (s.updatedAt || 0) > Math.max(seenAll, card?.seenAt || 0),
      autoMoved: card?.movedBy ? { ruleId: card.movedBy.ruleId, at: card.movedBy.at } : null,
      subagents: kids.length ? { total: kids.length, running: kids.filter((k) => k.status === 'running' || k.status === 'waiting').length } : null,
      repo: s.repo || null,
      pr: prView(s.pr),
    });
  }

  // Task cards: user-created cards that may have sessions linked to them.
  const now = Date.now();
  for (const [id, t] of taskEntries(state)) {
    const links = (t.links || []).map((sid) => byId.get(sid)).filter(Boolean);
    const status = aggregateStatus(links.map((x) => x.status || 'idle'));
    const updatedAt = Math.max(t.createdAt || 0, ...links.map((x) => x.updatedAt || 0));
    if (!matchesTask(t, links, status, filters, labelsById)) continue;
    const listId = t.listId && listIds.has(t.listId) ? t.listId : state.defaultListId;
    buckets.get(listId).push({
      id,
      kind: 'task',
      title: t.title,
      description: t.description || '',
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
    defaultListId: state.defaultListId,
    projects: [...projects.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    hosts: [{ ...LOCAL_HOST, enabled: true, status: { state: 'ok' }, count: hostCounts.get('local') || 0 }, ...hosts.map((h) => ({ ...hostView(h), count: hostCounts.get(h.id) || 0 }))],
    settings: state.settings,
    terminals: installedTerminals(),
    statusCounts,
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
  };
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

export async function sessionDetail(store, cardId, { messages = 12 } = {}) {
  const { session: s, state, host } = await findSession(store, cardId);
  const card = state.cards[cardId] || {};
  let recent = [];
  let messagesError = null;
  try {
    if (host) recent = await pool.messages(host, s, messages);
    else recent = s.agent === 'codex' ? await codexSessionMessages(s.sourcePath, messages) : await claudeSessionMessages(s.sourcePath, messages);
  } catch (e) {
    messagesError = e.message;
  }
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
    card: { listId, labels: card.labels || [], note: card.note || '', priority: card.priority || null, due: card.due || null, hidden: !!card.hidden },
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
  };
}

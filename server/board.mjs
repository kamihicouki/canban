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

const LOCAL_TTL_MS = 4000;
let localCache = null;
export const pool = new RemotePool();

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
  await annotateStatus([...local.sessions, ...remote]);
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

// Evaluate the automatic-move rules against current statuses and apply the moves.
export async function runRules(store, state, sessions, now = Date.now()) {
  const listOf = listResolver(state);
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
  return store.applyAutoMoves(moves);
}

// Background evaluation so rules work while the board is closed.
export async function tickRules(store) {
  const state = store.load();
  if (!state.settings.rules.some((r) => r.enabled)) return [];
  const { sessions } = await allSessions(state);
  return runRules(store, state, sessions);
}

export async function buildBoard(store, rawFilters = {}, { force = false } = {}) {
  const filters = normalizeFilters(rawFilters);
  let state = store.load();
  const { sessions, errors, hosts } = await allSessions(state, { force });
  if ((await runRules(store, state, sessions)).length) state = store.load();
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
    if (!matches(s, card, filters, labelsById)) continue;
    const listId = card?.listId && listIds.has(card.listId) ? card.listId : state.defaultListId;
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
    });
  }

  const lists = state.lists.map((l) => {
    const cards = buckets.get(l.id).sort((a, b) => a.order - b.order);
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
    recentAutoMoves: Object.entries(state.cards)
      .filter(([, c]) => c.movedBy && Date.now() - c.movedBy.at < 5 * 60e3)
      .map(([cardId, c]) => ({ cardId, toListId: c.listId, ruleId: c.movedBy.ruleId, at: c.movedBy.at, title: sessions.find((x) => x.id === cardId)?.title || cardId })),
    totals: {
      sessions: sessions.length,
      codex: sessions.filter((s) => s.agent === 'codex').length,
      claude: sessions.filter((s) => s.agent === 'claude').length,
      shown: lists.reduce((n, l) => n + l.count, 0),
    },
    errors,
  };
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
  const listId = card.listId && state.lists.some((l) => l.id === card.listId) ? card.listId : state.defaultListId;
  const { host: h, ...rest } = s;
  return {
    session: { ...rest, host: h?.local === false ? { id: h.id, alias: h.alias, label: h.label } : null },
    card: { listId, labels: card.labels || [], note: card.note || '', priority: card.priority || null, due: card.due || null, hidden: !!card.hidden },
    list: state.lists.find((l) => l.id === listId),
    launch: launchInfo(s),
    settings: state.settings,
    terminals: installedTerminals(),
    recentMessages: recent,
    messagesError,
  };
}

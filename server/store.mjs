// Kanban state store. This is the only module that writes to disk, and it only
// writes inside the configured Canban data directory.
import { isMainThread, proxyStore } from './sqlite-client.mjs';
import { readBoard, writeBoard, transaction, currentFence, db, bump, readTransaction } from './sqlite-backend.mjs';
import { defaultAccounts, normalizeAccounts, applyAccountPatch } from './accounts-settings.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveDataDirectory } from './data-directory.mjs';
import { normalizeTaskDashboard, taskDashboardRecord } from './task-dashboard.mjs';
import { normalizeTaskContext } from './task-context.mjs';
import { attachSlackReference } from './slack-store.mjs';
import { loopRecord, applyLoopCommand, loopProgress } from './loop.mjs';

export const STORE_VERSION = 1;
export const LIST_COLORS = ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'purple', 'pink', 'sky', 'lime'];

export const LAUNCH_ROUTES = ['desktop', 'terminal'];
export const TERMINALS = ['ghostty', 'terminal', 'iterm'];
export const TERMINAL_TARGETS = ['new-window', 'new-tab', 'split', 'current'];

export function dataDir() {
  return resolveDataDirectory();
}

export const RULE_TRIGGERS = [
  'status:running', 'status:waiting', 'status:completed', 'status:aborted', 'activity',
  'archived',
  'pr:opened', 'pr:merged', 'pr:closed', 'ci:failed', 'ci:passed',
];
const HISTORY_MAX = 50;

export function defaultRules() {
  return [
    { id: 'rule-running-doing', enabled: false, trigger: 'status:running', fromListId: 'inbox', toListId: 'doing' },
    { id: 'rule-completed-review', enabled: false, trigger: 'status:completed', fromListId: 'doing', toListId: 'review' },
  ];
}

export function defaultSettings() {
  return {
    // How "resume" opens a session: in the agent's desktop app or in a terminal.
    launch: { route: 'desktop', terminal: 'terminal', target: 'new-window', linkBrowser: '', linkProfile: '' },
    // Automatic moves on status transitions (all off by default).
    rules: defaultRules(),
    // Cards updated after this time (and after their own seenAt) are highlighted as new.
    seenAllAt: null,
    // Saved views: named filter / swimlane presets.
    views: [],
    ignoredCategorySources: [],
    // Sending prompts to sessions (headless turns through the agents' CLIs).
    dispatch: defaultDispatch(),
    // Accounts: display names, and the agents' extra config folders (see accounts.mjs).
    accounts: defaultAccounts(),
  };
}


export function defaultDispatch() {
  return { enabled: true, maxLocal: 2, maxPerHost: 1, allowModel: true, allowModelElevated: false, modelPerHour: 10 };
}

const clampInt = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
function normalizeDispatch(x) {
  const d = defaultDispatch();
  const b = (k) => (typeof x?.[k] === 'boolean' ? x[k] : d[k]);
  return {
    enabled: b('enabled'),
    maxLocal: clampInt(x?.maxLocal, 1, 8, d.maxLocal),
    maxPerHost: clampInt(x?.maxPerHost, 1, 4, d.maxPerHost),
    allowModel: b('allowModel'),
    allowModelElevated: b('allowModelElevated'),
    modelPerHour: clampInt(x?.modelPerHour, 0, 100, d.modelPerHour),
  };
}

const VIEW_FILTER_KEYS = ['agent', 'host', 'account', 'status', 'project', 'folder', 'section', 'directory', 'label', 'laneHeight', 'q', 'days', 'includeArchived', 'includeSubagents', 'dotScope', 'pinnedOnly', 'groupBranch', 'fulltext', 'swimlane'];
function normalizeView(v) {
  if (!v || typeof v.id !== 'string' || !String(v.name || '').trim()) return null;
  const filters = {};
  for (const k of VIEW_FILTER_KEYS) if (v.filters && v.filters[k] !== undefined) filters[k] = v.filters[k];
  return { id: v.id, name: String(v.name).trim().slice(0, 60), filters };
}

// `section:<id>`: a Codex thread entered that sidebar section (Codex sections play
// the role of lists, so this keeps the two in step without managing both by hand).
export const SECTION_TRIGGER = /^section:[A-Za-z0-9-]{1,64}$/;
export const isRuleTrigger = (t) => RULE_TRIGGERS.includes(t) || (typeof t === 'string' && SECTION_TRIGGER.test(t));

function normalizeRule(r) {
  if (!r || typeof r.id !== 'string' || !isRuleTrigger(r.trigger) || typeof r.toListId !== 'string') return null;
  return {
    id: r.id,
    enabled: !!r.enabled,
    trigger: r.trigger,
    fromListId: typeof r.fromListId === 'string' && r.fromListId ? r.fromListId : 'any',
    toListId: r.toListId,
  };
}

function normalizeSettings(s) {
  const d = defaultSettings();
  const l = s?.launch || {};
  return {
    launch: {
      route: LAUNCH_ROUTES.includes(l.route) ? l.route : d.launch.route,
      terminal: TERMINALS.includes(l.terminal) ? l.terminal : d.launch.terminal,
      target: TERMINAL_TARGETS.includes(l.target) ? l.target : d.launch.target,
      // Browser for external links (Slack app settings, PRs). '' = the OS default.
      linkBrowser: ['chrome', 'safari'].includes(l.linkBrowser) ? l.linkBrowser : '',
      linkProfile: l.linkBrowser === 'chrome' && /^(Default|Profile \d+)$/.test(l.linkProfile) ? l.linkProfile : '',
    },
    rules: Array.isArray(s?.rules) ? s.rules.map(normalizeRule).filter(Boolean) : d.rules,
    seenAllAt: typeof s?.seenAllAt === 'number' ? s.seenAllAt : null,
    views: Array.isArray(s?.views) ? s.views.map(normalizeView).filter(Boolean).slice(0, 20) : [],
    ignoredCategorySources: Array.isArray(s?.ignoredCategorySources) ? [...new Set(s.ignoredCategorySources.filter(k => typeof k === 'string'))] : [],
    dispatch: normalizeDispatch(s?.dispatch),
    accounts: normalizeAccounts(s?.accounts),
  };
}

// A directory is a user-made, single-membership grouping of cards. `paths` are cwd
// prefixes whose sessions belong to it unless a card was assigned explicitly.
function normalizePaths(paths) {
  if (!Array.isArray(paths)) return [];
  return [...new Set(paths.map((p) => String(p || '').trim().replace(/\/+$/, '')).filter((p) => p.startsWith('/')))].slice(0, 20);
}
function normalizeDirectory(d) {
  if (!d || typeof d.id !== 'string' || !String(d.name || '').trim()) return null;
  return { id: d.id, name: String(d.name).trim().slice(0, 80), color: LIST_COLORS.includes(d.color) ? d.color : null, paths: normalizePaths(d.paths),
    ...(Array.isArray(d.sourceKeys) ? { sourceKeys: [...new Set(d.sourceKeys.filter(k => typeof k === 'string'))] } : {}) };
}

// Agent-owned grouping becomes a Canban category; Codex has no cwd fallback.
export function sessionCategory(session) {
  if (!session || !['codex', 'claude'].includes(session.agent)) return null;
  const host = session.host?.id || 'local';
  const group = session.agent === 'codex' ? session.codexProject : session.claudeGroup;
  const name = String(group?.name || (session.agent === 'claude' ? session.cwd?.replace(/\/+$/, '').split('/').pop() || session.cwd || '' : '')).trim().slice(0, 80);
  if (!name) return null;
  return { name, key: JSON.stringify([session.agent, host, group ? 'group' : 'cwd', group ? group.id || group.name : session.cwd]) };
}

// Explicit assignment wins ('__none' opts out), then the agent's grouping.
// Task cards and callers without source metadata retain the legacy path rules.
export function resolveDirectory(state, card, cwd, session = null) {
  const id = card?.directoryId;
  if (id === '__none') return null;
  if (id) {
    const d = (state.directories || []).find((x) => x.id === id);
    if (d) return d;
  }
  if (session && ['codex', 'claude'].includes(session.agent)) {
    const source = sessionCategory(session);
    return source ? (state.directories || []).find(d => d.sourceKeys?.includes(source.key)) || null : null;
  }
  if (!cwd) return null;
  const clean = String(cwd).replace(/\/+$/, '');
  let best = null, len = -1;
  for (const d of state.directories || []) {
    for (const p of d.paths || []) {
      if ((clean === p || clean.startsWith(`${p}/`)) && p.length > len) { best = d; len = p.length; }
    }
  }
  return best;
}
function placeCard(card, toListId, order, at = new Date().toISOString()) {
  if (card.listId !== toListId) {
    card.history = [...(card.history || []), { listId: toListId, at }].slice(-HISTORY_MAX);
  }
  card.listId = toListId;
  if (typeof order === 'number' && Number.isFinite(order)) card.order = order;
  else delete card.order;
  card.updatedAt = at;
}

export function defaultState() {
  return {
    version: STORE_VERSION,
    lists: [
      { id: 'inbox', title: '受信箱', color: 'gray', wipLimit: null },
      { id: 'doing', title: '進行中', color: 'blue', wipLimit: null },
      { id: 'review', title: 'レビュー', color: 'yellow', wipLimit: null },
      { id: 'done', title: '完了', color: 'green', wipLimit: null },
    ],
    defaultListId: 'inbox',
    labels: [
      { id: 'lbl-bug', name: 'bug', color: 'red' },
      { id: 'lbl-feature', name: 'feature', color: 'green' },
      { id: 'lbl-research', name: '調査', color: 'purple' },
      { id: 'lbl-blocked', name: 'blocked', color: 'orange' },
    ],
    directories: [],
    cards: {},
    remoteHosts: {},
    uiState: { revision: 0, state: null },
    settings: defaultSettings(),
  };
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(5).toString('hex')}`;
}

export function normalize(s) {
  const d = defaultState();
  const out = {
    version: STORE_VERSION,
    lists: Array.isArray(s?.lists) && s.lists.length ? s.lists.filter((l) => l && l.id && typeof l.title === 'string') : d.lists,
    defaultListId: s?.defaultListId,
    labels: Array.isArray(s?.labels) ? s.labels.filter((l) => l && l.id) : d.labels,
    directories: Array.isArray(s?.directories) ? s.directories.map(normalizeDirectory).filter(Boolean) : [],
    cards: s?.cards && typeof s.cards === 'object' ? s.cards : {},
    remoteHosts: s?.remoteHosts && typeof s.remoteHosts === 'object' ? s.remoteHosts : {},
    uiState: normalizeUiStateRecord(s?.uiState),
    settings: normalizeSettings(s?.settings),
  };
  if (!out.lists.length) out.lists = d.lists;
  if (!out.lists.some((l) => l.id === out.defaultListId)) out.defaultListId = out.lists[0].id;
  return out;
}

function normalizeUiStateRecord(record) {
  const revision = Number.isSafeInteger(record?.revision) && record.revision >= 0 ? record.revision : 0;
  const state = record?.state && typeof record.state === 'object' && !Array.isArray(record.state) ? record.state : null;
  return { revision, state };
}

function cloneUiState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('画面状態の形式が正しくありません');
  let serialized;
  try { serialized = JSON.stringify(state); } catch { throw new Error('画面状態を保存できません'); }
  if (serialized.length > 64 * 1024) throw new Error('画面状態が大きすぎます');
  return JSON.parse(serialized);
}

const SKIP_WRITE = Symbol('skipWrite');

function taskAttributes(state, { directory, labels, context }) {
  const attrs = {};
  if (directory !== undefined && directory !== null && directory !== '') {
    if (directory !== '__none' && !state.directories.some(d => d.id === directory)) throw new Error('カテゴリが見つかりません');
    attrs.directoryId = directory;
  }
  if (labels !== undefined) {
    if (!Array.isArray(labels) || labels.some(id => !state.labels.some(l => l.id === id))) throw new Error('ラベルが見つかりません');
    attrs.labels = [...new Set(labels)];
  }
  if (context !== undefined) attrs.context = normalizeTaskContext(context);
  return attrs;
}

export class Store {
  constructor(dir = dataDir()) {
    this.dir = dir;
    this.file = path.join(dir, 'canban.sqlite');
    if (isMainThread) return proxyStore(this, 'board');
  }

  getUiState() {
    const { revision, state } = this.load().uiState;
    return { revision, state };
  }

  saveUiState({ expectedRevision, state }) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('画面状態のリビジョンが正しくありません');
    const nextState = cloneUiState(state);
    return this.mutate((current) => {
      const record = current.uiState;
      if (record.revision !== expectedRevision) {
        return {
          [SKIP_WRITE]: true,
          value: { saved: false, conflict: true, revision: record.revision, state: record.state },
        };
      }
      record.revision++;
      record.state = nextState;
      return { saved: true, revision: record.revision, state: record.state };
    });
  }

  load() { return normalize(readBoard()); }

  save(state) { return this.mutate(() => ({ replacement: normalize(state) })); }

  mutate(fn) {
    return transaction(() => {
      const state = this.load();
      const result = fn(state);
      if (result?.[SKIP_WRITE]) return result.value;
      writeBoard(result?.replacement || state);
      return result?.replacement ? undefined : result;
    }, { fence: currentFence });
  }

  // ---- lists -------------------------------------------------------------
  async createList({ title, color = null, afterListId = null }) {
    title = String(title || '').trim();
    if (!title) throw new Error('リスト名を入力してください');
    return this.mutate((s) => {
      const list = { id: newId('list'), title, color: LIST_COLORS.includes(color) ? color : null, wipLimit: null };
      const idx = afterListId ? s.lists.findIndex((l) => l.id === afterListId) : -1;
      if (idx >= 0) s.lists.splice(idx + 1, 0, list);
      else s.lists.push(list);
      return list;
    });
  }

  updateList({ listId, title, color, wipLimit }) {
    return this.mutate((s) => {
      const list = s.lists.find((l) => l.id === listId);
      if (!list) throw new Error('リストが見つかりません');
      if (title !== undefined) {
        const t = String(title).trim();
        if (!t) throw new Error('リスト名を入力してください');
        list.title = t;
      }
      if (color !== undefined) list.color = LIST_COLORS.includes(color) ? color : null;
      if (wipLimit !== undefined) {
        const n = wipLimit == null || wipLimit === '' ? null : Math.floor(Number(wipLimit));
        list.wipLimit = n && n > 0 ? n : null;
      }
      return list;
    });
  }

  setDefaultList({ listId }) {
    return this.mutate((s) => {
      if (!s.lists.some((l) => l.id === listId)) throw new Error('リストが見つかりません');
      s.defaultListId = listId;
      return { defaultListId: listId };
    });
  }

  deleteList({ listId, moveCardsTo = null }) {
    return this.mutate((s) => {
      if (s.lists.length <= 1) throw new Error('最後のリストは削除できません');
      const idx = s.lists.findIndex((l) => l.id === listId);
      if (idx < 0) throw new Error('リストが見つかりません');
      s.lists.splice(idx, 1);
      if (s.defaultListId === listId) s.defaultListId = s.lists[0].id;
      const target = s.lists.some((l) => l.id === moveCardsTo) ? moveCardsTo : s.defaultListId;
      let moved = 0;
      for (const card of Object.values(s.cards)) {
        if (card.listId === listId) {
          card.listId = target;
          delete card.order; // fall back to recency order in the new list
          moved++;
        }
      }
      return { deleted: listId, movedTo: target, moved };
    });
  }

  reorderLists({ listIds }) {
    return this.mutate((s) => {
      const byId = new Map(s.lists.map((l) => [l.id, l]));
      const next = listIds.map((id) => byId.get(id)).filter(Boolean);
      for (const l of s.lists) if (!next.includes(l)) next.push(l);
      s.lists = next;
      return s.lists.map((l) => l.id);
    });
  }

  // ---- cards -------------------------------------------------------------
  setClaudeExecution({ cardId, execution }) {
    if (!/^claude:/.test(cardId)) throw new Error('このマシンの Claude Code セッションを選んでください');
    if (execution && (typeof execution.homeId !== 'string' || !execution.homeId || !/^claude:.+/.test(execution.account))) throw new Error('実行アカウントが正しくありません');
    return this.mutate(s => {
      const card = s.cards[cardId] ||= {};
      if (execution) card.claudeExecution = { homeId: execution.homeId, account: execution.account };
      else delete card.claudeExecution;
      return card.claudeExecution || null;
    });
  }

  // `order` is a number in the same space as the implicit order (-updatedAt),
  // computed by the caller from its neighbours.
  moveCard({ cardId, toListId, order }) {
    return this.mutate((s) => {
      if (!s.lists.some((l) => l.id === toListId)) throw new Error('移動先のリストが見つかりません');
      const card = (s.cards[cardId] ||= {});
      placeCard(card, toListId, order);
      delete card.movedBy; // a manual move supersedes an automatic one
      return { cardId, ...card };
    });
  }

  removeSessionMetadata(cardId) {
    return this.mutate(s => {
      delete s.cards[cardId];
      for (const c of Object.values(s.cards)) if (c.kind === 'task') c.links = (c.links || []).filter(id => id !== cardId);
      return { cardId };
    });
  }

  updateCard({ cardId, labels, note, priority, due, directory }) {
    return this.mutate((s) => {
      const card = (s.cards[cardId] ||= {});
      if (labels !== undefined) {
        const valid = new Set(s.labels.map((l) => l.id));
        card.labels = [...new Set((labels || []).filter((id) => valid.has(id)))];
      }
      if (directory !== undefined) {
        // '' / null: back to automatic (paths); '__none': explicitly outside every directory
        if (directory === '__none') card.directoryId = '__none';
        else if (s.directories.some((d) => d.id === directory)) card.directoryId = directory;
        else delete card.directoryId;
      }
      if (note !== undefined) card.note = String(note ?? '').slice(0, 20000);
      if (priority !== undefined) card.priority = ['high', 'medium', 'low'].includes(priority) ? priority : null;
      if (due !== undefined) card.due = due && !Number.isNaN(Date.parse(due)) ? due : null;
      card.updatedAt = new Date().toISOString();
      return { cardId, ...card };
    });
  }

  // ---- task cards (not backed by a session) -------------------------------
  async createTask({ title, listId, description = '', directory, labels, context, clientRequestId, slackSource }) {
    title = String(title || '').trim();
    if (!title) throw new Error('カード名を入力してください');
    if (clientRequestId !== undefined && (typeof clientRequestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(clientRequestId))) throw new Error('作成リクエストが不正です');
    return this.mutate((s) => {
      if (clientRequestId) {
        const existing = Object.entries(s.cards).find(([, c]) => c.kind === 'task' && c.clientRequestId === clientRequestId);
        if (existing) return { cardId: existing[0], ...existing[1] };
      }
      const attrs = taskAttributes(s, { directory, labels, context });
      if (listId && !s.lists.some(l => l.id === listId)) throw new Error('リストが見つかりません');
      const lid = s.lists.some((l) => l.id === listId) ? listId : s.defaultListId;
      const id = `task:${crypto.randomBytes(6).toString('hex')}`;
      const card = { kind: 'task', title: title.slice(0, 300), description: String(description).slice(0, 20000), createdAt: Date.now(), links: [], pending: [], ...attrs, ...(clientRequestId ? { clientRequestId } : {}) };
      placeCard(card, lid, Date.now()); // positive orders sort after session cards: new tasks go to the bottom
      s.cards[id] = card;
      if (slackSource) attachSlackReference(s, id, slackSource);
      return { cardId: id, ...card };
    });
  }

  linkSlack({ cardId, key, sourceTitle }) {
    if (typeof cardId !== 'string' || !/^(?:task:|(?:codex|claude)(?:@[^:\s]{1,200})?:)/.test(cardId)) throw new Error('カードを確認してください');
    return this.mutate(s => { if (cardId.startsWith('task:') && s.cards[cardId]?.kind !== 'task') throw new Error('タスクカードが見つかりません'); attachSlackReference(s, cardId, key); if (sourceTitle && !cardId.startsWith('task:')) s.cards[cardId].slackTitle = String(sourceTitle).slice(0,300); return { cardId, key }; });
  }

  unlinkSlack({ cardId, key }) {
    return this.mutate(s => { const card = s.cards[cardId]; if (card) card.slackRefs = (card.slackRefs || []).filter(k => k !== key); return { cardId, key }; });
  }

  updateTask({ cardId, title, description, target, context, directory, labels }) {
    return this.mutate((s) => {
      const card = s.cards[cardId];
      if (card?.kind !== 'task') throw new Error('タスクカードが見つかりません');
      Object.assign(card, taskAttributes(s, { directory, labels, context }));
      if (directory === null || directory === '') delete card.directoryId;
      if (title !== undefined) {
        const t = String(title).trim();
        if (!t) throw new Error('カード名を入力してください');
        card.title = t.slice(0, 300);
      }
      if (description !== undefined) card.description = String(description ?? '').slice(0, 20000);
      if (target !== undefined) {
        card.target = target && typeof target === 'object'
          ? { agent: ['codex', 'claude'].includes(target.agent) ? target.agent : 'codex', hostId: typeof target.hostId === 'string' ? target.hostId : 'local', cwd: typeof target.cwd === 'string' ? target.cwd : '',
            ...(typeof target.account === 'string' && /^(codex|claude):[A-Za-z0-9._@:-]{1,128}$/.test(target.account) ? { account: target.account } : {}) }
          : null;
      }
      card.updatedAt = new Date().toISOString();
      return { cardId, ...card };
    });
  }

  deleteTask({ cardId }) {
    return this.mutate((s) => {
      if (s.cards[cardId]?.kind !== 'task') throw new Error('タスクカードが見つかりません');
      delete s.cards[cardId];
      return { deleted: cardId };
    });
  }

  getTaskDashboard({ taskId }) {
    return taskDashboardRecord(this.load().cards[taskId], taskId);
  }

  getLoop({ taskId }) {
    return readTransaction(() => {
      const row = db().prepare("SELECT payload FROM board_records WHERE kind='cards' AND id=?").get(taskId);
      const task = row && JSON.parse(row.payload);
      const saved = db().prepare('SELECT payload FROM loop_state WHERE task_id=?').get(taskId);
      task && (task.loop = saved ? JSON.parse(saved.payload) : null);
      const rounds = db().prepare('SELECT payload FROM loop_rounds WHERE task_id=? ORDER BY rowid').all(taskId).map(r => JSON.parse(r.payload));
      for (const c of task?.loop?.cycles || []) c.rounds = rounds.filter(r => r.cycleId === c.id);
      return loopRecord(task, taskId);
    });
  }

  loopSummaries() {
    return readTransaction(() => Object.fromEntries(db().prepare('SELECT task_id FROM loop_state').all().flatMap(({ task_id: taskId }) => {
      if (!db().prepare("SELECT 1 FROM board_records WHERE kind='cards' AND id=?").get(taskId)) return [];
      const record = this.getLoop({ taskId });
      return [[taskId, { revision: record.revision, cycles: record.cycles.map(c => ({ id: c.id, parentId: c.parentId, goal: c.goal,
        status: c.status, phase: c.phase, version: c.version, maxRounds: c.maxRounds, count: c.rounds.filter(r => r.version === c.version).length,
        progress: loopProgress(c), reason: c.reason, updatedAt: c.updatedAt })) }]];
    })));
  }

  loopCommand(args) {
    return transaction(() => {
      const record = this.getLoop(args);
      const saved = db().prepare('SELECT payload FROM loop_state WHERE task_id=?').get(args.taskId);
      const task = { kind: 'task', loop: { ...(saved ? JSON.parse(saved.payload) : {}), ...record } };
      const result = applyLoopCommand(task, args.taskId, args);
      if (result.conflict || result.duplicate) return result;
      for (const c of task.loop.cycles) for (const r of c.rounds) {
        const payload = JSON.stringify({ ...r, cycleId: c.id });
        const old = db().prepare('SELECT payload FROM loop_rounds WHERE task_id=? AND id=?').get(args.taskId, r.id);
        if (old?.payload === payload) continue;
        if (old && JSON.parse(old.payload).closedAt) throw new Error('確定済みの周回は変更できません');
        db().prepare('INSERT INTO loop_rounds VALUES(?,?,?) ON CONFLICT(task_id,id) DO UPDATE SET payload=excluded.payload').run(args.taskId, r.id, payload);
      }
      const payload = JSON.stringify({ ...task.loop, cycles: task.loop.cycles.map(({ rounds, ...c }) => c) });
      db().prepare('INSERT INTO loop_state VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET payload=excluded.payload').run(args.taskId, payload);
      bump('board');
      return result;
    }, { fence: currentFence });
  }

  saveTaskDashboard({ taskId, expectedRevision, state }) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('タスクの画面設定のリビジョンが正しくありません');
    return this.mutate((s) => {
      const task = s.cards[taskId];
      const current = taskDashboardRecord(task, taskId);
      if (current.revision !== expectedRevision) return { [SKIP_WRITE]: true, value: { ...current, saved: false, conflict: true } };
      task.dashboard = { revision: current.revision + 1, state: normalizeTaskDashboard(state, taskId, task.links || []) };
      return { ...taskDashboardRecord(task, taskId), saved: true, conflict: false };
    });
  }

  linkSession({ taskId, sessionId }) {
    return this.mutate((s) => {
      const task = s.cards[taskId];
      if (task?.kind !== 'task') throw new Error('タスクカードが見つかりません');
      if (sessionId.startsWith('task:')) throw new Error('タスクカード同士は紐付けられません');
      for (const c of Object.values(s.cards)) if (c.kind === 'task') c.links = (c.links || []).filter((x) => x !== sessionId);
      task.links = [...(task.links || []), sessionId];
      return { taskId, links: task.links };
    });
  }

  unlinkSession({ taskId, sessionId }) {
    return this.mutate((s) => {
      const task = s.cards[taskId];
      if (task?.kind !== 'task') throw new Error('タスクカードが見つかりません');
      task.links = (task.links || []).filter((x) => x !== sessionId);
      return { taskId, links: task.links };
    });
  }

  addPending({ taskId, pending }) {
    return this.mutate((s) => {
      const task = s.cards[taskId];
      if (task?.kind !== 'task') throw new Error('タスクカードが見つかりません');
      task.pending = [...(task.pending || []), pending].slice(-10);
      return { taskId, pending: task.pending };
    });
  }

  clearPending({ taskId }) {
    return this.mutate((s) => {
      const task = s.cards[taskId];
      if (task?.kind !== 'task') throw new Error('タスクカードが見つかりません');
      task.pending = [];
      return { taskId };
    });
  }

  // resolved: [{taskId, sessionId, startedAt}] — pending launches matched to real sessions.
  resolvePending(resolved) {
    if (!resolved.length) return Promise.resolve([]);
    return this.mutate((s) => {
      for (const r of resolved) {
        const task = s.cards[r.taskId];
        if (task?.kind !== 'task') continue;
        task.pending = (task.pending || []).filter((p) => p.startedAt !== r.startedAt);
        if (!(task.links || []).includes(r.sessionId)) task.links = [...(task.links || []), r.sessionId];
      }
      return resolved;
    });
  }

  // ---- rule-driven moves -------------------------------------------------
  // moves: [{cardId, fromListId?, toListId, order, ruleId}] — keep previous placement for undo.
  applyAutoMoves(moves, { rule = null } = {}) {
    if (!moves.length) return Promise.resolve([]);
    return this.mutate((s) => {
      if (rule) {
        const current = s.settings.rules.find((r) => r.id === rule.id);
        if (!current || ['trigger', 'fromListId', 'toListId'].some((k) => current[k] !== rule[k])) {
          throw new Error('自動化が変更または削除されました。もう一度実行してください');
        }
        if (!s.lists.some((l) => l.id === rule.toListId)) throw new Error('移動先のリストが見つかりません');
      }
      const done = [];
      const at = new Date().toISOString();
      for (const m of moves) {
        if (!s.lists.some((l) => l.id === m.toListId)) continue;
        const currentListId = s.cards[m.cardId]?.listId ?? s.defaultListId;
        if (currentListId === m.toListId || (m.fromListId && m.fromListId !== currentListId)) continue;
        const card = (s.cards[m.cardId] ||= {});
        const prev = { listId: card.listId ?? null, order: card.order ?? null };
        placeCard(card, m.toListId, m.order, at);
        card.movedBy = { ruleId: m.ruleId, at: Date.now(), prev };
        done.push({ cardId: m.cardId, toListId: m.toListId, ruleId: m.ruleId });
      }
      return done;
    });
  }

  async undoAutoMove({ cardId }) {
    return this.mutate((s) => {
      const card = s.cards[cardId];
      if (!card?.movedBy) throw new Error('元に戻せる自動移動がありません');
      const { prev } = card.movedBy;
      delete card.movedBy;
      if (prev.listId && s.lists.some((l) => l.id === prev.listId)) placeCard(card, prev.listId, prev.order ?? undefined);
      else {
        delete card.listId;
        delete card.order;
      }
      return { cardId, listId: card.listId ?? s.defaultListId };
    });
  }

  // ---- rules / seen -------------------------------------------------------
  async setRule(rule) {
    const r = normalizeRule({ id: rule.id || newId('rule'), ...rule });
    if (!r) throw new Error('自動化の内容が正しくありません');
    return this.mutate((s) => {
      if (!s.lists.some((l) => l.id === r.toListId)) throw new Error('移動先のリストが見つかりません');
      if (r.fromListId !== 'any' && !s.lists.some((l) => l.id === r.fromListId)) throw new Error('移動元のリストが見つかりません');
      const i = s.settings.rules.findIndex((x) => x.id === r.id);
      if (i >= 0) s.settings.rules[i] = r;
      else s.settings.rules.push(r);
      return r;
    });
  }

  deleteRule({ ruleId }) {
    return this.mutate((s) => {
      s.settings.rules = s.settings.rules.filter((r) => r.id !== ruleId);
      return { deleted: ruleId };
    });
  }

  async saveView({ id, name, filters }) {
    const v = normalizeView({ id: id || newId('view'), name, filters });
    if (!v) throw new Error('ビュー名を入力してください');
    return this.mutate((s) => {
      const i = s.settings.views.findIndex((x) => x.id === v.id);
      if (i >= 0) s.settings.views[i] = v;
      else if (s.settings.views.length >= 20) throw new Error('ビューは 20 個まで保存できます');
      else s.settings.views.push(v);
      return v;
    });
  }

  deleteView({ viewId }) {
    return this.mutate((s) => {
      s.settings.views = s.settings.views.filter((v) => v.id !== viewId);
      return { deleted: viewId };
    });
  }

  markSeen({ cardId }) {
    return this.mutate((s) => {
      const card = (s.cards[cardId] ||= {});
      card.seenAt = Date.now();
      return { cardId, seenAt: card.seenAt };
    });
  }

  markAllSeen() {
    return this.mutate((s) => {
      s.settings.seenAllAt = Date.now();
      return { seenAllAt: s.settings.seenAllAt };
    });
  }

  // ---- settings / remote hosts -----------------------------------------
  updateLaunchSettings(patch = {}) {
    return this.mutate((s) => {
      s.settings = normalizeSettings({ ...s.settings, launch: { ...s.settings.launch, ...patch } });
      return s.settings;
    });
  }

  updateDispatchSettings(patch = {}) {
    return this.mutate((s) => {
      s.settings = normalizeSettings({ ...s.settings, dispatch: { ...s.settings.dispatch, ...patch } });
      return s.settings.dispatch;
    });
  }

  updateAccountSettings(patch = {}) {
    return this.mutate((s) => {
      const migration = patch.executionHomeMigration;
      if (migration && patch.profile?.id === migration.to && patch.profile?.key === migration.account) {
        for (const card of Object.values(s.cards)) {
          if (card.claudeExecution?.homeId === migration.from && card.claudeExecution.account === migration.account) card.claudeExecution.homeId = migration.to;
        }
      }
      s.settings = normalizeSettings({ ...s.settings, accounts: applyAccountPatch(s.settings.accounts, patch) });
      return s.settings.accounts;
    });
  }

  async setRemoteHost({ hostId, enabled }) {
    if (!hostId || hostId === 'local') throw new Error('ホストを指定してください');
    return this.mutate((s) => {
      s.remoteHosts[hostId] = { ...(s.remoteHosts[hostId] || {}), enabled: !!enabled };
      return { hostId, ...s.remoteHosts[hostId] };
    });
  }

  // ---- labels ------------------------------------------------------------
  async createLabel({ name, color }) {
    name = String(name || '').trim();
    if (!name) throw new Error('ラベル名を入力してください');
    return this.mutate((s) => {
      const label = { id: newId('lbl'), name, color: LIST_COLORS.includes(color) ? color : 'gray' };
      s.labels.push(label);
      return label;
    });
  }

  updateLabel({ labelId, name, color }) {
    return this.mutate((s) => {
      const label = s.labels.find((l) => l.id === labelId);
      if (!label) throw new Error('ラベルが見つかりません');
      if (name !== undefined && String(name).trim()) label.name = String(name).trim();
      if (color !== undefined && LIST_COLORS.includes(color)) label.color = color;
      return label;
    });
  }

  deleteLabel({ labelId }) {
    return this.mutate((s) => {
      s.labels = s.labels.filter((l) => l.id !== labelId);
      for (const c of Object.values(s.cards)) if (c.labels) c.labels = c.labels.filter((id) => id !== labelId);
      return { deleted: labelId };
    });
  }

  // ---- directories -------------------------------------------------------
  syncSessionCategories(sessions) {
    const current = this.load();
    const ignored = new Set(current.settings.ignoredCategorySources);
    const sources = new Map(sessions.map(sessionCategory).filter(source => source && !ignored.has(source.key)).map(source => [source.key, source]));
    // No write/revision churn when the categories are already present.
    if ([...sources.keys()].every(key => current.directories.some(d => d.sourceKeys?.includes(key)))) return false;
    return this.mutate(s => {
      for (const source of sources.values()) {
        if (s.settings.ignoredCategorySources.includes(source.key)) continue;
        if (s.directories.some(d => d.sourceKeys?.includes(source.key))) continue;
        let dir = s.directories.find(d => d.name === source.name);
        if (!dir) { dir = { id: newId('dir'), name: source.name, color: null, paths: [] }; s.directories.push(dir); }
        dir.sourceKeys = [...(dir.sourceKeys || []), source.key];
      }
      return true;
    });
  }
  async createDirectory({ name, color = null, paths = [] }) {
    name = String(name || '').trim();
    if (!name) throw new Error('カテゴリ名を入力してください');
    return this.mutate((s) => {
      if (s.directories.some((d) => d.name === name)) throw new Error(`「${name}」は既にあります`);
      const dir = normalizeDirectory({ id: newId('dir'), name, color, paths });
      s.directories.push(dir);
      return dir;
    });
  }

  updateDirectory({ directoryId, name, color, paths }) {
    return this.mutate((s) => {
      const dir = s.directories.find((d) => d.id === directoryId);
      if (!dir) throw new Error('カテゴリが見つかりません');
      if (name !== undefined && String(name).trim()) dir.name = String(name).trim().slice(0, 80);
      if (color !== undefined) dir.color = LIST_COLORS.includes(color) ? color : null;
      if (paths !== undefined) dir.paths = normalizePaths(paths);
      return dir;
    });
  }

  deleteDirectory({ directoryId }) {
    return this.mutate((s) => {
      const deleted = s.directories.find(d => d.id === directoryId);
      s.settings.ignoredCategorySources = [...new Set([...s.settings.ignoredCategorySources, ...(deleted?.sourceKeys || [])])];
      s.directories = s.directories.filter((d) => d.id !== directoryId);
      for (const c of Object.values(s.cards)) if (c.directoryId === directoryId) delete c.directoryId;
      return { deleted: directoryId };
    });
  }
}

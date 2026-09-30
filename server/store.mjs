// Kanban state store. This is the only module that writes to disk, and it only
// writes inside the kanban data directory (default ~/.canban).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const STORE_VERSION = 1;
export const LIST_COLORS = ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'purple', 'pink', 'sky', 'lime'];

export const LAUNCH_ROUTES = ['desktop', 'terminal'];
export const TERMINALS = ['ghostty', 'terminal', 'iterm'];
export const TERMINAL_TARGETS = ['new-window', 'new-tab', 'split', 'current'];

export function dataDir() {
  return process.env.CANBAN_DATA_DIR || path.join(os.homedir(), '.canban');
}

// v0.1 stored its board under ~/.session-kanban. It is read (never modified) when
// the new store does not exist yet; the first save writes to the new location.
function legacyFile(dir) {
  if (process.env.CANBAN_DATA_DIR || dir !== dataDir()) return null;
  return path.join(os.homedir(), '.session-kanban', 'board.json');
}

export const RULE_TRIGGERS = [
  'status:running', 'status:waiting', 'status:completed', 'status:aborted', 'activity',
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
    launch: { route: 'desktop', terminal: 'terminal', target: 'new-window' },
    // Automatic moves on status transitions (all off by default).
    rules: defaultRules(),
    // Cards updated after this time (and after their own seenAt) are highlighted as new.
    seenAllAt: null,
    // Saved views: named filter / swimlane presets.
    views: [],
    // Sending prompts to sessions (headless turns through the agents' CLIs).
    dispatch: defaultDispatch(),
    // Accounts: display names, and the agents' extra config folders (see accounts.mjs).
    accounts: defaultAccounts(),
  };
}

export function defaultAccounts() {
  // marks: { key: { short, color } } tell accounts apart in the header; hidden: keys left out of it.
  return { labels: {}, marks: {}, hidden: [], claudeHomes: [], codexHomes: [], discover: true };
}

const ACCOUNT_KEY = /^(codex|claude):[A-Za-z0-9._@:-]{1,128}$/;
// Account colors avoid green / orange / red, which the usage rings use for how full they are.
export const ACCOUNT_COLORS = ['blue', 'purple', 'pink', 'sky', 'lime', 'yellow', 'gray'];
function normalizeHomes(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((p) => String(p || '').trim().replace(/\/+$/, '')).filter((p) => p.startsWith('/') || p.startsWith('~/')))].slice(0, 10);
}
function normalizeAccounts(x) {
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
  return { labels, marks, hidden, claudeHomes: normalizeHomes(x?.claudeHomes), codexHomes: normalizeHomes(x?.codexHomes), discover: x?.discover !== false };
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

const VIEW_FILTER_KEYS = ['agent', 'host', 'account', 'status', 'project', 'folder', 'section', 'directory', 'laneHeight', 'q', 'days', 'includeArchived', 'includeSubagents', 'includeHidden', 'pinnedOnly', 'groupBranch', 'fulltext', 'swimlane'];
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
    },
    rules: Array.isArray(s?.rules) ? s.rules.map(normalizeRule).filter(Boolean) : d.rules,
    seenAllAt: typeof s?.seenAllAt === 'number' ? s.seenAllAt : null,
    views: Array.isArray(s?.views) ? s.views.map(normalizeView).filter(Boolean).slice(0, 20) : [],
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
  return { id: d.id, name: String(d.name).trim().slice(0, 80), color: LIST_COLORS.includes(d.color) ? d.color : null, paths: normalizePaths(d.paths) };
}

// Explicit assignment wins ('__none' opts out); otherwise the longest matching path prefix.
export function resolveDirectory(state, card, cwd) {
  const id = card?.directoryId;
  if (id === '__none') return null;
  if (id) {
    const d = (state.directories || []).find((x) => x.id === id);
    if (d) return d;
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
    settings: defaultSettings(),
  };
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(5).toString('hex')}`;
}

function normalize(s) {
  const d = defaultState();
  const out = {
    version: STORE_VERSION,
    lists: Array.isArray(s?.lists) && s.lists.length ? s.lists.filter((l) => l && l.id && typeof l.title === 'string') : d.lists,
    defaultListId: s?.defaultListId,
    labels: Array.isArray(s?.labels) ? s.labels.filter((l) => l && l.id) : d.labels,
    directories: Array.isArray(s?.directories) ? s.directories.map(normalizeDirectory).filter(Boolean) : [],
    cards: s?.cards && typeof s.cards === 'object' ? s.cards : {},
    remoteHosts: s?.remoteHosts && typeof s.remoteHosts === 'object' ? s.remoteHosts : {},
    settings: normalizeSettings(s?.settings),
  };
  if (!out.lists.length) out.lists = d.lists;
  if (!out.lists.some((l) => l.id === out.defaultListId)) out.defaultListId = out.lists[0].id;
  return out;
}

const LOCK_STALE_MS = 10000;
const LOCK_WAIT_MS = 5000;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Exclusive lock across processes (held for one synchronous read-modify-write). A lock
// left by a dead process, or older than LOCK_STALE_MS, is taken over.
function lockFile(file) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    try {
      const st = fs.statSync(file);
      const owner = Number(fs.readFileSync(file, 'utf8'));
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS || (owner && owner !== process.pid && !pidAlive(owner))) fs.rmSync(file, { force: true });
    } catch {}
    if (Date.now() > deadline) throw new Error('ボードのロックを取得できませんでした');
    sleep(10);
  }
}

export class Store {
  constructor(dir = dataDir()) {
    this.dir = dir;
    this.file = path.join(dir, 'board.json');
    this.lockFile = path.join(dir, 'board.lock');
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      const legacy = legacyFile(this.dir);
      try {
        if (legacy) return normalize(JSON.parse(fs.readFileSync(legacy, 'utf8')));
      } catch {}
      return defaultState();
    }
    try {
      return normalize(JSON.parse(raw));
    } catch {
      // Keep the broken file for inspection and start over.
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {}
      return defaultState();
    }
  }

  async save(state) {
    await fsp.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await fsp.rename(tmp, this.file);
  }

  // Read-modify-write. Serialized within this process by a promise chain, and across
  // processes (Codex and Claude Desktop each run servers on the same board, and the
  // board updates live in both) by an exclusive lock file, so no edit is lost.
  mutate(fn) {
    const run = async () => {
      await fsp.mkdir(this.dir, { recursive: true });
      lockFile(this.lockFile);
      try {
        const state = this.load();
        const result = fn(state);
        const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        fs.renameSync(tmp, this.file);
        return result;
      } finally {
        fs.rmSync(this.lockFile, { force: true });
      }
    };
    const p = (this.queue || Promise.resolve()).then(run, run);
    this.queue = p.catch(() => {});
    return p;
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

  updateCard({ cardId, labels, note, priority, due, hidden, directory }) {
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
      if (hidden !== undefined) card.hidden = !!hidden;
      card.updatedAt = new Date().toISOString();
      return { cardId, ...card };
    });
  }

  // ---- task cards (not backed by a session) -------------------------------
  async createTask({ title, listId, description = '' }) {
    title = String(title || '').trim();
    if (!title) throw new Error('カード名を入力してください');
    return this.mutate((s) => {
      const lid = s.lists.some((l) => l.id === listId) ? listId : s.defaultListId;
      const id = `task:${crypto.randomBytes(6).toString('hex')}`;
      const card = { kind: 'task', title: title.slice(0, 300), description: String(description).slice(0, 20000), createdAt: Date.now(), links: [], pending: [] };
      placeCard(card, lid, Date.now()); // positive orders sort after session cards: new tasks go to the bottom
      s.cards[id] = card;
      return { cardId: id, ...card };
    });
  }

  updateTask({ cardId, title, description, target }) {
    return this.mutate((s) => {
      const card = s.cards[cardId];
      if (card?.kind !== 'task') throw new Error('タスクカードが見つかりません');
      if (title !== undefined) {
        const t = String(title).trim();
        if (!t) throw new Error('カード名を入力してください');
        card.title = t.slice(0, 300);
      }
      if (description !== undefined) card.description = String(description ?? '').slice(0, 20000);
      if (target !== undefined) {
        card.target = target && typeof target === 'object'
          ? { agent: ['codex', 'claude'].includes(target.agent) ? target.agent : 'codex', hostId: typeof target.hostId === 'string' ? target.hostId : 'local', cwd: typeof target.cwd === 'string' ? target.cwd : '' }
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
  // moves: [{cardId, toListId, order, ruleId}] — the previous placement is kept for undo.
  applyAutoMoves(moves) {
    if (!moves.length) return Promise.resolve([]);
    return this.mutate((s) => {
      const done = [];
      const at = new Date().toISOString();
      for (const m of moves) {
        if (!s.lists.some((l) => l.id === m.toListId)) continue;
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

  // patch: { label: { key, name } } renames an account ('' clears it); mark: { key, short, color }
  // ('' / null clears); visible: { key, on } shows or hides it in the header; homes / discover replace.
  updateAccountSettings({ label, mark, visible, claudeHomes, codexHomes, discover } = {}) {
    return this.mutate((s) => {
      const a = { ...s.settings.accounts, labels: { ...s.settings.accounts.labels } };
      if (label && typeof label.key === 'string') {
        if (!ACCOUNT_KEY.test(label.key)) throw new Error('アカウントが不正です');
        a.labels[label.key] = label.name;
      }
      if (mark && typeof mark.key === 'string') {
        if (!ACCOUNT_KEY.test(mark.key)) throw new Error('アカウントが不正です');
        const cur = { ...(s.settings.accounts.marks[mark.key] || {}) };
        if (mark.short !== undefined) cur.short = mark.short;
        if (mark.color !== undefined) cur.color = mark.color;
        a.marks = { ...s.settings.accounts.marks, [mark.key]: cur };
      }
      if (visible && typeof visible.key === 'string') {
        if (!ACCOUNT_KEY.test(visible.key)) throw new Error('アカウントが不正です');
        a.hidden = visible.on ? a.hidden.filter((k) => k !== visible.key) : [...a.hidden, visible.key];
      }
      if (claudeHomes !== undefined) a.claudeHomes = claudeHomes;
      if (codexHomes !== undefined) a.codexHomes = codexHomes;
      if (discover !== undefined) a.discover = discover;
      s.settings = normalizeSettings({ ...s.settings, accounts: a });
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
      s.directories = s.directories.filter((d) => d.id !== directoryId);
      for (const c of Object.values(s.cards)) if (c.directoryId === directoryId) delete c.directoryId;
      return { deleted: directoryId };
    });
  }
}

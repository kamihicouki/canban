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
  };
}

function normalizeRule(r) {
  if (!r || typeof r.id !== 'string' || !RULE_TRIGGERS.includes(r.trigger) || typeof r.toListId !== 'string') return null;
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
  };
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
    cards: s?.cards && typeof s.cards === 'object' ? s.cards : {},
    remoteHosts: s?.remoteHosts && typeof s.remoteHosts === 'object' ? s.remoteHosts : {},
    settings: normalizeSettings(s?.settings),
  };
  if (!out.lists.length) out.lists = d.lists;
  if (!out.lists.some((l) => l.id === out.defaultListId)) out.defaultListId = out.lists[0].id;
  return out;
}

export class Store {
  constructor(dir = dataDir()) {
    this.dir = dir;
    this.file = path.join(dir, 'board.json');
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

  // Read-modify-write, serialized within this process so concurrent tool calls
  // cannot interleave; re-reading from disk keeps several processes consistent.
  mutate(fn) {
    const run = async () => {
      const state = this.load();
      const result = fn(state);
      await this.save(state);
      return result;
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

  updateCard({ cardId, labels, note, priority, due, hidden }) {
    return this.mutate((s) => {
      const card = (s.cards[cardId] ||= {});
      if (labels !== undefined) {
        const valid = new Set(s.labels.map((l) => l.id));
        card.labels = [...new Set((labels || []).filter((id) => valid.has(id)))];
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
      if (sessionId.startsWith('task:')) throw new Error('タスク同士は紐付けられません');
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
    if (!r) throw new Error('ルールの内容が正しくありません');
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
}

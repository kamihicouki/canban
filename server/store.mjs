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

export function defaultSettings() {
  return {
    // How "resume" opens a session: in the agent's desktop app or in a terminal.
    launch: { route: 'desktop', terminal: 'terminal', target: 'new-window' },
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
  };
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
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await fsp.rename(tmp, this.file);
  }

  // Read-modify-write so several server processes (multiple windows) stay consistent.
  async mutate(fn) {
    const state = this.load();
    const result = fn(state);
    await this.save(state);
    return result;
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
      card.listId = toListId;
      if (typeof order === 'number' && Number.isFinite(order)) card.order = order;
      else delete card.order;
      card.updatedAt = new Date().toISOString();
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

  // ---- settings / remote hosts -----------------------------------------
  updateLaunchSettings(patch = {}) {
    return this.mutate((s) => {
      s.settings = normalizeSettings({ launch: { ...s.settings.launch, ...patch } });
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

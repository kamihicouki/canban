// Only presentation preferences belong here; membership is owned by task.links.
const choose = (value, allowed, fallback = null) => allowed.includes(value) ? value : fallback;
const finite = (value, min, max, fallback) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const names = (value) => [...new Set((Array.isArray(value) ? value : []).filter(x => typeof x === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(x)))];

export function normalizeTaskDashboard(value, taskId, links = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('タスクの画面設定の形式が正しくありません');
  if (JSON.stringify(value).length > 64 * 1024) throw new Error('タスクの画面設定が大きすぎます');
  const members = new Set([taskId, ...links]);
  const seen = new Set();
  const panes = [];
  for (const p of Array.isArray(value.panes) ? value.panes : []) {
    if (!p || !members.has(p.id) || seen.has(p.id)) continue;
    seen.add(p.id);
    const free = p.free && Number.isFinite(p.free.x) && Number.isFinite(p.free.y)
      ? { x: finite(p.free.x, 0, 100000, 0), y: finite(p.free.y, 0, 100000, 0) } : null;
    panes.push({ id: p.id, space: choose(p.space, ['fixed', 'free']), mode: choose(p.mode, ['text', 'preview', 'digest']), size: choose(p.size, ['S', 'M', 'L']), note: p.note === true, free });
  }
  const g = value.paneGlobal || {};
  const l = value.paneLayout || {};
  const main = names(l.main), side = names(l.side).filter(id => !main.includes(id));
  const heights = {};
  for (const id of names(Object.keys(l.heights || {}))) heights[id] = Math.round(finite(l.heights[id], 64, 900, 140));
  return {
    version: 1,
    preset: choose(value.preset, ['A', 'B', 'C', 'free'], 'A'),
    activeSessionId: links.includes(value.activeSessionId) ? value.activeSessionId : links[0] || null,
    paneGlobal: { space: choose(g.space, ['fixed', 'free'], 'fixed'), arrange: choose(g.arrange, ['grid', 'row', 'col'], 'grid'), mode: choose(g.mode, ['text', 'preview', 'digest'], 'preview'), size: choose(g.size, ['S', 'M', 'L'], 'L') },
    paneLayout: { main, side, collapsed: names(l.collapsed), ratio: finite(l.ratio, .35, .8, 2 / 3), heights },
    panes,
  };
}

export function taskDashboardRecord(task, taskId) {
  if (task?.kind !== 'task') throw new Error('タスクカードが見つかりません');
  const record = task.dashboard;
  return {
    taskId, links: [...(task.links || [])],
    revision: Number.isSafeInteger(record?.revision) && record.revision >= 0 ? record.revision : 0,
    state: record?.state ? normalizeTaskDashboard(record.state, taskId, task.links) : null,
  };
}

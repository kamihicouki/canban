// Pure routing and presentation rules; also exercised by the Node tests.
const WORKSPACE_PAGES = [
  ['home', 'ホーム', 'home'],
  ['rules', '自動化', 'zap'], ['views', '保存ビュー', 'bookmark'],
  ['labels', 'ラベル', 'tags'], ['directories', 'カテゴリ', 'folder'],
  ['hosts', 'マシン', 'monitor'], ['settings', '設定', 'settings'],
];
function workspacePage(value, fallback = 'home') {
  return WORKSPACE_PAGES.some(([id]) => id === value) ? value : fallback;
}
// Stored layouts may predate cross-column moves, widths or synchronized heights.
function normalizePaneLayout(value, defaults, heightDefaults) {
  const ids = [...defaults.main, ...defaults.side], seen = new Set();
  const result = { main: [], side: [], collapsed: [], ratio: 2 / 3, heights: {} };
  for (const col of ['main', 'side']) for (const id of Array.isArray(value?.[col]) ? value[col] : []) {
    if (ids.includes(id) && !seen.has(id)) { result[col].push(id); seen.add(id); }
  }
  for (const col of ['main', 'side']) for (const id of defaults[col]) if (!seen.has(id)) result[col].push(id);
  result.collapsed = [...new Set((Array.isArray(value?.collapsed) ? value.collapsed : []).filter(id => ids.includes(id)))];
  if (typeof value?.ratio === 'number' && Number.isFinite(value.ratio)) result.ratio = Math.min(.8, Math.max(.35, value.ratio));
  for (const id of ids) {
    const height = value?.heights?.[id];
    result.heights[id] = typeof height === 'number' && Number.isFinite(height) ? Math.min(900, Math.max(64, Math.round(height))) : heightDefaults[id] || 140;
  }
  return result;
}
function usageWindow(value, at, now = Date.now()) {
  if (!value || !Number.isFinite(value.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100) return null;
  const stale = value.stale === true || !Number.isFinite(at) || at <= 0 || at > now + 60000
    || now - at > 15 * 60 * 1000 || (value.resetsAt != null && (!Number.isFinite(value.resetsAt) || value.resetsAt <= now));
  const minutes = Number(value.windowMinutes);
  const label = minutes === 10080 ? '週間枠' : minutes >= 1440 ? `${Math.round(minutes / 1440)}日枠`
    : minutes > 0 ? `${minutes / 60}時間枠` : '利用枠';
  return { label, used: stale ? null : Math.round(value.usedPercent), remaining: stale ? null : Math.round(100 - value.usedPercent), stale, resetsAt: value.resetsAt || null };
}

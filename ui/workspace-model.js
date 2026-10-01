// Pure geometry and presentation rules; also exercised by the Node tests.
const WORKSPACE_PAGES = [
  ['home', 'ホーム', 'home'], ['cards', 'カード', 'panels-top-left'],
  ['usage', 'Agent Usage', 'chart-no-axes-combined'], ['analytics', '分析', 'chart-column'],
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
function paneBatch(ids, opened, max) {
  const unique = [...new Set(ids)];
  const additions = unique.filter(id => !opened.includes(id));
  return { ids: unique, additions, fits: opened.length + additions.length <= max };
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
function paneGeometry(items, kind, W, H, gap = 12) {
  W = Math.max(0, W); H = Math.max(0, H);
  const available = Math.max(0, H - gap * 2), rects = [];
  let width = W, height = H;
  const placeRow = (row, y, rh) => {
    const sum = row.reduce((n, x) => n + x.w, 0) + gap * (row.length - 1);
    let x = Math.max(gap, (W - sum) / 2);
    for (const item of row) {
      rects.push({ index: item.index, x, y, h: item.note ? Math.min(item.h, rh) : rh });
      x += item.w + gap;
    }
    width = Math.max(width, x);
  };
  if (!items.length) return { rects, width, height };
  if (kind === 'row') placeRow(items, gap, available);
  else if (kind === 'col') {
    let y = gap;
    for (const item of items) {
      const rh = item.note ? Math.min(item.h, available) : available;
      placeRow([item], y, rh); y += rh + gap;
    }
    height = Math.max(H, y);
  } else {
    const rows = []; let row = [], used = gap;
    for (const item of items) {
      if (row.length && used + item.w > W - gap) { rows.push(row); row = []; used = gap; }
      row.push(item); used += item.w + gap;
    }
    if (row.length) rows.push(row);
    const cap = Math.max(0, Math.floor((H - gap * (rows.length + 1)) / rows.length));
    let y = gap;
    for (const current of rows) {
      const noteOnly = current.every(x => x.note);
      const intrinsic = Math.max(...current.map(x => x.h));
      const rh = noteOnly ? Math.min(intrinsic, available) : rows.length === 1 ? available : Math.max(320, cap);
      placeRow(current, y, rh); y += rh + gap;
    }
    height = Math.max(H, y);
  }
  return { rects, width, height };
}

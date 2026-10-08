// Pure routing and presentation rules; also exercised by the Node tests.
const WORKSPACE_PAGES = [
  ['home', 'ホーム', 'home'],
  ['rules', '自動化', 'zap'], ['views', '保存ビュー', 'bookmark'],
  ['labels', 'ラベル', 'tags'], ['directories', 'カテゴリ', 'folder'],
  ['hosts', 'マシン', 'monitor'], ['settings', '設定', 'settings'],
  ['slack', 'Slack接続', 'message'],
];
function workspacePage(value, fallback = 'home') {
  return WORKSPACE_PAGES.some(([id]) => id === value) ? value : fallback;
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

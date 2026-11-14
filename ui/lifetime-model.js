// Lifetime: every card ages. Included into board.html's script (shares its scope); pure, so tests run it alone.
//   live      running or waiting for you: the full face, always on top of attention
//   fresh     moved in the last day, unread, or stopped with an error: the standard face
//   active    moved this week, or kept (a task card, a priority, a due date): the standard face
//   dormant   no movement for a week: one line, folded at the foot of its list
// Past the board's period (30 days by default) a card leaves the board; search still finds it.
const DAY_MS = 86400000;
const FRESH_MS = DAY_MS;
const DORMANT_MS = 7 * DAY_MS;
const LIFE_LABELS = { live: '動いている', fresh: '新しい', active: '今週', dormant: '休眠中' };

function lifeOf(card, now = Date.now()) {
  const status = card.kind === 'task' ? taskLifeStatus(card) : knownLifeStatus(card);
  if (status === 'running' || status === 'waiting') return 'live';
  const age = now - (card.updatedAt || 0);
  if (card.unread || status === 'aborted' || age < FRESH_MS) return 'fresh';
  if (age < DORMANT_MS || card.kind === 'task' || card.priority || card.due) return 'active';
  return 'dormant';
}
// A task card lives as long as one of its sessions does.
function taskLifeStatus(card) {
  const all = card.links || [];
  const links = all.filter((l) => l.statusKnown !== false);
  if (links.some((l) => l.status === 'waiting')) return 'waiting';
  if (links.some((l) => l.status === 'aborted')) return 'aborted';
  if (links.some((l) => l.status === 'running')) return 'running';
  if (all.length) return links.length ? links.every((l) => l.status === 'completed') ? 'completed' : 'idle' : null;
  return knownLifeStatus(card);
}
const knownLifeStatus = (card) => card.statusKnown === false ? null : card.status;

// Only show observed waiting/running content. Missing state is not a live state.
function rowWaitLine(card) {
  if (card.statusKnown === false) return '状態は未取得';
  const status = card.kind === 'task' ? taskLifeStatus(card) : card.status;
  if (status == null && card.kind === 'task' && card.links?.length) return '状態は未取得';
  const clean = (value) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (status === 'waiting') {
    if (card.signals?.wait === 'plan') return '計画の確認待ち';
    const question = clean(card.signals?.waitText);
    return question ? `質問: ${question}` : '入力待ち';
  }
  if (status === 'aborted') return '中断';
  return status === 'running' ? clean(card.activity) : '';
}

// A task keeps its sessions together without forcing a permanent expansion state.
function timelineChildren(card, { expanded = false, selected = null } = {}) {
  if (card.kind !== 'task') return { children: [], more: 0 };
  const seen = new Set();
  const rank = (c) => ({ waiting: 0, aborted: 1, running: 2 }[knownLifeStatus(c)] ?? 3);
  const all = (card.links || []).filter((c) => c && typeof c.id === 'string' && !seen.has(c.id) && seen.add(c.id))
    .sort((a, b) => rank(a) - rank(b) || (b.updatedAt || 0) - (a.updatedAt || 0));
  if (expanded) return { children: all, more: 0 };
  let children = all.slice(0, 3);
  const current = all.find((c) => c.id === selected);
  if (current && !children.includes(current)) children = [...children.slice(0, 2), current];
  return { children, more: all.length - children.length };
}

// Whole days since `ms`, by the local calendar (today is 0, yesterday 1).
function daysAgo(ms, now = Date.now()) {
  if (!ms) return Infinity;
  const start = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  return Math.max(0, Math.round((start(now) - start(ms)) / DAY_MS));
}

// The timeline's groups: what needs you, what runs, then by the calendar.
const TIME_GROUPS = [['need', '要対応'], ['live', '実行中'], ['today', '今日'], ['yesterday', '昨日'], ['week', '今週'], ['month', '今月'], ['older', 'それ以前']];
function timeGroupOf(card, now = Date.now()) {
  const status = card.kind === 'task' ? taskLifeStatus(card) : knownLifeStatus(card);
  if (status === 'waiting' || status === 'aborted') return 'need';
  if (status === 'running') return 'live';
  const d = daysAgo(card.updatedAt, now);
  return d === 0 ? 'today' : d === 1 ? 'yesterday' : d < 7 ? 'week' : d < 30 ? 'month' : 'older';
}

// Cards per day for the ribbon: index 0 is today, `days - 1` the oldest day shown.
function dayHistogram(cards, days, now = Date.now()) {
  const counts = new Array(days).fill(0);
  for (const c of cards) {
    const d = daysAgo(c.updatedAt, now);
    if (d < days) counts[d]++;
  }
  return counts;
}

// A list splits into the cards that are awake (in their own order) and the dormant ones folded below.
function splitByLife(cards, now = Date.now()) {
  const awake = [], dormant = [];
  for (const c of cards) (lifeOf(c, now) === 'dormant' ? dormant : awake).push(c);
  return { awake, dormant };
}

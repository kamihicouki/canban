// Board analytics: activity per day, breakdowns with token usage, time spent in
// lists and cycle time to the last list (read from the cards' move history).
import { resolveDirectory } from './store.mjs';

const DAY = 86400e3;

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const localDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function breakdown(sessions, keyOf, limit) {
  const m = new Map();
  for (const s of sessions) {
    const k = keyOf(s) || '（なし）';
    const e = m.get(k) || { name: k, sessions: 0, tokens: 0, codex: 0, claude: 0 };
    e.sessions++;
    e.tokens += s.tokens || 0;
    e[s.agent] = (e[s.agent] || 0) + 1;
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => b.sessions - a.sessions).slice(0, limit);
}

export function computeStats(state, sessions, { days = 30, agent = 'all', host = null, project = null, directory = null, includeSubagents = false, now = Date.now() } = {}) {
  const since = now - days * DAY;
  const pick = sessions.filter(
    (s) =>
      (includeSubagents || !s.subagent) &&
      (agent === 'all' || s.agent === agent) &&
      (!host || (s.host?.local === false ? s.host.id : 'local') === host) &&
      (!project || s.project === project),
  );
  const dirOf = (s) => resolveDirectory(state, state.cards[s.id], s.cwd);
  const dirPick = directory ? pick.filter((s) => (directory === '__none' ? !dirOf(s) : dirOf(s)?.id === directory)) : pick;
  const inRange = dirPick.filter((s) => (s.createdAt || s.updatedAt || 0) >= since);

  // activity per day (created sessions), stacked by agent
  const daily = [];
  for (let t = now - (days - 1) * DAY; t <= now; t += DAY) daily.push({ date: localDate(t), codex: 0, claude: 0, tokens: 0 });
  const byDate = new Map(daily.map((d) => [d.date, d]));
  for (const s of inRange) {
    const d = byDate.get(localDate(s.createdAt || s.updatedAt));
    if (d) {
      d[s.agent] = (d[s.agent] || 0) + 1;
      d.tokens += s.tokens || 0;
    }
  }

  // lists: current count and how long cards have been sitting there
  const lastList = state.lists[state.lists.length - 1]?.id;
  const lists = state.lists.map((l) => ({ id: l.id, title: l.title, color: l.color, cards: 0, dwell: [] }));
  const byList = new Map(lists.map((l) => [l.id, l]));
  const cycles = [];
  const completedWeeks = new Map();
  for (const [id, c] of Object.entries(state.cards)) {
    if (!c.listId || !byList.has(c.listId)) continue;
    const l = byList.get(c.listId);
    l.cards++;
    const hist = c.history || [];
    const entered = [...hist].reverse().find((h) => h.listId === c.listId);
    if (entered) l.dwell.push(now - Date.parse(entered.at));
    const done = hist.find((h) => h.listId === lastList);
    if (done && hist.length > 1) {
      const doneAt = Date.parse(done.at);
      cycles.push({ id, ms: doneAt - Date.parse(hist[0].at), at: doneAt });
      const wk = localDate(doneAt - new Date(doneAt).getDay() * DAY);
      completedWeeks.set(wk, (completedWeeks.get(wk) || 0) + 1);
    }
  }
  const recentCycles = cycles.filter((c) => c.at >= since);
  return {
    days,
    totals: {
      sessions: inRange.length,
      tokens: inRange.reduce((n, s) => n + (s.tokens || 0), 0),
      codex: inRange.filter((s) => s.agent === 'codex').length,
      claude: inRange.filter((s) => s.agent === 'claude').length,
    },
    daily,
    projects: breakdown(inRange, (s) => s.project, 12),
    directories: breakdown(inRange, (s) => dirOf(s)?.name, 12),
    hosts: breakdown(inRange, (s) => (s.host?.local === false ? s.host.label : 'このマシン'), 12),
    agents: breakdown(inRange, (s) => (s.agent === 'codex' ? 'Codex' : 'Claude Code'), 5),
    lists: lists.map(({ dwell, ...l }) => ({ ...l, medianDwellMs: median(dwell) })),
    cycle: {
      doneListId: lastList,
      count: recentCycles.length,
      medianMs: median(recentCycles.map((c) => c.ms)),
      weekly: [...completedWeeks.entries()].sort().slice(-8).map(([week, count]) => ({ week, count })),
    },
  };
}

// Creation-to-update spans. They do not establish continuous activity, progress, or planned work.
const GANTT_DAY_MS = 86400000;
function ganttTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match) {
    const date = new Date(+match[1], +match[2] - 1, +match[3]);
    return date.getFullYear() === +match[1] && date.getMonth() === +match[2] - 1 && date.getDate() === +match[3] ? date.getTime() : null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) && time > 0 ? time : null;
}
function ganttItems(board) {
  const cards = (board?.lists || []).flatMap(list => list.cards || []), full = new Map(cards.map(card => [card.id, card]));
  const tasks = cards.filter(card => card.kind === 'task'), linked = new Set(), rows = [], seen = new Set();
  for (const task of tasks) {
    const children = (task.links || []).filter(link => link && typeof link.id === 'string' && !link.subagent && !linked.has(link.id)).map(link => {
      linked.add(link.id);
      const whole = full.get(link.id);
      return { ...whole, ...link, createdAt: link.createdAt || whole?.createdAt, updatedAt: link.updatedAt || whole?.updatedAt };
    });
    rows.push({ card: { ...task, links: children }, isTask: true, level: 0 });
    for (const child of children) rows.push({ card: child, isTask: false, level: 1, parentId: task.id });
  }
  for (const card of cards) if (card.kind !== 'task' && !linked.has(card.id) && !seen.has(card.id)) {
    rows.push({ card, isTask: false, level: 0 }); seen.add(card.id);
  }
  return rows;
}
function ganttObservation(card, now = Date.now()) {
  if (card.kind === 'task') {
    const children = (card.links || []).filter(child => child && !child.subagent).map(child => ganttObservation(child, now)).filter(Boolean);
    if (!children.length) return null;
    const start = Math.min(...children.map(child => child.start)), end = Math.max(...children.map(child => child.end));
    return { start, end, startKnown: children.every(child => child.startKnown), point: end - start < GANTT_DAY_MS, active: children.some(child => child.active), status: null };
  }
  const updated = ganttTime(card.updatedAt);
  if (updated == null || updated > now) return null;
  const created = ganttTime(card.createdAt), startKnown = created != null && created <= updated;
  const active = card.statusKnown !== false && ['running', 'waiting'].includes(card.status);
  const start = startKnown ? created : updated;
  // Without a known start even a live card is a point, rather than an invented interval.
  const end = startKnown && active ? now : updated;
  return { start, end, startKnown, point: end - start < GANTT_DAY_MS, active, status: card.statusKnown === false ? null : card.status };
}
function ganttRange(cards, period, now = Date.now()) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  let start;
  if (Number(period) > 0) {
    const day = new Date(today); day.setDate(day.getDate() - Math.max(0, Number(period) - 1)); start = day.getTime();
  } else {
    start = (cards || []).reduce((oldest, card) => Math.min(oldest, ganttObservation(card, now)?.start ?? oldest), today.getTime());
    const day = new Date(start); day.setHours(0, 0, 0, 0); start = day.getTime();
  }
  const last = new Date(today); last.setDate(last.getDate() + 1);
  const end = last.getTime(), days = Math.max(1, Math.round((end - start) / GANTT_DAY_MS));
  return { start, end, days };
}
function ganttBar(card, range, now = Date.now()) {
  const observation = ganttObservation(card, now);
  if (!observation || observation.end < range.start || observation.start > range.end) return null;
  const duration = range.end - range.start;
  if (!(duration > 0)) return null;
  const position = observation.point ? observation.end : observation.start;
  const left = (Math.max(range.start, Math.min(range.end, position)) - range.start) / duration * 100;
  const right = (Math.min(range.end, observation.end) - range.start) / duration * 100;
  return { ...observation, left, width: observation.point ? 0 : Math.max(0, right - left), clippedStart: observation.start < range.start, clippedEnd: observation.end > range.end };
}
function ganttDeadline(card, range, now = Date.now()) {
  const at = ganttTime(card.due);
  if (at == null) return null;
  // A date-only deadline lasts through that local calendar day.
  const dateOnly = typeof card.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(card.due);
  const expires = new Date(at); if (dateOnly) expires.setDate(expires.getDate() + 1);
  return { at, overdue: (dateOnly ? expires.getTime() : at) < now, position: at >= range.start && at <= range.end ? (at - range.start) / (range.end - range.start) * 100 : null };
}

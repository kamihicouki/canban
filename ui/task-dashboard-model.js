// Membership is authoritative task.links; these are presentation preferences only.
function taskPanePreferences(taskId, links, saved = [], visible = []) {
  const ids = [taskId, ...new Set(links)], allowed = new Set(ids);
  const order = [...new Set([...saved.map(p => p.id).filter(id => allowed.has(id)), ...ids])];
  const shown = visible.map(p => p.id).filter(id => allowed.has(id));
  let at = 0;
  const ordered = order.map(id => shown.includes(id) ? shown[at++] : id);
  const values = new Map([...saved, ...visible].map(p => [p.id, p]));
  return ordered.map(id => ({ id, space: null, mode: null, size: null, note: false, free: null, hidden: false, ...values.get(id), hidden: id === taskId ? false : values.get(id)?.hidden === true }));
}
function taskVisiblePanes(taskId, links, saved, preset, activeSessionId, page = 0, max = 8) {
  const ordered = taskPanePreferences(taskId, links, saved);
  const sessions = ordered.filter(p => p.id !== taskId && !p.hidden).map(p => p.id);
  const active = sessions.includes(activeSessionId) ? activeSessionId : sessions[0] || null;
  const pages = Math.max(1, Math.ceil(sessions.length / (max - 1)));
  const currentPage = Math.min(pages - 1, Math.max(0, page));
  const shown = ['A', 'B'].includes(preset) ? (active ? [active] : []) : sessions.slice(currentPage * (max - 1), (currentPage + 1) * (max - 1));
  return { ids: [taskId, ...shown], active: shown.includes(active) ? active : shown[0] || null, page: currentPage, pages, total: sessions.length };
}
function taskRequestText(title, description, note) {
  return [title, description, note].map(s => String(s || '').trim()).filter(Boolean).join('\n\n');
}
function taskPaneLayoutDefaults() {
  return { main: ['conv', 'memo', 'related', 'send'], heights: { conv: 110, memo: 120, related: 110 } };
}

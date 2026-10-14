// Same received history, two presentations. Kept pure for the board and tests.
const exchangeModel = (() => {
  const order = (a, b) => (b.at || '').localeCompare(a.at || '') || a.id.localeCompare(b.id);
  const chronological = events => [...events].sort(order);
  function groups(events) {
    const byPeer = new Map();
    for (const event of chronological(events)) {
      if (!byPeer.has(event.peer.id)) byPeer.set(event.peer.id, { peer: event.peer, events: [] });
      byPeer.get(event.peer.id).events.push(event);
    }
    return [...byPeer.values()];
  }
  const relation = value => ({ subagent: 'サブエージェント', parent: '親セッション', collaborator: '同じ実行のエージェント' }[value] || '別セッション');
  return { chronological, groups, relation };
})();

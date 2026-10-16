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
  function delivery(text) {
    const match = /^<codex_delegation>\s*<source_thread_id>([^<>]+)<\/source_thread_id>\s*<input>([\s\S]*?)<\/input>\s*<\/codex_delegation>$/.exec(String(text || '').trim());
    return match ? { source: match[1], text: match[2] } : null;
  }
  const messageText = text => delivery(text)?.text ?? text;
  function matchesDelivery(text, at, event) {
    const parsed = delivery(text), stamp = Date.parse(at);
    return !!parsed && Number.isFinite(stamp) && event.direction === 'received' && event.peer.id === `codex:${parsed.source}` && event.text === parsed.text && Date.parse(event.at) === stamp;
  }
  return { chronological, groups, relation, delivery, messageText, matchesDelivery };
})();

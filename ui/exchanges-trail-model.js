// A visit is a navigation gesture, not another session or an agent relationship.
// Only open() adds a visit; no peer graph is traversed automatically.
const exchangeTrailModel = (() => {
  function start(sessionId) {
    return { root: 'v0', active: 'v0', visits: { v0: { id: 'v0', sessionId, source: null } }, order: ['v0'], history: ['v0'], cursor: 0, next: 1 };
  }
  function focus(state, id) {
    if (!state.visits[id] || state.active === id) return state;
    const history = [...state.history.slice(0, state.cursor + 1), id];
    return { ...state, active: id, history, cursor: history.length - 1 };
  }
  function open(state, source, event) {
    if (!state.visits[source] || !event?.peer?.id || !event.peer.available || !['sent', 'received'].includes(event.direction)) return state;
    const id = `v${state.next}`;
    const visit = { id, sessionId: event.peer.id, source, eventId: event.id, at: event.at, direction: event.direction };
    const order = [...state.order];
    order.splice(order.indexOf(source) + (event.direction === 'sent' ? 1 : 0), 0, id);
    return focus({ ...state, next: state.next + 1, visits: { ...state.visits, [id]: visit }, order }, id);
  }
  function move(state, step) {
    const cursor = state.cursor + step;
    return cursor < 0 || cursor >= state.history.length ? state : { ...state, cursor, active: state.history[cursor] };
  }
  function cards(state) {
    const latest = new Map();
    for (const visit of Object.values(state.visits)) latest.set(visit.sessionId, visit.id);
    const active = state.visits[state.active];
    latest.set(active.sessionId, active.id);
    return state.order.filter(id => latest.get(state.visits[id].sessionId) === id).map(id => state.visits[id]);
  }
  return { start, open, focus, move, cards };
})();

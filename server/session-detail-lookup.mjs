// A local Codex conversation must not wait for every other provider to list its
// history. The fallback retains the established remote/cloud/provider guards.
export function createSessionDetailLookup({ configure = () => {}, findLocalCodex, decorate = s => s, getSnapshot = () => null, fullLookup }) {
  return async (store, cardId) => {
    const local = /^codex:([^:]+)$/.exec(cardId);
    if (!local) return fullLookup(store, cardId);
    const state = await store.load();
    configure(state);
    const session = await findLocalCodex(local[1]);
    if (!session || session.id !== cardId || session.agent !== 'codex' || session.host?.local === false || session.sourceKind === 'codex-cloud') return fullLookup(store, cardId);
    const selected = await decorate(session, state);
    const snapshot = getSnapshot(state);
    return {
      session: selected, state, host: null, sessions: snapshot?.sessions || [],
      coverage: snapshot
        ? { state: 'snapshot', at: snapshot.at, reason: null }
        : { state: 'unavailable', at: null, reason: '関連するセッションは未取得です。会話と入力欄は利用できます。' },
    };
  };
}

// Notes and labels do not change source identity. Account homes, enabled remotes
// and placement (the PR-enrichment scope) do, so older scopes cannot be reused.
export function sessionSnapshotKey(state) {
  return JSON.stringify({
    accounts: state.settings?.accounts || {},
    remotes: Object.entries(state.remoteHosts || {}).sort(([a], [b]) => a.localeCompare(b)),
    placed: Object.entries(state.cards || {}).filter(([, card]) => card.listId).map(([id]) => id).sort(),
  });
}

export function matchingSessionSnapshot(snapshot, state, generation) {
  return snapshot?.generation === generation && snapshot.key === sessionSnapshotKey(state) ? snapshot : null;
}

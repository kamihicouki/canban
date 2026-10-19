// Shared browser boundary for the v1 compact wire model. No catalog lookups or source inference.
const SOURCE_AXES = { codexProject: 'Codexのプロジェクト', claudeEnvironment: 'Claudeの環境', codexSection: 'Codexのセクション', claudeGroup: 'Claudeのグループ', workingFolder: '作業フォルダ' };
const sourceRefKey = ref => ['provider', 'identityDomain', 'scopeId', 'kind', 'nativeId'].every(k => typeof ref?.[k] === 'string' && ref[k].trim()) ? JSON.stringify([1, ref.provider, ref.identityDomain, ref.scopeId, ref.kind, ref.nativeId]) : null;
const sourceCategoryRelation = ref => ({ 'codex:project': 'memberOf', 'codex:section': 'displayedIn', 'claude:group': 'displayedIn', 'claude:environment': 'startedWith' })[`${ref?.provider}:${ref?.kind}`];
const sourceAxis = ref => ({ 'codex:project': 'codexProject', 'codex:section': 'codexSection', 'claude:environment': 'claudeEnvironment', 'claude:group': 'claudeGroup' })[`${ref?.provider}:${ref?.kind}`];
const sourceUnknown = reason => ({ value: null, status: 'unknown', observedAt: null, sourceUpdatedAt: null, source: null, reason });
function expandUiSourceView(wire) {
  const base = { version: 1, attributes: Object.fromEntries(['codexProject', 'codexSection', 'claudeGroup', 'claudeEnvironment'].map(k => [k, sourceUnknown(k === 'claudeEnvironment' ? '開始実績のReceiptは未取得です' : '元アプリの属性は未取得です')])), relations: [], workingLocations: sourceUnknown('作業場所は未取得です') };
  if (wire && !wire.compact) return { ...base, ...wire, attributes: { ...base.attributes, ...wire.attributes } };
  if (!wire) return base;
  const attributes = { ...base.attributes, ...wire.attributes };
  const relations = (wire.relations || []).flatMap(r => {
    if (!r.attribute) return [r];
    const observation = attributes[r.attribute];
    return observation?.value ? [{ type: r.type, ref: observation.value.ref, key: observation.value.key, observation, requestId: r.requestId }] : [];
  });
  return { version: 1, attributes, relations, workingLocations: wire.workingLocations || base.workingLocations };
}
function expandUiCapabilities(wire) {
  if (wire && !wire.compact) return wire;
  const operations = ['open', 'start', 'sendPrompt', 'archive', 'restore', 'delete', 'fork', 'interrupt', 'pin'];
  const full = Object.fromEntries(operations.map(operation => [operation, { operation, status: 'unknown', reason: '操作条件は未取得です', targetId: wire?.targetId ?? null }]));
  full.sendPrompt.reason = '最新の状態・権限・送信設定は未取得です';
  for (const op of ['fork', 'interrupt', 'pin']) full[op] = { operation: op, status: 'unsupported', reason: 'Canbanからの操作には対応していません。元アプリで操作してください', targetId: wire?.targetId ?? null };
  for (const [op, value] of Object.entries(wire?.operations || {})) if (operations.includes(op)) full[op] = { ...full[op], ...value };
  return full;
}
function decodeSourceCard(card) {
  card.sourceView = expandUiSourceView(card.sourceView);
  card.capabilities = expandUiCapabilities(card.capabilities);
  for (const link of card.links || []) if (typeof link === 'object') decodeSourceCard(link);
  return card;
}
function decodeSourceBoard(board) { for (const list of board.lists || []) for (const card of list.cards) decodeSourceCard(card); return board; }
const sourceFacetName = (facet, peers = []) => {
  const name = facet.name || facet.ref.nativeId;
  const same = peers.filter(p => sourceAxis(p.ref) === sourceAxis(facet.ref) && (p.name || p.ref.nativeId) === name);
  return same.length > 1 ? `${name} · ${facet.ref.nativeId.slice(-8)}${same.some(p => p.ref.nativeId === facet.ref.nativeId && sourceRefKey(p.ref) !== sourceRefKey(facet.ref)) ? ` · ${facet.ref.scopeId.slice(-12)}` : ''}` : name;
};
const sourceFacetLabel = (facet, peers = []) => `${SOURCE_AXES[sourceAxis(facet.ref)] || '元アプリ'}: ${sourceFacetName(facet, peers)}`;
const sourceFacetHint = facet => [facet.ref.provider === 'codex' ? 'Codex' : 'Claude', (facet.origins || []).map(o => o === 'planned' ? '開始予定' : '観測').join('・')].filter(Boolean).join(' · ');
const sourceFacetTitle = facet => `${sourceFacetLabel(facet)} · ${facet.ref.scopeId} · ${facet.ref.nativeId}`;
function cardSourceRelations(card) {
  const observed = card.sourceRelations || expandUiSourceView(card.sourceView).relations;
  return [...observed.map(r => ({ ...r, origin: 'observed' })), ...(card.sourceContext || []).map(r => ({ ...r, origin: 'planned' }))];
}
// Display aliases only. Never rewrite the task's raw legacy condition or create a native ref.
function sourceFolderEntries(card) {
  const entries = new Map();
  const clean = folder => typeof folder === 'string' && folder.startsWith('/') ? folder.replace(/\/+$/, '') || '/' : null;
  const add = (folder, origin) => {
    const path = clean(folder); if (!path) return;
    if (!entries.has(path)) entries.set(path, { folder: path, origins: [] });
    const entry = entries.get(path); if (!entry.origins.includes(origin)) entry.origins.push(origin);
  };
  for (const item of [card, ...(card.links || []).filter(link => typeof link === 'object')]) for (const location of expandUiSourceView(item.sourceView).workingLocations.value || []) add(location.folder, 'observed');
  const planned = card.context?.folder;
  if (clean(planned)) add(planned, 'planned');
  else if (planned) {
    const matches = [...entries.keys()].filter(folder => folder.split('/').filter(Boolean).at(-1) === planned);
    if (matches.length === 1) add(matches[0], 'planned');
  }
  return [...entries.values()];
}
function sourceFolders(card) { return sourceFolderEntries(card).map(entry => entry.folder); }
function workingFolderFacets(board) {
  const set = new Map();
  for (const card of (board.lists || []).flatMap(l => l.cards)) for (const entry of sourceFolderEntries(card)) {
    if (!set.has(entry.folder)) set.set(entry.folder, { cwd: entry.folder, name: entry.folder, count: 0, origins: [] });
    const facet = set.get(entry.folder); facet.count++;
    for (const origin of entry.origins) if (!facet.origins.includes(origin)) facet.origins.push(origin);
  }
  return [...set.values()];
}
function sourceLane(card, axis, peers = []) {
  const links = (card.links || []).filter(s => s && typeof s === 'object');
  const completeLinks = !card.missingLinks && !(card.linkedSessionIds?.length > links.length);
  const locationsAbsent = s => {
    const observation = expandUiSourceView(s.sourceView).workingLocations;
    return ['known', 'absent'].includes(observation.status) && Array.isArray(observation.value) && observation.value.length === 0;
  };
  if (axis === 'workingFolder') {
    const folders = sourceFolders(card);
    if (folders.length > 1) return { id: '__multiple', name: '複数', creation: {} };
    if (folders.length) return { id: folders[0], name: folders[0], creation: { context: { folder: folders[0] } } };
    if (card.context?.folder) return { id: `legacy:${card.context.folder}`, name: `旧フォルダ条件: ${card.context.folder}`, legacyCondition: card.context.folder, creation: { context: { folder: card.context.folder } } };
    const absent = card.kind === 'task' ? completeLinks && links.length > 0 && links.every(locationsAbsent) : locationsAbsent(card);
    return absent ? { id: '__absent', name: 'なし（確認済み）', creation: {} } : { id: '__unknown', name: '未取得', creation: {} };
  }
  const set = new Map();
  for (const relation of cardSourceRelations(card)) if (sourceAxis(relation.ref) === axis && !set.has(sourceRefKey(relation.ref))) set.set(sourceRefKey(relation.ref), relation);
  if (set.size > 1) return { id: '__multiple', name: '複数', creation: {} };
  if (set.size) {
    const [key, relation] = [...set][0];
    const name = relation.observation?.value?.name || relation.sessions?.find(s => s.observation?.value)?.observation.value.name || relation.ref.nativeId;
    return { id: key, name: sourceFacetName({ ref: relation.ref, name }, peers), creation: { sourceContext: [{ ref: relation.ref }] } };
  }
  const observation = expandUiSourceView(card.sourceView).attributes[axis];
  const provider = axis.startsWith('codex') ? 'codex' : 'claude';
  const relevant = links.filter(s => !s.agent || s.agent === provider);
  const absent = card.kind === 'task' ? completeLinks && relevant.length > 0 && relevant.every(s => expandUiSourceView(s.sourceView).attributes[axis]?.status === 'absent') : observation?.status === 'absent';
  return absent ? { id: '__absent', name: 'なし（確認済み）', creation: {} } : { id: '__unknown', name: '未取得', creation: {} };
}
function sourceObservationText(observation) {
  const status = observation?.status || 'unknown';
  if (status === 'absent') return 'なし（確認済み）';
  const stamp = observation?.observedAt ? `取得 ${new Date(observation.observedAt).toLocaleString('ja-JP')}` : '取得時刻不明';
  const value = observation?.value;
  const name = Array.isArray(value) ? value.map(l => `${l.executionTarget || '実行先未取得'} · ${l.machineId || 'マシン未取得'} · ${l.folder || 'フォルダ未取得'}${l.branch ? ` · ${l.branch}` : ''}${l.worktree ? ` · Worktree ${l.worktree}` : ''}`).join('\n') : value ? [value.name || value.ref?.nativeId, value.ref ? `ID ${value.ref.nativeId} · scope ${value.ref.scopeId}` : null, value.roots?.length ? `保存フォルダ ${value.roots.join('・')}` : null].filter(Boolean).join(' · ') : null;
  const label = { known: '', stale: '古い情報', unavailable: '取得不能', unknown: '未取得' }[status];
  return [name, label, stamp, observation?.reason].filter(Boolean).join(' · ');
}
function sourceDetailRows(card) {
  const view = expandUiSourceView(card.sourceView);
  const rows = Object.entries(SOURCE_AXES).filter(([axis]) => axis !== 'workingFolder' && card.kind !== 'task' && (axis.startsWith(card.agent || '__unknown') || view.attributes[axis]?.value || view.attributes[axis]?.source || view.relations.some(r => sourceAxis(r.ref) === axis))).map(([axis, label]) => [label, sourceObservationText(view.attributes[axis])]);
  if (card.kind === 'task') {
    if (card.context?.folder) rows.push([card.context.folder.startsWith('/') ? '開始予定の作業フォルダ' : '旧フォルダ条件（開始予定）', card.context.folder]);
    for (const link of card.links || []) if (typeof link === 'object') rows.push([`観測した作業場所 · ${link.title || link.id}`, sourceObservationText(expandUiSourceView(link.sourceView).workingLocations)]);
  } else rows.push(['作業場所', sourceObservationText(view.workingLocations)]);
  if (card.kind === 'task') for (const r of cardSourceRelations(card)) rows.push([r.origin === 'planned' ? '開始予定' : '観測', `${sourceFacetLabel({ ref: r.ref, name: r.observation?.value?.name || r.sessions?.find(s => s.observation?.value)?.observation.value.name })}${r.sessions?.length ? ` · ${r.sessions.length}セッション` : ''} · ${r.ref.scopeId}`]);
  if (card.launchSelection) rows.push(['開始要求', `${card.launchSelection.mode} · ${card.launchSelection.route} · 適用結果とは別の指定です`]);
  for (const receipt of card.launchReceipts || []) rows.push(['適用結果', `${receipt.status === 'confirmed' ? '確認済み' : '未確認'} · ${receipt.requestId} · ${receipt.reason || '元アプリの適用確認は未取得です'}`]);
  return rows;
}
function sourceDetails(card) { return h('section', {}, h('h3', { text: '元アプリ' }), h('dl', { class: 'kv' }, ...sourceDetailRows(card).flatMap(([key, value]) => kv(key, value)))); }
function sourceFilterSelected(ref) { return (state.filters.sourceFilters || []).some(f => sourceRefKey(f.ref) === sourceRefKey(ref)); }
function toggleSourceFilter(ref) {
  const selected = state.filters.sourceFilters || [];
  setScope({ sourceFilters: sourceFilterSelected(ref) ? selected.filter(f => sourceRefKey(f.ref) !== sourceRefKey(ref)) : [...selected, { ref }] });
}

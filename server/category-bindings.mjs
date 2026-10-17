import { sourceKey, sessionSourceView, expandSourceView } from './source-model.mjs';

export const SOURCE_RELATIONS = ['memberOf', 'displayedIn', 'requestedWith', 'startedWith'];
const categoryRelation = ref => ({ 'codex:project': 'memberOf', 'codex:section': 'displayedIn', 'claude:group': 'displayedIn', 'claude:environment': 'startedWith' })[`${ref?.provider}:${ref?.kind}`];
export function normalizeCategoryBindings(value) {
  const selections = normalizeSourceSelections(value);
  if (selections.some(b => categoryRelation(b.ref) !== b.relation)) throw new Error('カテゴリ対応の出典の関係を確認してください');
  return selections;
}
export const sourceRefSchema = { type: 'object', additionalProperties: false, required: ['provider', 'identityDomain', 'scopeId', 'kind', 'nativeId'], properties: Object.fromEntries(['provider', 'identityDomain', 'scopeId', 'kind', 'nativeId'].map(key => [key, { type: 'string', minLength: 1 }])) };
export const sourceSelectionSchema = { type: 'array', maxItems: 50, items: { type: 'object', additionalProperties: false, required: ['ref'], properties: { ref: sourceRefSchema, relation: { type: 'string', enum: SOURCE_RELATIONS } } } };

export function normalizeSourceSelections(value) {
  if (!Array.isArray(value) || value.length > 50) throw new Error('出典の指定を確認してください');
  const unique = new Map();
  for (const item of value) {
    if (!item || Object.keys(item).some(k => !['ref', 'relation'].includes(k)) || !sourceKey(item.ref) || (item.relation !== undefined && !SOURCE_RELATIONS.includes(item.relation))) throw new Error('出典の参照または関係を確認してください');
    const ref = Object.fromEntries(['provider', 'identityDomain', 'scopeId', 'kind', 'nativeId'].map(k => [k, item.ref[k]]));
    const selection = { ref, ...(item.relation ? { relation: item.relation } : {}) };
    unique.set(JSON.stringify([sourceKey(ref), item.relation || null]), selection);
  }
  return [...unique.values()];
}

// The unscoped key remains a compatibility lookup, never a native identity.
export function legacySessionCategory(session) {
  if (!session || !['codex', 'claude'].includes(session.agent)) return null;
  const group = session.agent === 'codex' ? session.codexProject : session.claudeGroup;
  const name = String(group?.name || (session.agent === 'claude' ? session.cwd?.replace(/\/+$/, '').split('/').pop() || session.cwd || '' : '')).trim().slice(0, 80);
  return name ? { name, key: JSON.stringify([session.agent, session.host?.id || 'local', group ? 'group' : 'cwd', group ? group.id || group.name : session.cwd]) } : null;
}

export function pathCategory(directories, cwd) {
  if (!cwd) return null;
  const clean = String(cwd).replace(/\/+$/, '');
  let best = null, length = -1;
  for (const dir of directories || []) for (const p of dir.paths || []) {
    if ((clean === p || clean.startsWith(`${p}/`)) && p.length > length) { best = dir; length = p.length; }
  }
  return best;
}

export function resolveCategory({ card, sourceView, bindings = [], legacy = {} }) {
  if (card?.directoryId === '__none') return { status: 'none', categoryId: null };
  if (card?.directoryId && (!legacy.directories || legacy.directories.some(d => d.id === card.directoryId))) return { status: 'explicit', categoryId: card.directoryId };
  const relations = expandSourceView(sourceView)?.relations || [];
  const suppressed = b => (legacy.tombstones || []).some(t => (!t.categoryId || t.categoryId === b.categoryId) && sourceKey(t.ref) === sourceKey(b.ref) && t.relation === b.relation);
  const ids = [...new Set(bindings.filter(b => sourceKey(b.ref) && categoryRelation(b.ref) === b.relation && !suppressed(b) && relations.some(r => sourceKey(r.ref) === sourceKey(b.ref) && r.type === b.relation)).map(b => b.categoryId))];
  const saved = legacy.cards?.[legacy.sessionId];
  const compatibleId = saved?.categoryId || legacy.fallbackCategoryId;
  const savedId = compatibleId && (!legacy.directories || legacy.directories.some(d => d.id === compatibleId)) && !(legacy.tombstones || []).some(t => (!t.categoryId || t.categoryId === compatibleId) && (t.legacySourceKey && t.legacySourceKey === (saved?.sourceKey || legacy.legacySourceKey) || relations.some(r => sourceKey(t.ref) === sourceKey(r.ref) && t.relation === r.type))) ? compatibleId : null;
  if (ids.length > 1) return { status: 'conflict', categoryId: savedId, categoryIds: ids };
  if (ids.length === 1) return { status: 'bound', categoryId: ids[0] };
  if (savedId) return { status: 'legacy', categoryId: savedId };
  const legacyPath = legacy.agent === 'claude' && (legacy.pathBindings || []).find(b => b.hostId === legacy.hostId && b.path === legacy.cwd && (!legacy.directories || legacy.directories.some(d => d.id === b.categoryId)));
  if (legacyPath) return { status: 'legacy', categoryId: legacyPath.categoryId };
  const path = pathCategory(legacy.directories, legacy.cwd);
  return path ? { status: 'legacy', categoryId: path.id } : { status: 'unclassified', categoryId: null };
}

// Pure dry run. Callers may persist this copy using the existing board payload;
// no source settings, filesystem or physical SQLite schema is changed here.
export function migrateSourceData(input, sessions = [], options = {}) {
  const state = structuredClone(input);
  if (state.categoryMapping?.version === 1 && !state.categoryMapping.snapshotPending) return { state, report: { ...state.categoryMapping.report, alreadyMigrated: true } };
  const pending = state.categoryMapping?.snapshotPending ? state.categoryMapping : null;
  const directories = state.directories || [], ignored = new Set(state.settings?.ignoredCategorySources || []);
  const coverage = options.coverage;
  const complete = coverage?.complete === true && Array.isArray(coverage.expectedHosts) && coverage.expectedHosts.length > 0 && coverage.expectedHosts.every(h => coverage.observedHosts?.includes(h)) && Array.isArray(coverage.expectedAccounts) && coverage.expectedAccounts.every(a => coverage.observedAccounts?.includes(a)) && !coverage.errors?.length && !coverage.unavailableHosts?.length && !coverage.unavailableAccounts?.length;
  const report = { version: 1, unique: 0, partial: 0, ambiguous: 0, unresolved: 0, suppressed: 0, preservedCards: 0, examples: [], viewResolutions: [], unknownReasons: {}, applicable: complete, applicationBlockedReasons: complete ? [] : ['host/accountの取得coverageを完了確認できないため適用不可です'], limits: ['通常のボード取得は移行を適用しません。別途coverage確認・差分確認・sidecar保存を伴う明示適用が必要です。'] };
  const bindings = [], tombstones = [], legacyCards = {}, legacyPathBindings = [];
  const byLegacyKey = new Map();
  for (const session of sessions) {
    const old = legacySessionCategory(session);
    if (!old) continue;
    if (!byLegacyKey.has(old.key)) byLegacyKey.set(old.key, []);
    byLegacyKey.get(old.key).push(session);
    const view = sessionSourceView(session);
    const attribute = session.agent === 'codex' ? view.attributes.codexProject : view.attributes.claudeGroup;
    if (attribute.status === 'unknown') report.unknownReasons[attribute.reason || 'unknown'] = (report.unknownReasons[attribute.reason || 'unknown'] || 0) + 1;
    const dir = directories.find(d => d.sourceKeys?.includes(old.key));
    if (dir && !ignored.has(old.key) && session.id) legacyCards[session.id] = { categoryId: dir.id, sourceKey: old.key };
  }
  const keys = new Set([...directories.flatMap(d => d.sourceKeys || []), ...ignored]);
  for (const key of keys) {
    const candidates = new Map();
    let incomplete = false;
    let nativeId = null;
    let legacyParts;
    try { legacyParts = JSON.parse(key); if (legacyParts[2] === 'group') nativeId = legacyParts[3]; } catch {}
    if (legacyParts?.[0] === 'claude' && legacyParts[2] === 'cwd' && typeof legacyParts[1] === 'string' && typeof legacyParts[3] === 'string' && legacyParts[3].startsWith('/') && !ignored.has(key)) {
      for (const dir of directories.filter(d => d.sourceKeys?.includes(key))) legacyPathBindings.push({ categoryId: dir.id, hostId: legacyParts[1], path: legacyParts[3], legacySourceKey: key });
    }
    for (const session of byLegacyKey.get(key) || []) {
      const view = sessionSourceView(session);
      const r = view.relations.find(r => session.agent === 'codex' ? r.type === 'memberOf' && r.ref.kind === 'project' : r.type === 'displayedIn' && r.ref.kind === 'group');
      if (r && nativeId === r.ref.nativeId) candidates.set(r.key, r);
      else incomplete = true;
    }
    const matches = [...candidates.values()];
    const outcome = matches.length > 1 ? 'ambiguous' : matches.length === 1 ? incomplete ? 'partial' : 'unique' : 'unresolved';
    report[outcome]++;
    const suppressed = ignored.has(key);
    if (suppressed) report.suppressed++;
    if (report.examples.length < 50) report.examples.push({ sourceKey: key, outcome, suppressed, candidateKeys: [...candidates.keys()] });
    if (outcome !== 'unique' && outcome !== 'partial') continue;
    const relation = matches[0];
    if (suppressed) tombstones.push({ ref: relation.ref, relation: relation.type, legacySourceKey: key });
    else for (const dir of directories.filter(d => d.sourceKeys?.includes(key))) bindings.push({ categoryId: dir.id, ref: relation.ref, relation: relation.type, legacySourceKey: key });
  }
  for (const view of state.settings?.views || []) {
    const legacyFilters = structuredClone(view.filters || {});
    for (const field of ['project', 'folder', 'section']) {
      const value = legacyFilters[field];
      if (!value) continue;
      const matching = sessions.filter(s => field === 'section' ? value === '__none' ? !s.codexSection : s.codexSection?.id === value : field === 'folder' && value.startsWith('/') ? s.cwd?.replace(/\/+$/, '') === value.replace(/\/+$/, '') : s[field] === value);
      const candidates = new Map();
      let incomplete = false;
      if (Object.values(state.cards || {}).some(c => c.kind === 'task' && Object.hasOwn(c.context || {}, field) && (value === '__none' ? c.context[field] === null : c.context[field] === value))) incomplete = true;
      for (const session of matching) {
        const attribute = sessionSourceView(session).attributes[field === 'project' ? 'codexProject' : 'codexSection'];
        if (field === 'folder' || !attribute.value) { incomplete = true; continue; }
        const ref = attribute.value.ref;
        candidates.set(sourceKey(ref), { ref, relation: field === 'project' ? 'memberOf' : 'displayedIn' });
      }
      const outcome = candidates.size > 1 ? 'ambiguous' : candidates.size === 1 && !incomplete ? 'unique' : 'unresolved';
      report.viewResolutions.push({ viewId: view.id, field, value, outcome, candidateKeys: [...candidates.keys()] });
      if (outcome !== 'unique') continue;
      view.sourceMigration ||= { version: 1, legacyFilters, convertedFields: [], convertedSelections: [] };
      view.sourceMigration.convertedFields.push(field);
      view.sourceMigration.convertedSelections.push(...candidates.values());
      delete view.filters[field];
      view.filters.sourceFilters = normalizeSourceSelections([...(view.filters.sourceFilters || []), ...candidates.values()]);
    }
  }
  report.preservedCards = Object.keys(legacyCards).length;
  state.categoryMapping = { version: 1, bindings: [...bindings, ...(pending?.bindings || [])], tombstones: [...tombstones, ...(pending?.tombstones || [])], legacyCards, legacyPathBindings, report };
  return { state, report };
}

// Copy-only rollback adapter. Save report.heldViews as a sidecar before running
// an old server, whose normalizer cannot preserve unsupported view filters.
export function rollbackSourceViews(input) {
  const state = structuredClone(input), report = { restoredViewIds: [], heldViews: [] };
  const retained = [];
  for (const view of state.settings?.views || []) {
    const migration = view.sourceMigration;
    const same = (a, b) => sourceKey(a.ref) === sourceKey(b.ref) && a.relation === b.relation;
    const originalSelections = migration?.legacyFilters?.sourceFilters || [];
    const extra = (view.filters.sourceFilters || []).filter(s => !migration?.convertedSelections?.some(c => same(s, c)));
    if (extra.length || originalSelections.length || (view.filters.cardKind && view.filters.cardKind !== 'all')) {
      report.heldViews.push({ ...view, reason: '旧版で表せない出典条件またはカード種別を手動確認してください' });
      continue;
    }
    if (migration) {
      for (const key of migration.convertedFields || []) if (!Object.hasOwn(view.filters, key)) view.filters[key] = migration.legacyFilters[key];
      report.restoredViewIds.push(view.id);
    }
    delete view.filters.sourceFilters;
    delete view.filters.cardKind;
    delete view.sourceMigration;
    retained.push(view);
  }
  if (state.settings) state.settings.views = retained;
  return { state, report };
}

export function categoryBindingConflicts(bindings = []) {
  const bySource = new Map();
  for (const b of bindings) {
    const key = JSON.stringify([sourceKey(b.ref), b.relation]);
    if (!bySource.has(key)) bySource.set(key, { ref: b.ref, relation: b.relation, categoryIds: [] });
    const group = bySource.get(key);
    if (!group.categoryIds.includes(b.categoryId)) group.categoryIds.push(b.categoryId);
  }
  return [...bySource.values()].filter(g => g.categoryIds.length > 1);
}

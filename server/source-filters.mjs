import { sourceKey, sessionSourceView, expandSourceView } from './source-model.mjs';
import { normalizeSourceSelections } from './category-bindings.mjs';

export function sourceRelationsForTask(links = []) {
  const set = new Map();
  for (const session of links) for (const relation of expandSourceView(session.sourceView || sessionSourceView(session))?.relations || []) {
    const key = JSON.stringify([relation.type, sourceKey(relation.ref)]);
    if (!set.has(key)) set.set(key, { type: relation.type, ref: relation.ref, key: sourceKey(relation.ref), sessions: [] });
    const item = set.get(key);
    if (!item.sessions.some(s => s.sessionId === session.id && s.requestId === relation.requestId)) item.sessions.push({ sessionId: session.id, requestId: relation.requestId, observation: relation.observation });
  }
  return [...set.values()];
}

export function matchesSourceFilters(relations, selections = []) {
  return selections.every(f => relations.some(r => sourceKey(r.ref) === sourceKey(f.ref) && (!f.relation || r.type === f.relation)));
}

export function plannedSourceRelations(sourceContext = []) {
  return sourceContext.map(selection => ({ ref: selection.ref, key: sourceKey(selection.ref), type: null, origin: 'planned' }));
}

const legacyMatches = (session, key, value) => key === 'section' ? value === '__none' ? !session.codexSection : session.codexSection?.id === value : key === 'folder' && value.startsWith('/') ? session.cwd?.replace(/\/+$/, '') === value.replace(/\/+$/, '') : session[key] === value;
// Input-only validation of immutable identifiers. Session observations (names,
// folders, missing memberships) never turn an AND condition into an exception.
export function validateSourceFilterCompatibility(filters) {
  const selections = normalizeSourceSelections(filters.sourceFilters || []);
  if (filters.section && selections.some(s => s.ref.provider === 'codex' && s.ref.kind === 'section' && (filters.section === '__none' || s.ref.nativeId !== filters.section))) throw new Error('出典と旧section条件の識別子が矛盾しています');
}

export function sourceFacetsForCards(cards) {
  const facets = new Map();
  for (const card of cards) {
    const observed = card.sourceRelations || expandSourceView(card.sourceView || sessionSourceView(card))?.relations || [];
    const relations = [...observed.map(r => ({ ...r, origin: 'observed' })), ...plannedSourceRelations(card.sourceContext)];
    const counted = new Set();
    for (const r of relations) {
      const key = sourceKey(r.ref);
      if (!facets.has(key)) facets.set(key, { key, ref: r.ref, relations: [], origins: [], name: null, count: 0 });
      const facet = facets.get(key);
      facet.name ||= r.observation?.value?.name || r.sessions?.find(s => s.observation?.value?.name)?.observation.value.name || null;
      if (r.type && !facet.relations.includes(r.type)) facet.relations.push(r.type);
      if (!facet.origins.includes(r.origin)) facet.origins.push(r.origin);
      if (!counted.has(key)) facet.count++;
      counted.add(key);
    }
  }
  return [...facets.values()];
}

export { legacyMatches };

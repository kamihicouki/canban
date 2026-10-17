// Read model only. Identity comes from the source's ownership scope, never a label.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Canonicalize storage paths only. Source-native identifiers remain verbatim.
export function storageScope(value) {
  if (typeof value !== 'string' || !value) return null;
  const expanded = value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  const resolved = path.resolve(expanded);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

const fields = ['provider', 'identityDomain', 'scopeId', 'kind', 'nativeId'];
const attributes = { codexProject: ['codex', 'project', 'memberOf'], codexSection: ['codex', 'section', 'displayedIn'], claudeGroup: ['claude', 'group', 'displayedIn'], claudeEnvironment: ['claude', 'environment', null] };
const string = v => typeof v === 'string' && v.trim() ? v : null;
const time = v => Number.isFinite(v) && v > 0 ? v : null;
const unknown = reason => ({ value: null, status: 'unknown', observedAt: null, sourceUpdatedAt: null, source: null, reason });
const refOf = ref => sourceKey(ref) ? Object.fromEntries(fields.map(k => [k, ref[k]])) : null;

export function sourceKey(ref) {
  return fields.every(k => string(ref?.[k])) ? JSON.stringify([1, ...fields.map(k => ref[k])]) : null;
}

function entity(value) {
  const ref = refOf(value?.ref);
  return ref ? { ref, key: sourceKey(ref), name: string(value.name), product: string(value.product), surface: string(value.surface), roots: Array.isArray(value.roots) ? value.roots.filter(r => string(r)) : [], hostId: string(value.hostId), workingLocations: Array.isArray(value.workingLocations) ? value.workingLocations.filter(v => v && typeof v === 'object').map(v => location(v)) : [] } : null;
}

function entityObservation(raw, provider, kind, catalog) {
  if (!raw) return unknown('元アプリの属性は未取得です');
  const source = string(raw.source), observedAt = time(raw.observedAt), sourceUpdatedAt = time(raw.sourceUpdatedAt);
  if (['absent', 'unavailable', 'unknown'].includes(raw.status)) return { value: null, status: raw.status, observedAt, sourceUpdatedAt, source, reason: string(raw.reason) };
  if (!['known', 'stale'].includes(raw.status) || raw.ref?.provider !== provider || raw.ref?.kind !== kind || !source) return unknown('出典を確認できません');
  const value = entity(raw);
  if (!value) return unknown('識別子または所有元のscopeは未取得です');
  const match = catalog.find(e => sourceKey(e?.ref) === value.key);
  if (match) value.name = string(match.name) || value.name;
  return { value, status: raw.status, observedAt, sourceUpdatedAt, source, reason: string(raw.reason) };
}

const executionTargets = new Set(['local', 'ssh', 'remote', 'cloud', 'wsl', 'remote-control']);
function location(v, defaults = {}) {
  const target = string(v.executionTarget) || defaults.executionTarget;
  return {
    executionTarget: executionTargets.has(target) ? target : null,
    machineId: string(v.machineId) || defaults.machineId || null,
    folder: string(v.folder), repository: string(v.repository), branch: string(v.branch), worktree: string(v.worktree), primary: v.primary === true,
    branchRequested: string(v.branchRequested), worktreeRequested: typeof v.worktreeRequested === 'boolean' ? v.worktreeRequested : null,
  };
}

function workingLocations(session) {
  const cloud = session.sourceKind === 'codex-cloud' || session.host?.cloud === true;
  const explicit = Array.isArray(session.workingLocations);
  const raw = explicit ? session.workingLocations : !cloud && string(session.cwd) ? [{ folder: session.cwd, primary: true, branch: session.branch, repository: session.repo }] : [];
  const value = raw.filter(v => v && typeof v === 'object').map(v => location(v, {
    executionTarget: cloud ? 'cloud' : session.host?.local === false ? 'ssh' : session.host?.local === true ? 'local' : null,
    machineId: cloud ? null : string(session.host?.id),
  }));
  return !value.length && !explicit ? unknown('作業場所は未取得です') : { value, status: value.length ? 'known' : 'absent', observedAt: time(session.sourceObservedAt), sourceUpdatedAt: time(session.updatedAt), source: 'session', reason: null };
}

export function sessionSourceView(session, catalog = {}, receipts = session.launchReceipts || []) {
  const entities = Array.isArray(catalog.entities) ? catalog.entities : [];
  const view = { version: 1, attributes: {}, relations: [], workingLocations: workingLocations(session) };
  const addRelation = (type, observation, requestId = null) => {
    if (!observation.value) return;
    const ref = observation.value.ref, key = observation.value.key;
    if (!view.relations.some(r => r.type === type && r.key === key && r.requestId === requestId)) view.relations.push({ type, ref, key, observation, requestId });
  };
  for (const [attribute, [provider, kind, relation]] of Object.entries(attributes)) {
    const observation = attribute === 'claudeEnvironment' ? unknown('開始実績のReceiptは未取得です') : entityObservation(session.sourceMetadata?.[attribute], provider, kind, entities);
    view.attributes[attribute] = observation;
    if (relation) addRelation(relation, observation);
  }
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    if (!session.id || receipt?.sessionId !== session.id || receipt.status !== 'confirmed') continue;
    for (const [field, type] of [['selectedRefs', 'requestedWith'], ['appliedRefs', 'startedWith']]) {
      for (const ref of Array.isArray(receipt[field]) ? receipt[field] : []) {
        const found = entities.find(e => sourceKey(e?.ref) && sourceKey(e.ref) === sourceKey(ref));
        const value = entity(found || { ref });
        if (!value) continue;
        const observation = { value, status: 'known', observedAt: time(receipt.observedAt), sourceUpdatedAt: null, source: 'launch-receipt', reason: null };
        addRelation(type, observation, string(receipt.requestId));
        if (type === 'startedWith' && ref.provider === 'claude' && ref.kind === 'environment') view.attributes.claudeEnvironment = observation;
      }
    }
  }
  return view;
}

// Board transport only. Omitted fields are the exact sessionSourceView({}) defaults.
// Relations may name an attribute in this same object, never another card/session.
export function compactSourceView(view) {
  const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
  const attributes = Object.fromEntries(Object.entries(view.attributes).filter(([key, observation]) => JSON.stringify(observation) !== defaultAttributeJson[key]));
  const relations = view.relations.map(relation => {
    const attribute = Object.keys(attributes).find(key => same(attributes[key], relation.observation));
    return attribute ? { type: relation.type, attribute, requestId: relation.requestId } : relation;
  });
  return { version: 1, compact: true, attributes, relations, ...(JSON.stringify(view.workingLocations) !== defaultLocationJson ? { workingLocations: view.workingLocations } : {}) };
}

export function expandSourceView(wire) {
  if (!wire?.compact) return wire;
  const defaults = sessionSourceView({});
  const attributes = { ...defaults.attributes, ...wire.attributes };
  const relations = (wire.relations || []).map(relation => {
    if (!relation.attribute) return relation;
    const observation = attributes[relation.attribute];
    return { type: relation.type, ref: observation.value.ref, key: observation.value.key, observation, requestId: relation.requestId };
  });
  return { version: 1, attributes, relations, workingLocations: wire.workingLocations || defaults.workingLocations };
}

const defaultAttributeJson = Object.fromEntries(Object.entries(sessionSourceView({}).attributes).map(([key, value]) => [key, JSON.stringify(value)]));
const defaultLocationJson = JSON.stringify(sessionSourceView({}).workingLocations);

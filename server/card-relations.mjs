// Explicit user-authored relations. They are independent from task membership,
// agent parentage, launch receipts and message exchanges, and never drive execution.
export const MANUAL_RELATION_KINDS = ['ref', 'blocks', 'derived'];
const relationFields = ['id', 'kind', 'fromId', 'toId', 'createdAt'];
export function assertRelationCardId(value) {
  if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z][A-Za-z0-9_-]*(?:@[^:\s\u0000-\u001f]+)?:[^\s\u0000-\u001f]+$/.test(value)) throw new Error('カードIDが正しくありません');
  return value;
}
function assertRelationId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('関連IDが正しくありません');
  return value;
}
export function canonicalManualRelation({ kind, fromId, toId } = {}) {
  if (!MANUAL_RELATION_KINDS.includes(kind)) throw new Error('関連の種類が正しくありません');
  assertRelationCardId(fromId); assertRelationCardId(toId);
  if (fromId === toId) throw new Error('自分自身には関連付けられません');
  if (kind === 'ref' && fromId > toId) [fromId, toId] = [toId, fromId];
  return { kind, fromId, toId };
}
export function normalizeManualRelations(value) {
  if (!Array.isArray(value)) return [];
  const result = [], ids = new Set(), keys = new Set();
  for (const row of value) {
    try {
      assertRelationId(row?.id);
      if (typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))) continue;
      const relation = { id: row.id, ...canonicalManualRelation(row), createdAt: row.createdAt };
      const key = JSON.stringify([relation.kind, relation.fromId, relation.toId]);
      if (ids.has(relation.id) || keys.has(key)) continue;
      ids.add(relation.id); keys.add(key); result.push(relation);
    } catch { /* Invalid new-field records cannot become executable or mutate other card data. */ }
  }
  return result;
}
function reaches(relations, kind, start, target) {
  const next = new Map();
  for (const edge of relations) if (edge.kind === kind) {
    if (!next.has(edge.fromId)) next.set(edge.fromId, []);
    next.get(edge.fromId).push(edge.toId);
  }
  const queue = [start], seen = new Set();
  while (queue.length) {
    const id = queue.pop();
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id); queue.push(...(next.get(id) || []));
  }
  return false;
}
export function addManualRelation(value, input, { id, createdAt } = {}) {
  const relations = normalizeManualRelations(value), edge = canonicalManualRelation(input);
  const existing = relations.find(r => r.kind === edge.kind && r.fromId === edge.fromId && r.toId === edge.toId);
  if (existing) return { relations, relation: existing, created: false };
  if (edge.kind !== 'ref' && reaches(relations, edge.kind, edge.toId, edge.fromId)) throw new Error('同じ種類の関連が循環するため追加できません');
  assertRelationId(id);
  if (relations.some(r => r.id === id)) throw new Error('関連IDが重複しています');
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) throw new Error('関連の作成時刻が正しくありません');
  const relation = { id, ...edge, createdAt };
  return { relations: [...relations, relation], relation, created: true };
}
export function removeManualRelation(value, { relationId, expectedRelation } = {}) {
  assertRelationId(relationId);
  if (!expectedRelation || relationFields.some(k => expectedRelation[k] === undefined) || expectedRelation.id !== relationId) throw new Error('削除前に確認した期待する関連を指定してください');
  const relations = normalizeManualRelations(value), current = relations.find(r => r.id === relationId);
  if (!current) return { relations, relationId, removed: false };
  if (!relationFields.every(k => current[k] === expectedRelation[k])) throw new Error('関連が変更されているため削除しません');
  return { relations: relations.filter(r => r.id !== relationId), relationId, removed: true };
}
export function queryManualRelations(value, cardId) {
  assertRelationCardId(cardId);
  return normalizeManualRelations(value).filter(r => r.fromId === cardId || r.toId === cardId).map(r => ({ ...r,
    direction: r.kind === 'ref' ? 'undirected' : r.fromId === cardId ? 'outgoing' : 'incoming',
  }));
}

// This is the linked sessions' aggregate, never a claim that the task itself completed.
export function manualTaskSessionState(task) {
  const all = Array.isArray(task.links) ? task.links : [];
  const count = Array.isArray(task.linkedSessionIds) ? new Set(task.linkedSessionIds).size : all.length;
  const known = all.filter(link => link && typeof link === 'object' && link.statusKnown !== false && typeof link.status === 'string');
  let status = null;
  if (known.some(link => link.status === 'waiting')) status = 'waiting';
  else if (known.some(link => link.status === 'aborted')) status = 'aborted';
  else if (known.some(link => link.status === 'running')) status = 'running';
  else if (known.length) status = known.every(link => link.status === 'completed') ? 'completed' : 'idle';
  return { status, statusKnown: known.length > 0, statusScope: 'linked-sessions', statusPartial: known.length < count, linkedSessionCount: count };
}

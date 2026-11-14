// Agent reports are append-only proposals, never human confirmation or session history.
import crypto from 'node:crypto';
import { assertRelationCardId } from './card-relations.mjs';

function requireTask(state, taskId) {
  if (typeof taskId !== 'string' || !taskId.startsWith('task:')) throw new Error('タスクカードIDを確認してください');
  assertRelationCardId(taskId);
  const card = state.cards?.[taskId];
  if (card?.kind !== 'task') throw new Error('タスクカードが見つかりません');
  return card;
}
const record = card => card.handoff || { revision: 0, notes: [], nextAction: null };
const publicNote = note => {
  const { id, text, at, source, sourceSessionId, proposedNextAction } = note;
  return { id, text, at, source, sourceSessionId, ...(proposedNextAction !== undefined ? { proposedNextAction } : {}) };
};
export function taskHandoffSummary(card) {
  const handoff = record(card), notes = handoff.notes || [], last = notes.at(-1);
  return { revision: handoff.revision, nextAction: handoff.nextAction || null, totalNotes: notes.length, latestNoteSummary: last ? { ...publicNote(last), text: last.text.slice(0, 300) } : null };
}
export function taskHandoffRecord(state, { taskId, after, limit = 10 }) {
  const card = requireTask(state, taskId);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('取得件数は1〜20を指定してください');
  const handoff = record(card), notes = handoff.notes || [];
  const cursor = after === undefined ? -1 : notes.findIndex(note => note.id === after);
  if (after !== undefined && cursor < 0) throw new Error('引継ぎカーソルが見つかりません');
  const page = notes.slice(cursor + 1, cursor + 1 + limit);
  const summary = taskHandoffSummary(card);
  const keys = ['title', 'description', 'context', 'sourceContext', 'listId', 'note', 'priority', 'due', 'labels', 'directoryId', 'createdAt', 'updatedAt'];
  const fields = Object.fromEntries(keys.filter(key => card[key] !== undefined).map(key => [key, structuredClone(card[key])]));
  const list = state.lists?.find(list => list.id === card.listId);
  return { task: { cardId: taskId, kind: 'task', ...fields, linkedSessionIds: [...(card.links || [])], ...summary, nextAction: summary.nextAction?.text ?? null, nextActionReport: summary.nextAction, notes: page.map(publicNote), nextCursor: cursor + 1 + page.length < notes.length ? page.at(-1).id : null }, list: list ? { id: list.id, title: list.title } : null };
}
export function appendTaskHandoff(state, args) {
  const { taskId, text, sourceSessionId, nextAction, expectedRevision, clientRequestId } = args;
  const card = requireTask(state, taskId), handoff = record(card);
  if (typeof text !== 'string' || !text.trim() || text.length > 20000) throw new Error('報告本文を1〜20000文字で入力してください');
  if (typeof clientRequestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(clientRequestId)) throw new Error('追記リクエストが正しくありません');
  if (sourceSessionId !== undefined) assertRelationCardId(sourceSessionId);
  const hasNext = Object.hasOwn(args, 'nextAction');
  if (hasNext && nextAction !== null && (typeof nextAction !== 'string' || !nextAction.trim() || nextAction.length > 2000)) throw new Error('次の行動は1〜2000文字かnullで指定してください');
  if ((hasNext || expectedRevision !== undefined) && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new Error('期待リビジョンを指定してください');
  const requestHash = crypto.createHash('sha256').update(JSON.stringify({ text, sourceSessionId: sourceSessionId ?? null, ...(hasNext ? { nextAction } : {}) })).digest('hex');
  const prior = handoff.notes.find(note => note.clientRequestId === clientRequestId);
  const result = extra => ({ taskId, revision: handoff.revision, nextAction: handoff.nextAction?.text ?? null, nextActionReport: handoff.nextAction || null, ...extra });
  if (prior) {
    if (prior.requestHash !== requestHash) throw new Error('同じ追記リクエストに異なる内容は保存できません');
    return result({ saved: false, duplicate: true, note: publicNote(prior) });
  }
  if (sourceSessionId !== undefined && !(card.links || []).includes(sourceSessionId)) throw new Error('報告元はタスクに紐付いたセッションを指定してください');
  if (expectedRevision !== undefined && handoff.revision !== expectedRevision) return result({ saved: false, conflict: true });
  const at = new Date().toISOString(), id = crypto.randomUUID();
  const note = { id, text, at, source: 'reported', sourceSessionId: sourceSessionId ?? null, clientRequestId, requestHash, ...(hasNext ? { proposedNextAction: nextAction } : {}) };
  const updated = { revision: handoff.revision + 1, notes: [...handoff.notes, note], nextAction: hasNext ? (nextAction === null ? null : { text: nextAction, at, noteId: id, source: 'reported', sourceSessionId: sourceSessionId ?? null }) : handoff.nextAction };
  card.handoff = updated;
  card.updatedAt = at;
  return { saved: true, taskId, revision: updated.revision, note: publicNote(note), nextAction: updated.nextAction?.text ?? null, nextActionReport: updated.nextAction || null };
}

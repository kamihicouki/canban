// Explicit card-to-card references; these links never start or send work.
import { buildBoard } from '../board.mjs';
import { assertRelationCardId, canonicalManualRelation, MANUAL_RELATION_KINDS, manualTaskSessionState } from '../card-relations.mjs';
import { appAndModel } from './shared.mjs';

const cardId = { type: 'string', minLength: 1, maxLength: 1024 };
const kind = { type: 'string', enum: MANUAL_RELATION_KINDS };
const expectedRelation = { type: 'object', properties: { id: { type: 'string' }, kind, fromId: cardId, toId: cardId, createdAt: { type: 'string' } }, required: ['id', 'kind', 'fromId', 'toId', 'createdAt'], additionalProperties: false };
const missingCard = id => ({ id, title: '未取得のカード', kind: id.startsWith('task:') ? 'task' : 'session', agent: null, surface: null, status: null, statusKnown: false, archived: null, available: false });
async function relationCards(store) {
  const state = await store.load(), cards = new Map();
  for (const [id, card] of Object.entries(state.cards)) if (card.kind === 'task') cards.set(id, { id, ...card });
  try {
    const board = await buildBoard(store, { days: 0, includeArchived: true, includeSubagents: true, dotScope: 'all' }, { readOnly: true, includeLinkedSessions: true });
    for (const list of board.lists) for (const card of list.cards) cards.set(card.id, card);
    return { cards, errors: board.errors || [] };
  } catch (error) {
    // Keep saved references visible even when an agent source cannot be inspected.
    return { cards, errors: [error?.message || 'カードの取得を確認できません'] };
  }
}
function cardView(cards, id) {
  const card = cards.get(id);
  if (!card) return missingCard(id);
  const task = card.kind === 'task';
  const observed = task ? manualTaskSessionState(card) : { status: card.statusKnown !== false ? card.status || null : null, statusKnown: card.statusKnown !== false, statusScope: 'session' };
  return { id, title: card.title || '（無題）', kind: task ? 'task' : 'session', agent: card.agent || null, surface: card.surface || null,
    ...observed, archived: typeof card.archived === 'boolean' ? card.archived : null, available: true };
}
export function cardRelationTools({ store }) {
  return [
    {
      name: 'canban_get_card_relations', title: 'カードの関連を取得',
      description: '明示的に関連付けた参照・依存・派生を読み取る。タスクの所属、エージェントの親子、実行記録には混ぜない。取得できない相手の辺も保持する。',
      inputSchema: { type: 'object', properties: { cardId }, required: ['cardId'], additionalProperties: false },
      annotations: { readOnlyHint: true }, _meta: appAndModel,
      handler: async ({ cardId: id }) => {
        assertRelationCardId(id);
        const saved = await store.getCardRelations({ cardId: id });
        const { cards, errors } = await relationCards(store);
        const relations = saved.relations.map(edge => ({ ...edge, other: cardView(cards, edge.fromId === id ? edge.toId : edge.fromId) }));
        return { text: `${relations.length}件の関連${errors.length ? '（一部未取得）' : ''}`, structured: { cardId: id, card: cardView(cards, id), relations, errors } };
      },
    },
    {
      name: 'canban_link_card_relation', title: 'カードを関連付ける',
      description: '選んだ2枚を明示的に関連付ける。refは無向参照、blocksは先行→後続、derivedは親→派生。自己辺と同じ型の循環を拒否し、同じ辺は重複作成しない。エージェントを実行しない。',
      inputSchema: { type: 'object', properties: { fromId: cardId, toId: cardId, kind }, required: ['fromId', 'toId', 'kind'], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }, _meta: appAndModel,
      handler: async input => {
        const edge = canonicalManualRelation(input);
        const existing = (await store.getCardRelations({ cardId: edge.fromId })).relations.find(r => r.kind === edge.kind && r.fromId === edge.fromId && r.toId === edge.toId);
        if (!existing) {
          const { cards } = await relationCards(store);
          for (const id of [edge.fromId, edge.toId]) if (!cards.has(id)) throw new Error('関連付けるカードを取得できません。現在のカードを確認してください');
        }
        const result = await store.linkCardRelation(edge);
        return { text: result.created ? 'カードを関連付けました' : '既に関連付けられています', structured: result };
      },
    },
    {
      name: 'canban_unlink_card_relation', title: 'カードの関連を解除',
      description: '確認した関連だけを解除する。relationIdと表示時のexpectedRelationを照合し、変更された辺やカード本体は削除しない。',
      inputSchema: { type: 'object', properties: { relationId: { type: 'string', minLength: 1, maxLength: 128 }, expectedRelation }, required: ['relationId', 'expectedRelation'], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }, _meta: appAndModel,
      handler: async input => {
        const result = await store.unlinkCardRelation(input);
        return { text: result.removed ? '関連を解除しました' : '関連は既に解除されています', structured: result };
      },
    },
  ];
}

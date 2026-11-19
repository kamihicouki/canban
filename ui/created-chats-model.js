// 作成されたチャット（Codex create_thread）の親子関係表示用純粋モデル。
// DOM や共有状態に依存せず、単体テストでも直接実行できる。
const CREATED_FAMILY_TONES = ['teal', 'orange', 'purple', 'sky', 'pink'];

function createdFamilyTone(parentId) {
  if (!parentId) return null;
  let hash = 0;
  for (let i = 0; i < parentId.length; i++) hash = ((hash * 31) + parentId.charCodeAt(i)) | 0;
  return CREATED_FAMILY_TONES[Math.abs(hash) % CREATED_FAMILY_TONES.length];
}

function createdFamilyIdOf(card) {
  if (!card || card.kind === 'task') return null;
  if (card.createdChats?.total > 0) return card.id;
  if (card.createdParent?.id) return card.createdParent.id;
  return null;
}

function createdChatsSummaryText(createdChats) {
  if (!createdChats?.total) return '';
  const parts = [`${createdChats.total}件`];
  if (createdChats.waiting) parts.push(`入力待ち ${createdChats.waiting}`);
  if (createdChats.running) parts.push(`実行中 ${createdChats.running}`);
  if (createdChats.aborted) parts.push(`中断 ${createdChats.aborted}`);
  if (createdChats.completed) parts.push(`応答済 ${createdChats.completed}`);
  return parts.join(' · ');
}

// 案B：同じリストの起きているカード内で、親カードの直下に直接の子カードをネストさせる。
// 他リストへ移った子や休眠中の子はリスト別・休眠別の案内件数にまとめる。
function groupListWithCreatedChats(awakeCards, { listId = null, allLists = [], dormantIds = new Set(), collapsedParents = new Set() } = {}) {
  const listTitleById = new Map((allLists || []).map((l) => [l.id, l.title || l.id]));
  const visibleListByCardId = new Map();
  for (const list of allLists || []) {
    for (const c of list.cards || []) visibleListByCardId.set(c.id, list.id);
  }
  for (const c of awakeCards || []) {
    if (listId && !visibleListByCardId.has(c.id)) visibleListByCardId.set(c.id, listId);
  }

  const awakeById = new Map((awakeCards || []).map((c) => [c.id, c]));
  const parentIdsInList = new Set((awakeCards || []).filter((c) => c.createdChats?.total > 0).map((c) => c.id));
  const nestedByParent = new Map();
  const consumed = new Set();

  for (const c of awakeCards || []) {
    const pid = c.createdParent?.id;
    // 親が同じリストに居て、かつ子自身が別の子を束ねる親でない場合のみ直下ネストする（循環や多段複雑化を防ぐ）
    if (!pid || pid === c.id || !parentIdsInList.has(pid) || c.createdChats?.total > 0) continue;
    if (!nestedByParent.has(pid)) nestedByParent.set(pid, []);
    nestedByParent.get(pid).push(c);
    consumed.add(c.id);
  }

  const out = [];
  for (const card of awakeCards || []) {
    if (consumed.has(card.id)) continue;
    if (!card.createdChats?.total) {
      out.push({ card, nestedChildren: [], collapsed: false, remoteGroups: [], dormantCount: 0, hiddenCount: 0 });
      continue;
    }
    const nestedChildren = nestedByParent.get(card.id) || [];
    const nestedIds = new Set(nestedChildren.map((c) => c.id));
    const remoteCounts = new Map();
    let dormantCount = 0;
    let hiddenCount = 0;

    for (const child of card.createdChats.children || []) {
      if (nestedIds.has(child.id)) continue;
      if (dormantIds.has(child.id)) {
        dormantCount++;
        continue;
      }
      const otherListId = visibleListByCardId.get(child.id);
      if (otherListId && otherListId !== listId) {
        remoteCounts.set(otherListId, (remoteCounts.get(otherListId) || 0) + 1);
      } else if (!awakeById.has(child.id)) {
        hiddenCount++;
      }
    }

    const remoteGroups = [...remoteCounts.entries()].map(([rid, count]) => ({
      listId: rid,
      listTitle: listTitleById.get(rid) || rid,
      count,
    }));

    out.push({
      card,
      nestedChildren,
      collapsed: collapsedParents.has(card.id),
      remoteGroups,
      dormantCount,
      hiddenCount,
    });
  }
  return out;
}

// 案B（親子ネスト連結スタック）の UI 部品・操作・ファミリー照らし・ホバー連動。
state.collapsedCreatedParents = new Set(store.get('collapsedCreatedParents', []));

function toggleCreatedParent(parentId) {
  if (!parentId) return;
  if (state.collapsedCreatedParents.has(parentId)) state.collapsedCreatedParents.delete(parentId);
  else state.collapsedCreatedParents.add(parentId);
  store.set('collapsedCreatedParents', [...state.collapsedCreatedParents]);
  render();
}

function toggleFamilyLens(parentId, title) {
  if (!parentId) return;
  if (state.lens?.family === parentId) pinLens(null);
  else pinLens({ family: parentId, title: title || '作成されたチャット' });
}

function createdFamilyTitle(familyId) {
  const hit = findCard(familyId);
  if (hit?.card?.title) return hit.card.title;
  const fromBoard = state.board?.lists?.flatMap((l) => l.cards || []).find((c) => c.createdParent?.id === familyId)?.createdParent?.title;
  return fromBoard || '親チャット';
}

function selectedCreatedFamily() {
  const pane = !paneLayer.hidden && (!paneDocked() || inDockedPane(document.activeElement)) ? focusedPane() : null;
  const id = pane?.kind === 'session'
    ? pane.id
    : document.activeElement?.closest?.('[data-card-id]')?.dataset.cardId
      || (inboxOn() ? state.inbox.sel : typeof ganttOn === 'function' && ganttOn() ? state.gantt.sel : null);
  if (!id) return null;
  const hit = findCard(id);
  const card = hit?.link || hit?.card || (pane?.d?.session ? { ...pane.d.session, createdParent: pane.d.createdParent, createdChats: pane.d.createdChats?.length ? { total: pane.d.createdChats.length } : null } : null);
  const familyId = createdFamilyIdOf(card);
  if (!familyId) return null;
  const parentId = card.createdParent?.id || null;
  return {
    cardId: id,
    familyId,
    title: createdFamilyTitle(familyId),
    parentId,
    parentAvailable: card.createdParent?.available !== false,
    hasChildren: !!(card.createdChats?.total || card.createdChats?.length),
  };
}

function renderCreatedChatsBar(card, stack = null) {
  const collapsed = stack ? stack.collapsed : state.collapsedCreatedParents.has(card.id);
  const sameCount = stack ? stack.nestedChildren.length : 0;
  const otherCount = card.createdChats.total - sameCount;
  const counts = [sameCount ? `同列 ${sameCount}` : '', otherCount ? `他 ${otherCount}` : ''].filter(Boolean).join(' · ');
  return h('button', {
    type: 'button',
    class: 'cc-parent-bar',
    'aria-expanded': String(!collapsed),
    title: '同じリストの子カードを開閉（他リストは照らしで強調）',
    onpointerdown: (e) => e.stopPropagation(),
    onclick: (e) => { e.stopPropagation(); toggleCreatedParent(card.id); },
  },
    h('span', { class: 'cc-ic', html: picon('branch', 12) }),
    h('span', { class: 'cc-bar-label ellipsis', text: `作成チャット ${createdChatsSummaryText(card.createdChats)}` }),
    counts ? h('span', { class: 'cc-bar-meta', text: counts }) : null,
    h('span', { class: `cc-chev${collapsed ? ' is-collapsed' : ''}`, html: picon('chev', 12) }),
  );
}

function renderCreatedParentBand(card) {
  const p = card.createdParent;
  if (!p) return null;
  const label = p.title ? `親: ${p.title}` : '作成元チャット（未取得）';
  return h('button', {
    type: 'button',
    class: 'cc-parent-band',
    disabled: !p.available && !findCard(p.id),
    title: p.available ? `${p.title} の親子を照らす / 開く` : '親チャットの情報は現在の保存先にありません',
    onpointerdown: (e) => e.stopPropagation(),
    onclick: (e) => {
      e.stopPropagation();
      const parentEl = document.querySelector(`#board .card[data-card-id="${CSS.escape(p.id)}"]`);
      if (parentEl) {
        toggleFamilyLens(p.id, p.title);
        parentEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      } else if (p.available) {
        openCard(p.id);
      }
    },
  },
    h('span', { class: 'cc-ic', html: picon('branch', 11) }),
    h('span', { class: 'ellipsis', text: label }),
  );
}

function remoteCreatedNoteText(item) {
  const bits = item.remoteGroups.map((g) => `『${g.listTitle}』に${g.count}件`);
  if (item.dormantCount) bits.push(`休眠中${item.dormantCount}件`);
  if (item.hiddenCount) bits.push(`絞り込み外${item.hiddenCount}件`);
  return `ほか ${bits.join('・')}`;
}

function renderCreatedStack(item, list) {
  const { card, nestedChildren, collapsed, remoteGroups, dormantCount, hiddenCount } = item;
  if (!card.createdChats?.total) return renderCard(card, list);
  const stack = h('div', {
    class: 'cc-stack',
    'data-family-id': card.id,
    'data-family-tone': createdFamilyTone(card.id),
  }, renderCard(card, list, { createdStack: item }));

  const hasRemote = remoteGroups.length > 0 || dormantCount > 0 || hiddenCount > 0;
  if (!collapsed && (nestedChildren.length > 0 || hasRemote)) {
    const childrenBox = h('div', { class: 'cc-stack-children' },
      ...nestedChildren.map((child) => renderCard(child, list, { nestedChild: true })),
    );
    if (hasRemote) {
      const lit = state.lens?.family === card.id;
      childrenBox.append(h('button', {
        type: 'button',
        class: `cc-stack-remote${lit ? ' is-lit' : ''}`,
        'aria-pressed': String(lit),
        title: '親と別の列・休眠中にある作成チャットをボード上で照らします',
        onpointerdown: (e) => e.stopPropagation(),
        onclick: (e) => {
          e.stopPropagation();
          toggleFamilyLens(card.id, card.title);
          if (state.lens?.family === card.id) {
            const target = [...document.querySelectorAll(`#board .card[data-family-id="${CSS.escape(card.id)}"]`)].find((el) => el.dataset.cardId !== card.id);
            target?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          }
        },
      },
        h('span', { class: 'ellipsis', text: remoteCreatedNoteText(item) }),
        h('span', { class: 'cc-remote-act', text: lit ? '照らし中' : '照らす ↗' }),
      ));
    }
    stack.append(childrenBox);
  }
  return stack;
}

// ボード上での親子ホバー連動（再描画を起こさずクラスだけで軽量にハイライト）
let hoveredCreatedFamily = null;
function setCreatedFamilyHover(familyId) {
  if (hoveredCreatedFamily === familyId) return;
  hoveredCreatedFamily = familyId;
  for (const el of document.querySelectorAll('#board .card.cc-fam-hover')) el.classList.remove('cc-fam-hover');
  if (!familyId) return;
  for (const el of document.querySelectorAll(`#board .card[data-family-id="${CSS.escape(familyId)}"]`)) {
    el.classList.add('cc-fam-hover');
  }
}

document.addEventListener('pointerover', (e) => {
  if (state.drag || lensActive()) return;
  const card = e.target?.closest?.('#board .card[data-family-id]');
  if (!card) return;
  setCreatedFamilyHover(card.dataset.familyId || null);
});

document.addEventListener('pointerout', (e) => {
  const fromCard = e.target?.closest?.('#board .card[data-family-id]');
  if (!fromCard) return;
  const toCard = e.relatedTarget?.closest?.('#board .card[data-family-id]');
  if (!toCard) setCreatedFamilyHover(null);
  else if (toCard.dataset.familyId !== fromCard.dataset.familyId) setCreatedFamilyHover(toCard.dataset.familyId || null);
});

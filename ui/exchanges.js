// Layer 4: read-only session messages. Opening this popover never marks a card seen.
let exchangesView = 'timeline';
let exchangePopup = null;

// Delayed hover is transient. Clicking its existing entry pins the same popup.
function createExchangeHover({ open, close, later = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id) }) {
  let showing, leaving;
  const clear = () => { cancel(showing); cancel(leaving); showing = leaving = null; };
  return {
    enter(anchor, card) { clear(); showing = later(() => { showing = null; if (anchor.isConnected) open(anchor, card); }, 420); },
    leave() { clear(); leaving = later(() => { leaving = null; close(); }, 220); },
    cancel: clear,
  };
}
let exchangeHoverController = null;
function exchangeHover() {
  return exchangeHoverController ||= createExchangeHover({
    open(anchor, card) {
      if (document.querySelector('dialog[open]') || document.querySelector('.popover:not(.exchange-popover)') ||
          (exchangePopup?.isConnected && !exchangePopup.exchangeTransient)) return;
      openExchanges(anchor, card, { transient: true });
    },
    close() { if (exchangePopup?.isConnected && exchangePopup.exchangeTransient) closePopover(exchangePopup); },
  });
}
function exchangeHoverTarget(target) {
  const pill = target?.closest?.('.exchange-pill') || target?.closest?.('.card[data-card-id]')?.querySelector('.exchange-pill');
  return pill?.exchangeCard ? pill : null;
}
document.addEventListener('pointerover', e => {
  if (e.pointerType === 'touch' || e.buttons) return;
  const pill = exchangeHoverTarget(e.target);
  if (!pill || exchangeHoverTarget(e.relatedTarget) === pill) return;
  exchangeHover().enter(pill, pill.exchangeCard);
});
document.addEventListener('pointerout', e => {
  const pill = exchangeHoverTarget(e.target);
  if (pill && exchangeHoverTarget(e.relatedTarget) !== pill) exchangeHover().leave();
});
document.addEventListener('pointerdown', () => exchangeHoverController?.cancel(), true);
document.addEventListener('keydown', () => exchangeHoverController?.cancel(), true);
document.addEventListener('scroll', e => {
  if (e.target?.closest?.('.exchange-popover')) return;
  exchangeHoverController?.cancel();
  if (exchangePopup?.isConnected && exchangePopup.exchangeTransient) closePopover(exchangePopup);
}, true);

function exchangePill(card, compact = false) {
  if (card.kind === 'task' || card.agent !== 'codex' || !card.exchanges) return null;
  const s = card.exchanges;
  const label = `セッション間のやり取り: 送信先 ${s.sent}、受信元 ${s.received}${s.partial ? '（取得済みの範囲）' : ''}（Shift+M）`;
  const pill = h('button', { type: 'button', class: `exchange-pill${compact ? ' is-compact' : ''}`, title: label,
    'aria-label': label, 'aria-haspopup': 'dialog', 'aria-keyshortcuts': 'Shift+M',
    onpointerdown: e => e.stopPropagation(), onclick: e => { e.stopPropagation(); openExchanges(e.currentTarget, card); } },
    h('span', { html: picon('message', 13) }), compact || !s.total ? null : h('span', { class: 'exchange-count', text: [s.sent ? `送${s.sent}` : '', s.received ? `受${s.received}` : ''].filter(Boolean).join(' ') }));
  pill.exchangeCard = card;
  return pill;
}

function selectedExchangeCard() {
  const pane = !paneLayer.hidden && (!paneDocked() || inDockedPane(document.activeElement)) ? focusedPane() : null;
  const id = pane?.kind === 'session' ? pane.id : document.activeElement?.closest?.('[data-card-id]')?.dataset.cardId || (inboxOn() ? state.inbox.sel : null);
  const hit = id ? findCard(id) : null;
  const card = hit?.link || hit?.card || pane?.d?.session;
  return card?.agent === 'codex' && card.kind !== 'task' ? card : null;
}
function openSelectedExchanges(card = selectedExchangeCard()) {
  if (!card) return;
  const pane = !paneLayer.hidden && (!paneDocked() || inDockedPane(document.activeElement)) ? focusedPane()?.el : null;
  const anchor = pane?.querySelector('.th-meta, h3') || pane || $(`[data-card-id="${CSS.escape(card.id)}"] .exchange-pill`);
  if (anchor) openExchanges(anchor, card);
}

function exchangePeerButton(peer, popup, event = null) {
  return h('button', { type: 'button', class: 'exchange-peer', text: peer.title,
    title: peer.available ? `${peer.title}を開く` : `相手の情報は未取得: ${peer.title}`,
    disabled: !peer.available, onclick: () => { if (event) openExchangePeer(popup.dataset.cardId, event); else { closePopover(popup); openCard(peer.id); } } });
}
function exchangeEvent(event, popup, showPeer = true) {
  const sent = event.direction === 'sent';
  return h('article', { class: 'exchange-event', 'data-exchange-id': event.id },
    h('div', { class: 'exchange-event-head' },
      h('time', { datetime: event.at || '', title: event.at ? fmtDate(Date.parse(event.at)) : '時刻未取得', text: event.at ? new Date(event.at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '時刻未取得' }),
      h('span', { class: `exchange-direction${sent ? ' is-sent' : ''}`, text: sent ? '→ 送信' : '← 受信' }),
      showPeer ? exchangePeerButton(event.peer, popup, event) : null),
    showPeer ? h('span', { class: 'exchange-kind', text: exchangeModel.relation(event.peer.relation) + (event.peer.available ? '' : ' · 相手未取得') }) : null,
    h('p', { class: 'exchange-text', text: event.text || '（本文なし）' }));
}

async function openExchanges(anchor, card, { transient = false } = {}) {
  exchangeHoverController?.cancel();
  if (exchangePopup?.isConnected && exchangePopup.exchangeAnchor === anchor) {
    if (transient) return;
    if (exchangePopup.exchangeTransient) {
      exchangePopup.exchangeTransient = false;
      exchangePopup.querySelector('[data-pin-exchange]')?.remove();
      exchangePopup.querySelector('[data-exchange-mode][aria-pressed="true"]')?.focus({ preventScroll: true });
    } else closePopover(exchangePopup);
    return;
  }
  const body = h('div', { class: 'exchange-body' });
  const popup = popover(anchor, 'セッション間のやり取り', body, { width: 440 });
  popup.classList.add('exchange-popover'); popup.exchangeAnchor = anchor; popup.dataset.cardId = card.id;
  exchangePopup = popup;
  popup.exchangeTransient = transient;
  popup.addEventListener('pointerenter', () => exchangeHoverController?.cancel());
  popup.addEventListener('pointerleave', () => { if (popup.exchangeTransient) exchangeHover().leave(); });
  popup.addEventListener('pointerdown', () => { popup.exchangeTransient = false; popup.querySelector('[data-pin-exchange]')?.remove(); });
  if (transient) body.append(h('button', { type: 'button', class: 'exchange-pin', 'data-pin-exchange': '', text: '履歴を固定して読む', onclick: () => { popup.exchangeTransient = false; popup.querySelector('[data-pin-exchange]')?.remove(); } }));
  popup.querySelector('.close')?.append(...keycap('Esc'));
  const modes = h('div', { class: 'exchange-modes', role: 'group', 'aria-label': 'やり取りの表示' });
  const summary = h('div', { class: 'exchange-summary', 'aria-live': 'polite', text: '読み込み中…' });
  const history = h('div', { class: 'exchange-history', tabindex: 0, 'aria-label': 'やり取りの履歴' });
  const positions = { timeline: 0, peer: 0 };
  let data = null;
  function draw() {
    for (const b of modes.children) b.setAttribute('aria-pressed', String(b.dataset.exchangeMode === exchangesView));
    if (!data) return;
    history.replaceChildren();
    if (data.unavailable) { history.append(h('p', { class: 'muted', text: 'このセッションの履歴は取得できません。リモート・クラウドのやり取りはCodexで確認してください。' })); return; }
    if (data.agents.length) history.append(h('details', { class: 'exchange-agents' },
      h('summary', {}, h('span', { html: picon('branch', 14) }), ` Multi Agent · ${data.agents.length}`),
      ...data.agents.map(peer => h('div', { class: 'exchange-agent' }, exchangePeerButton(peer, popup),
        h('span', { class: 'exchange-kind', text: exchangeModel.relation(peer.relation) }),
        h('span', { class: 'muted', text: peer.statusKnown ? STATUS_LABELS[peer.status] || '状態未取得' : '状態未取得' })))));
    if (exchangesView === 'timeline') history.append(...exchangeModel.chronological(data.events).map(e => exchangeEvent(e, popup)));
    else for (const group of exchangeModel.groups(data.events)) {
      const sent = group.events.filter(e => e.direction === 'sent').length;
      history.append(h('details', { class: 'exchange-group', open: true },
        h('summary', {}, h('span', { html: picon(group.peer.relation === 'session' ? 'message' : 'branch', 14) }),
          h('strong', { text: group.peer.title }), h('span', { class: 'exchange-kind', text: exchangeModel.relation(group.peer.relation) + (group.peer.available ? '' : ' · 相手未取得') }),
          h('span', { class: 'muted', text: `送${sent} 受${group.events.length - sent}` })),
        h('div', { class: 'exchange-group-events' }, group.peer.available ? h('button', { type: 'button', class: 'exchange-peer', text: '相手を開く', onclick: () => openExchangePeer(card.id, group.events[0]) }) : null,
          ...group.events.map(e => exchangeEvent(e, popup, false)))));
    }
    if (!data.events.length) history.append(h('p', { class: 'muted', text: '取得済みの範囲にやり取りはありません。' }));
    history.scrollTop = positions[exchangesView];
  }
  for (const [key, label] of [['timeline', '時系列'], ['peer', '相手別']]) modes.append(h('button', { type: 'button', 'data-exchange-mode': key,
    'aria-pressed': String(exchangesView === key), text: label, onclick: () => { positions[exchangesView] = history.scrollTop; exchangesView = key; draw(); } }));
  body.append(modes, summary, history);
  if (!transient) modes.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
  try {
    const result = await bridge.callTool('canban_exchanges', { cardId: card.id });
    if (!popup.isConnected) return;
    data = result;
    const s = data.summary;
    summary.textContent = `別セッション ${s.peers}相手・${s.total}件${s.agentMessages ? ` / Multi Agent ${s.agentMessages}件` : ''}${data.partial ? ' · 取得済みの範囲のみ（大きなログは末尾から取得）' : ''}`;
    draw();
  } catch (error) {
    if (popup.isConnected) { summary.textContent = '履歴を取得できませんでした'; history.append(h('p', { class: 'muted', text: error.message })); }
  }
}

document.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || typingIn(e.target) || document.querySelector('dialog[open], .popover')) return;
  if (e.shiftKey && e.key.toLowerCase() === 'm' && selectedExchangeCard()) { e.preventDefault(); openSelectedExchanges(); }
});

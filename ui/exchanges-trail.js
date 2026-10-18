// Relationship browsing uses the existing session panes and feed, one DOM per session.
// Visits are lightweight history entries so A → B → A cannot duplicate live feeds or drafts.
let exchangeTrail = null;
let exchangeTrailView = ['spread', 'center', 'stack'].includes(store.get('exchangeTrailView')) ? store.get('exchangeTrailView') : 'center';
let paintingExchangeTrail = false;
const exchangeVisitReading = new Map();
function rememberExchangeReading() {
  if (!exchangeTrail) return;
  const visit = exchangeTrail.visits[exchangeTrail.active];
  const feed = panes.find(p => p.id === visit.sessionId)?.el.querySelector('.feed');
  if (feed) exchangeVisitReading.set(visit.id, feed.scrollTop);
}
const EXCHANGE_TRAIL_VIEWS = [['spread', '横にひろげる'], ['center', '中央に3枚'], ['stack', '重ねて辿る']];
const exchangeTrailBar = h('div', { class: 'exchange-trail-bar', hidden: true, role: 'toolbar', 'aria-label': 'やり取りを辿る' });
paneBar.after(exchangeTrailBar);
function trailTitle(id) {
  const p = panes.find(p => p.id === id) || paneCache.get(id);
  const found = findCard(id);
  return p?.d?.card?.title || p?.d?.session?.title || found?.link?.title || found?.card?.title || 'セッション';
}
function endExchangeTrail() {
  exchangeTrail = null;
  exchangeVisitReading.clear();
  paneLayer.classList.remove('exchange-trail');
  delete paneLayer.dataset.exchangeView;
  exchangeTrailBar.hidden = true;
  exchangeTrailBar.replaceChildren();
  paneRow.querySelectorAll('.exchange-stack-peek').forEach(el => el.remove());
  for (const p of panes) { p.el.hidden = false; p.el.removeAttribute('inert'); delete p.el.dataset.trailActive; delete p.el.dataset.trailVisit; p.el.style.removeProperty('--trail-index'); }
}
function setExchangeTrailView(view) {
  if (!EXCHANGE_TRAIL_VIEWS.some(([key]) => key === view)) return;
  rememberExchangeReading();
  exchangeTrailView = view; store.set('exchangeTrailView', view);
  paintExchangeTrail();
  exchangeTrailBar.querySelector(`[data-exchange-view="${view}"]`)?.focus({ preventScroll: true });
}
function focusExchangeVisit(id) {
  if (!exchangeTrail) return;
  rememberExchangeReading();
  exchangeTrail = exchangeTrailModel.focus(exchangeTrail, id);
  showExchangeTrail();
}
function moveExchangeVisit(step) {
  if (!exchangeTrail) return false;
  rememberExchangeReading();
  const next = exchangeTrailModel.move(exchangeTrail, step);
  if (next === exchangeTrail) return false;
  exchangeTrail = next; showExchangeTrail(); return true;
}
function paintExchangeTrail() {
  if (!exchangeTrail || paneLayer.hidden) return;
  const t = exchangeTrail, cards = exchangeTrailModel.cards(t);
  const active = t.visits[t.active], activeIndex = cards.findIndex(v => v.id === t.active);
  paneLayer.classList.add('exchange-trail'); paneLayer.dataset.exchangeView = exchangeTrailView;
  exchangeTrailBar.hidden = false;
  const seenSessions = new Set();
  exchangeTrailBar.replaceChildren(
    h('div', { class: 'exchange-trail-controls' },
      h('button', { class: 'hbtn', type: 'button', 'aria-label': '前に見ていたカードへ戻る', disabled: !t.cursor, onclick: () => moveExchangeVisit(-1) }, '← 戻る ', ...keycap('Esc')),
      h('button', { class: 'hbtn', type: 'button', 'aria-label': '次に見ていたカードへ進む', disabled: t.cursor === t.history.length - 1, onclick: () => moveExchangeVisit(1) }, '進む → ', ...keycap('⇧Esc')),
      h('button', { class: 'hbtn', type: 'button', disabled: t.active === t.root, onclick: () => focusExchangeVisit(t.root) }, '起点へ ', ...keycap('⇧Home')),
      h('div', { class: 'seg', role: 'group', 'aria-label': '関連カードのビュー' }, ...EXCHANGE_TRAIL_VIEWS.map(([view, label], i) => h('button', { type: 'button', 'data-exchange-view': view, 'aria-pressed': String(view === exchangeTrailView), onclick: () => setExchangeTrailView(view), title: `${label}（Shift+${i + 1}）` }, label, ' ', ...keycap(`⇧${i + 1}`)))),
      h('span', { class: 'exchange-trail-hint', text: '受信元は左 · 送信先は右' })),
    h('nav', { class: 'exchange-trail-path', 'aria-label': 'カードの訪問履歴' }, ...t.order.map(id => {
      const visit = t.visits[id], current = cards.some(card => card.id === id);
      const revisit = seenSessions.has(visit.sessionId);
      seenSessions.add(visit.sessionId);
      return h('button', { type: 'button', 'data-exchange-visit': id, 'aria-current': id === t.active ? 'step' : 'false', class: current ? '' : 'is-previous-visit', title: current ? 'この訪問へ戻る' : 'この位置へカードを戻す（下書きを保持）', onclick: () => focusExchangeVisit(id) },
        h('span', { text: id === t.root ? '起点 · ' : visit.direction === 'received' ? '← ' : '→ ' }),
        h('span', { text: trailTitle(visit.sessionId) }), revisit ? h('small', { text: ' 再訪' }) : null);
    })));
  paneRow.querySelectorAll('.exchange-stack-peek').forEach(el => el.remove());
  cards.forEach((visit, i) => {
    const p = panes.find(p => p.id === visit.sessionId);
    if (!p) return;
    p.el.dataset.trailActive = String(visit.id === t.active);
    p.el.dataset.trailVisit = visit.id;
    p.el.style.setProperty('--trail-index', String(i - activeIndex));
    const hidden = exchangeTrailView === 'center' && Math.abs(i - activeIndex) > 1;
    p.el.hidden = hidden;
    p.el.toggleAttribute('inert', exchangeTrailView === 'stack' && visit.id !== t.active);
    if (exchangeTrailView === 'stack' && visit.id !== t.active) paneRow.append(h('button', { class: 'exchange-stack-peek', type: 'button', 'aria-label': `${trailTitle(visit.sessionId)}へ移る`, style: { '--trail-index': String(i - activeIndex) }, onclick: () => focusExchangeVisit(visit.id) }));
  });
  // Inert stacked cards remain visible; path chips are their keyboard and pointer entry.
  if (exchangeTrailView === 'center') {
    const left = Math.max(0, activeIndex - 1), right = Math.max(0, cards.length - activeIndex - 2);
    const controls = $('.exchange-trail-controls', exchangeTrailBar);
    if (left) controls.append(h('button', { class: 'hbtn', type: 'button', text: `← 左に${left}枚`, onclick: () => focusExchangeVisit(cards[activeIndex - 2].id) }));
    if (right) controls.append(h('button', { class: 'hbtn', type: 'button', text: `右に${right}枚 →`, onclick: () => focusExchangeVisit(cards[activeIndex + 2].id) }));
  }
  layoutCardBoard(); refreshShortcutHints();
  $('.pb-title', paneBar).textContent = `やり取り · ${trailTitle(active.sessionId)}`;
}
async function showExchangeTrail() {
  if (!exchangeTrail) return;
  const snapshot = exchangeTrail;
  const ids = exchangeTrailModel.cards(snapshot).map(v => v.sessionId);
  paintingExchangeTrail = true;
  try { showCards(ids, { dock: false }); } finally { paintingExchangeTrail = false; }
  paintExchangeTrail();
  await Promise.all(panes.filter(p => !p.d || (p.d.feed && !live.feeds.has(p.id))).map(p => loadSession(p)));
  if (exchangeTrail !== snapshot) return;
  paintExchangeTrail();
  for (const p of panes) p.el.querySelectorAll('.exchange-touchpoint').forEach(el => el.classList.toggle('is-linked', el.dataset.exchangeId === snapshot.visits[snapshot.active].eventId));
  const active = panes.find(p => p.id === snapshot.visits[snapshot.active].sessionId);
  if (!active) return;
  active.el.focus({ preventScroll: true });
  if (exchangeTrailView !== 'stack') active.el.scrollIntoView({ inline: 'center', block: 'nearest' });
  const visit = snapshot.visits[snapshot.active];
  if (exchangeVisitReading.has(visit.id)) {
    const feed = $('.feed', active.el);
    if (feed) feed.scrollTop = exchangeVisitReading.get(visit.id);
  }
  const revealContact = (pane, eventId) => {
    const marker = [...(pane?.el.querySelectorAll('.exchange-touchpoint') || [])].find(el => el.dataset.exchangeId === eventId);
    const feed = marker?.closest('.feed');
    if (feed) feed.scrollTop += marker.getBoundingClientRect().top - feed.getBoundingClientRect().top - (feed.clientHeight - marker.offsetHeight) / 2;
  };
  // Align both sides of the selected communication without moving the horizontal viewport.
  // Returning to a previously read visit restores its own position instead of jumping again.
  if (visit.source && !exchangeVisitReading.has(visit.id)) {
    const sourceVisit = snapshot.visits[visit.source];
    const sourcePane = panes.find(p => p.id === sourceVisit.sessionId);
    revealContact(sourcePane, visit.eventId);
    revealContact(active, visit.eventId);
  }
}
async function openExchangePeer(sourceId, event) {
  if (!event.peer.available) return;
  rememberExchangeReading();
  closePopover();
  if (!exchangeTrail || !exchangeTrailModel.cards(exchangeTrail).some(v => v.sessionId === sourceId)) exchangeTrail = exchangeTrailModel.start(sourceId);
  const source = exchangeTrailModel.cards(exchangeTrail).find(v => v.sessionId === sourceId);
  exchangeTrail = exchangeTrailModel.open(exchangeTrail, source.id, event);
  await showExchangeTrail();
}
function paintExchangeTimeline(p) {
  const feed = $('.feed', p.el);
  if (!feed || !p.exchangeData) return;
  const reading = feed.scrollTop, following = atFeedEnd(feed);
  feed.querySelectorAll('.exchange-touchpoint, .exchange-timeline-note').forEach(el => el.remove());
  const data = p.exchangeData;
  // Replace only proven receipt copies with their exchange contact. Ordinary user
  // messages, examples and malformed envelopes remain part of the conversation.
  for (const el of [...feed.children]) if (el.exchangeDelivery && data.events.some(event => exchangeModel.matchesDelivery(el.exchangeDelivery, el.dataset.feedAt, event))) el.remove();
  if (data.partial || data.unavailable) feed.prepend(h('p', { class: 'exchange-timeline-note muted', text: data.unavailable ? 'やり取りの履歴はこの環境では取得できません。' : 'やり取りは取得済みの範囲です。' }));
  const items = [...feed.children].filter(el => !el.classList.contains('exchange-timeline-note'));
  for (const event of [...data.events].sort((a, b) => (a.at || '').localeCompare(b.at || ''))) {
    const sent = event.direction === 'sent';
    const marker = h('article', { class: `exchange-touchpoint${sent ? ' is-sent' : ''}`, 'data-exchange-at': event.at || '', 'data-exchange-id': event.id },
      h('time', { datetime: event.at || '', text: event.at ? fmtClock(event.at) : '時刻未取得', title: event.at ? fmtDate(Date.parse(event.at)) : '' }),
      h('div', {}, h('button', { type: 'button', class: 'exchange-touchpoint-peer', disabled: !event.peer.available,
        title: event.peer.available ? `${event.peer.title}を${sent ? '右' : '左'}に開く` : '相手の情報は未取得',
        onclick: () => openExchangePeer(p.id, event) },
        h('span', { html: picon(event.peer.relation === 'session' ? 'message' : 'branch', 13) }),
        `${sent ? '送信 → ' : '← 受信 '}${event.peer.title}`),
        h('span', { class: 'exchange-kind', text: exchangeModel.relation(event.peer.relation) }),
        h('p', { text: event.text || '（本文なし）' })));
    const stamp = Date.parse(event.at);
    const after = Number.isFinite(stamp) && items.find(el => {
      const at = el.dataset.feedAt || el.querySelector('time[datetime]')?.getAttribute('datetime');
      return at && Date.parse(at) >= stamp;
    });
    if (after) feed.insertBefore(marker, after); else feed.append(marker);
  }
  feed.scrollTop = following ? feed.scrollHeight : reading;
}
function scheduleExchangeRefresh(p) {
  if (!panes.includes(p) || paneLayer.hidden || p.kind !== 'session' || p.d?.session?.agent !== 'codex' || p.exchangeRefreshTimer) return;
  p.exchangeRefreshTimer = setTimeout(() => {
    p.exchangeRefreshTimer = null;
    if (!panes.includes(p) || paneLayer.hidden) return;
    if (p.exchangeLoading) { scheduleExchangeRefresh(p); return; }
    loadExchangeTimeline(p);
  }, Math.max(350, 1500 - (Date.now() - (p.exchangeLastFetchedAt || 0))));
}
async function loadExchangeTimeline(p) {
  if (p.kind !== 'session' || p.d?.session?.agent !== 'codex') return;
  if (p.exchangeLoading) return p.exchangeLoading;
  p.exchangeLoading = (async () => {
    try {
      p.exchangeData = await bridge.callTool('canban_exchanges', { cardId: p.id });
      if (panes.includes(p)) {
        paintExchangeTimeline(p);
        const pill = $('.th-meta .exchange-pill', p.el);
        if (pill) {
          const next = exchangePill({ ...p.d.session, kind: 'session', exchanges: p.exchangeData.summary });
          if (next) {
            // Keep the anchor and its hover listeners while a history popup is open.
            pill.title = next.title; pill.setAttribute('aria-label', next.getAttribute('aria-label'));
            const count = pill.querySelector('.exchange-count'), updated = next.querySelector('.exchange-count');
            if (count && updated) count.textContent = updated.textContent;
            else if (updated) pill.append(updated);
            else count?.remove();
          }
        }
      }
    } catch (error) {
      if (panes.includes(p)) {
        const feed = $('.feed', p.el);
        if (feed && !feed.querySelector('.exchange-timeline-note')) feed.prepend(h('p', { class: 'exchange-timeline-note muted', text: `やり取りを取得できませんでした: ${error.message}` }));
      }
    } finally { p.exchangeLoading = null; p.exchangeLastFetchedAt = Date.now(); }
  })();
  return p.exchangeLoading;
}
paneRow.addEventListener('focusin', e => {
  if (!exchangeTrail || paintingExchangeTrail) return;
  const el = e.target.closest('.pane'), id = el?.dataset.trailVisit;
  if (id && id !== exchangeTrail.active) { rememberExchangeReading(); exchangeTrail = exchangeTrailModel.focus(exchangeTrail, id); paintExchangeTrail(); }
});
document.addEventListener('keydown', e => {
  if (!exchangeTrail || paneLayer.hidden || e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || typingIn(e.target) || document.querySelector('.popover, dialog[open]')) return;
  if (e.shiftKey && /^[123]$/.test(e.key)) { e.preventDefault(); setExchangeTrailView(EXCHANGE_TRAIL_VIEWS[Number(e.key) - 1][0]); }
  // Shift+digit produces !/@/# on common layouts, but code is stable across keyboard layouts.
  else if (e.shiftKey && /^Digit[123]$/.test(e.code)) { e.preventDefault(); setExchangeTrailView(EXCHANGE_TRAIL_VIEWS[Number(e.code.slice(-1)) - 1][0]); }
});

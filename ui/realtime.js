// Part of board.html: included into its script by server/ui.mjs and shares its scope.
// Realtime: the live session feed and the board's long poll (canban_watch)
const TOOL_ICONS = { ok: '✓', error: '✗' };
const fmtClock = (at) => (at ? new Date(at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '');

function feedItem(it, f) {
  if (it.k === 'user') return h('div', { class: 'fi fi-user', title: fmtDate(Date.parse(it.at)) }, h('div', { class: 'fi-who', text: 'あなた' }), h('div', { text: it.text }));
  if (it.k === 'assistant') return h('div', { class: 'fi fi-asst' }, h('div', { class: 'fi-who', text: f.pane.d?.session?.agent === 'claude' ? 'Claude' : 'Codex' }), h('span', { class: 'raw', text: it.text }), h('div', { class: 'md', html: mdHtml(it.text) }));
  if (it.k === 'commentary') return h('div', { class: 'fi fi-note', text: it.text });
  if (it.k === 'thinking') {
    if (!it.text) return null;
    return h('details', { class: 'fi fi-think' }, h('summary', {}, h('span', { class: 'ti', text: '💭' }), h('span', { text: '考えた内容' })), h('div', { class: 'tt', text: it.text }));
  }
  if (it.k === 'tool') {
    const icon = h('span', { class: `ti ${it.state}`, text: TOOL_ICONS[it.state] || '' });
    const out = h('pre', { text: it.out || '' });
    if (!it.out) out.hidden = true;
    const el = h('details', { class: 'fi fi-tool' }, h('summary', { title: it.summary }, icon, h('span', { class: 'tn', text: it.name }), h('span', { class: 'ts', text: it.summary })), out);
    if (it.id) f.tools.set(it.id, { el, icon, out });
    return el;
  }
  if (it.k === 'turn') return h('div', { class: 'fi-turn', text: `${it.state === 'aborted' ? '⏹ 中断しました' : '— ターン完了'}${it.at ? ` · ${fmtClock(it.at)}` : ''}` });
  return null;
}

function renderFeed(d, p) {
  const list = h('div', { class: 'feed', role: 'log', 'aria-live': 'polite', 'aria-label': 'セッションの会話' });
  const foot = h('div', { class: 'feed-foot' });
  const newBtn = h('button', { class: 'feed-new', text: '↓ 新着', hidden: true, onclick: () => scrollFeedToEnd(f) });
  const f = { pane: p, cardId: d.session.id, offset: d.feed.offset, size: d.feed.size, codexItems: d.feed.codexItems, list, foot, newBtn, tools: new Map(), status: d.session.status || 'idle', activity: d.session.activity || null, signals: d.session.signals || null, git: d.git || null };
  list.addEventListener('scroll', () => { if (atFeedEnd(list)) newBtn.hidden = true; });
  list.append(editSummary(f).el);
  for (const it of d.feed.items) feedPush(f, it);
  f.edits?.paint();
  const lastSaid = [...d.feed.items].reverse().find((it) => it.k === 'assistant');
  p.lastText = lastSaid ? lastSaid.text : d.session.preview || '';
  if (!d.feed.items.length) list.append(h('div', { class: 'muted', text: 'まだやりとりはありません' }));
  live.feeds.set(f.cardId, f);
  paintFeedFoot(f);
  kickLive();
  return h('div', { class: 'feed-wrap' }, list, newBtn, foot);
}

const atFeedEnd = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 48;
function scrollFeedToEnd(f) {
  if (!f) return;
  f.list.scrollTop = f.list.scrollHeight;
  f.newBtn.hidden = true;
}

function paintFeedFoot(f) {
  const st = f.status;
  if (st === 'running') f.foot.replaceChildren(h('span', { class: 'sdot s-running' }), h('span', { class: 'grow', title: f.activity || '' }, h('span', { class: 'dots', text: '作業中' }), h('span', { class: 'elapsed num', text: f.turnStart ? ` ${fmtElapsed(Date.now() - f.turnStart)}` : '' }), f.activity ? `  ${f.activity}` : ''));
  else if (st === 'waiting') f.foot.replaceChildren(h('span', { class: 'sdot s-waiting' }), h('span', { class: 'grow', text: `${WAIT_TEXT[f.signals?.wait] || '入力待ち'}${f.activity ? `  ${f.activity}` : ''}（アプリで答えてください）` }));
  else f.foot.replaceChildren(h('span', { class: `sdot s-${st}` }), h('span', { class: 'grow', text: STATUS_LABELS[st] || '' }));
  const p = f.pane;
  const hdr = p.el.querySelector('.pane-status');
  if (hdr) hdr.replaceChildren(h('span', { class: `sdot s-${st}` }), STATUS_LABELS[st] || '');
  p.status = st;
  p.activity = activityText(f.activity, st, f.signals);
}

function applyFeed(f, feed) {
  if (feed.reset) { openCard(f.cardId); return; }
  const stick = atFeedEnd(f.list);
  let added = 0;
  if (feed.items.length) f.list.querySelector(':scope > .muted')?.remove();
  for (const it of feed.items) {
    if (it.k === 'result') {
      const t = f.tools.get(it.ref);
      if (!t) continue;
      t.icon.className = `ti ${it.ok ? 'ok' : 'error'}`;
      t.icon.textContent = TOOL_ICONS[it.ok ? 'ok' : 'error'];
      if (it.out) { t.out.textContent = it.out; t.out.hidden = false; }
      continue;
    }
    if (it.k === 'assistant') f.pane.lastText = it.text;
    if (feedPush(f, it)) added++;
  }
  // Keep the DOM bounded on long runs.
  while (f.list.childElementCount > 400) f.list.firstElementChild.remove();
  f.offset = feed.offset;
  f.size = feed.size;
  f.codexItems = feed.codexItems;
  if (feed.status) {
    if (feed.status !== f.status) refreshDispatch(f); // "busy" rules for sending follow the status
    f.status = feed.status;
    f.activity = feed.activity || null;
    f.signals = feed.signals || null;
    if (feed.git) { f.git = feed.git; paintThreadStat(f.pane, f.git); }
    paintFeedFoot(f);
    f.edits?.paint();
    const box = f.pane.el.querySelector('.sig-box');
    if (box) {
      const next = renderSignals(f.signals, f.git);
      box.replaceWith(next);
      const sec = next.closest('.dsec');
      if (sec) {
        let empty = $('.empty-progress', sec);
        if (!empty) { empty = h('span', { class: 'muted empty-progress', text: 'なし' }); $('.dsec-b', sec).append(empty); }
        empty.hidden = !next.hidden;
      }
    }
  }
  if (added) { if (stick) scrollFeedToEnd(f); else f.newBtn.hidden = false; }
}

// ---- the long poll ----
const live = { on: false, seq: null, feeds: new Map(), mode: 'long', inflight: 0, lastLoad: 0, loadTimer: null, dirty: false, ownActAt: 0, lastWatchEnd: 0, presence: [], viewers: new Map() };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const liveIdle = () => !state.drag && !document.querySelector('.popover, .list-title-input, .composer, .peek-input:focus');

// Rebuild the board soon (coalesced, at most once every 1.5 s), when nothing is being edited.
function scheduleLoad(delay = 0) {
  // Our own change reloads in act(); the echo of it is picked up after that, not twice at once.
  const wait = Math.max(delay, 1500 - (Date.now() - live.lastLoad), 1500 - (Date.now() - live.ownActAt));
  clearTimeout(live.loadTimer);
  live.loadTimer = setTimeout(() => {
    if (!liveIdle() || document.visibilityState !== 'visible') { live.dirty = true; return; }
    live.dirty = false;
    live.lastLoad = Date.now();
    load();
  }, Math.max(0, wait));
}

function findCard(id) {
  for (const l of state.board?.lists || []) for (const c of l.cards) {
    if (c.id === id) return { card: c, list: l };
    if (c.kind === 'task' && c.links?.some((x) => x.id === id)) return { card: c, list: l, link: c.links.find((x) => x.id === id) };
  }
  return null;
}

// Patch cards in place: a status change rebuilds the board (rules and counts follow it).
function applyPatches(patches) {
  let rebuild = false;
  for (const p of patches) {
    const hit = findCard(p.id);
    if (!hit) continue;
    const { card, list, link } = hit;
    if (link) { if (link.status !== p.status) rebuild = true; continue; }
    if (card.status !== p.status) { rebuild = true; continue; }
    const openHere = live.feeds.has(p.id);
    if ((p.updatedAt || 0) > (card.updatedAt || 0) && !openHere) card.unread = true;
    card.updatedAt = Math.max(card.updatedAt || 0, p.updatedAt || 0);
    card.activity = p.activity;
    card.signals = p.signals || null;
    card.git = p.git || null;
    const el = document.querySelector(`.card[data-card-id="${CSS.escape(p.id)}"]`);
    if (el && !state.drag && !el.querySelector('.peek-input:focus')) {
      const focused = el.contains(document.activeElement);
      const next = renderCard(card, list);
      el.replaceWith(next);
      if (focused) next.focus();
    }
  }
  if (rebuild) scheduleLoad();
}

async function refreshDispatch(f) {
  const el = f?.pane.el;
  if (!el || el.querySelector('.send-box textarea:focus, .req-row textarea')) return;
  try {
    const d = await bridge.callTool('canban_get_session', { cardId: f.cardId, messages: 1 });
    const old = el.querySelector('.send-section');
    if (old && live.feeds.get(f.cardId) === f) replaceDispatch(old, d);
  } catch {}
}

// Other live boards (Codex / Claude Desktop) and the cards they have open.
function applyPresence(list) {
  const key = JSON.stringify(list || []);
  if (key === JSON.stringify(live.presence)) return;
  const before = live.viewers;
  live.presence = list || [];
  live.viewers = new Map();
  for (const p of live.presence) if (p.cardId) live.viewers.set(p.cardId, [...new Set([...(live.viewers.get(p.cardId) || []), p.app])]);
  const bar = $('#presenceBar');
  const apps = [...new Set(live.presence.map((p) => p.app))];
  bar.hidden = !apps.length;
  bar.title = live.presence.map((p) => `${p.app}: ${p.cardId ? `「${findCard(p.cardId)?.card.title ?? p.cardId}」を表示中` : 'ボードを表示中'}`).join('\n');
  bar.replaceChildren(h('span', { text: `👁 ${apps.join('・')}` }));
  for (const id of new Set([...before.keys(), ...live.viewers.keys()])) {
    if (JSON.stringify(before.get(id)) === JSON.stringify(live.viewers.get(id))) continue;
    const hit = findCard(id);
    const el = document.querySelector(`.card[data-card-id="${CSS.escape(id)}"]`);
    if (hit && !hit.link && el && !state.drag && !el.querySelector('.peek-input:focus')) {
      const focused = el.contains(document.activeElement);
      const next = renderCard(hit.card, hit.list);
      el.replaceWith(next);
      if (focused) next.focus();
    }
  }
  panes.forEach(paintViewers);
}

function applyLive(r, args) {
  if (r.presence) applyPresence(r.presence);
  if (r.seq != null) live.seq = live.seq == null ? r.seq : Math.max(live.seq, r.seq);
  if (r.patches?.length) applyPatches(r.patches);
  applyAccountLimits(r.accountLimits);
  if (r.reload) scheduleLoad();
  if (r.requests) { for (const f of live.feeds.values()) refreshDispatch(f); scheduleLoad(); }
  for (const [id, feed] of Object.entries(r.feeds || {})) {
    const f = live.feeds.get(id);
    const sent = args.feeds?.find((x) => x.cardId === id);
    if (f && sent && f.offset === sent.offset) applyFeed(f, feed);
  }
}

function watchArgs(timeoutMs) {
  const args = { since: live.seq, timeoutMs };
  if (live.feeds.size) args.feeds = [...live.feeds.values()].map((f) => ({ cardId: f.cardId, offset: f.offset, size: f.size ?? null, codexItems: !!f.codexItems }));
  return args;
}

async function watchOnce(timeoutMs) {
  const args = watchArgs(timeoutMs);
  live.inflight++;
  try {
    const r = await bridge.callTool('canban_watch', args);
    if (r?.off) { live.on = false; return false; }
    applyLive(r, args);
    return true;
  } finally {
    live.inflight--;
    live.lastWatchEnd = performance.now();
  }
}

// The detail view opened or changed: tell the server now instead of after the pending wait.
function kickLive() {
  if (live.on && live.seq != null) watchOnce(0).catch(() => {});
}

// Unknown hosts may serialize calls. Native Messaging multiplexes them, so a slow
// normal response near a watch completion is not evidence of serialization there.
function noteCall(name, startedAt, pendingAtStart, concurrent) {
  if (concurrent || name === 'canban_watch' || !pendingAtStart || live.mode !== 'long') return;
  const now = performance.now();
  if (now - startedAt > 1500 && now - live.lastWatchEnd < 80) {
    live.mode = 'short';
    console.info('canban: using short polling to keep tool calls responsive');
  }
}

bridge.hooks.pending = () => live.inflight > 0;
bridge.hooks.after = noteCall;

async function liveLoop() {
  let failures = 0;
  for (;;) {
    if (document.visibilityState !== 'visible') {
      await new Promise((r) => document.addEventListener('visibilitychange', r, { once: true }));
      continue;
    }
    if (live.dirty && liveIdle()) scheduleLoad();
    try {
      const first = live.seq == null;
      if (!(await watchOnce(first ? 0 : live.mode === 'long' ? 20000 : 0))) return;
      failures = 0;
      if (live.mode === 'short') await sleep(2500);
    } catch (e) {
      failures++;
      if (failures >= 3 && live.mode === 'long') live.mode = 'short'; // e.g. a host timeout shorter than the wait
      await sleep(Math.min(30000, 1000 * 2 ** failures));
    }
  }
}

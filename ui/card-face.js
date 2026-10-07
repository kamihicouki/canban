// Board card faces: compact / standard / rich, and the inline reply ("peek") under a card.
// Included into board.html's script (shares its scope). The classic face stays in renderCard();
// the user picks one per component (component-styles.js). Drag, keys, ▶ resume and the
// overlay all come from attachCardBehavior(), so every face behaves the same.
const FACE_TONE = { running: 'run', waiting: 'wait', aborted: 'err', completed: 'done', idle: 'idle' };
const faceKind = () => state.styles.boardCard;
const isFace = () => faceKind() !== 'classic';

// The status as one small mark: a spinner while it works, an amber dot while it waits for you.
function faceGlyph(status) {
  const tone = FACE_TONE[status] || 'idle';
  const g = h('span', { class: `glyph g-${tone}`, role: 'img', title: STATUS_LABELS[status] || STATUS_LABELS.idle, 'aria-label': STATUS_LABELS[status] || STATUS_LABELS.idle });
  if (tone === 'done') g.innerHTML = picon('check', 12);
  else if (tone === 'err') g.innerHTML = picon('alert', 11);
  return g;
}
const faceWho = (agent) => h('span', { class: `who who-${agent}`, text: agent === 'codex' ? 'Codex' : agent === 'claude' ? 'Claude' : T.taskCard });

// "+74 −5" (what the folder changed) or, without git numbers, the files this turn edited.
function faceStat(card) {
  const g = card.git;
  if (g && (g.added || g.removed)) return h('span', { class: 'fstat num', title: `コミットしていない変更 +${g.added} −${g.removed}（${g.changed + g.untracked} ファイル）` },
    h('span', { class: 'add', text: `+${g.added}` }), h('span', { class: 'del', text: `−${g.removed}` }));
  const f = card.signals?.files;
  return f ? h('span', { class: 'fstat', title: `このターンで編集したファイル\n${f.names.join('\n')}` }, h('span', { html: picon('file', 12) }), ` ${f.count}`) : null;
}
function faceLabels(card) {
  const byId = new Map(state.board.labels.map((l) => [l.id, l]));
  const ls = card.labels.map((id) => byId.get(id)).filter(Boolean);
  return ls.length ? h('span', { class: 'flabels', title: ls.map((l) => l.name).join('・') }, ls.slice(0, 4).map((l) => h('i', { style: { background: colorVar(l.color) } }))) : null;
}
// The line under the title: what it does now (a shimmer while it runs), what it waits for, or its last word.
function faceNow(card) {
  const busy = card.status === 'running' || card.status === 'waiting';
  if (busy) {
    const text = activityText(card.activity, card.status, card.signals) || (card.status === 'running' ? '作業中…' : STATUS_LABELS.waiting);
    return h('div', { class: `fnow fnow-${FACE_TONE[card.status]}`, title: text }, h('span', { class: card.status === 'running' ? 'shimmer' : '', text }));
  }
  if (card.status === 'aborted') return h('div', { class: 'fnow fnow-err', title: card.last || '', text: card.last ? `中断 · ${card.last}` : '中断しました' });
  if (card.last) return h('div', { class: 'fnow', title: card.last, text: card.last });
  return null;
}
function faceFlags(card) {
  const viewers = live.viewers.get(card.id);
  const flags = [
    card.unread ? h('span', { class: 'fflag fflag-new', title: '新しい動きがあります', text: '新着' }) : null,
    card.autoMoved ? h('span', { class: 'fflag', title: `${T.automation}で移動`, html: picon('zap', 12) }) : null,
    viewers ? h('span', { class: 'fflag', title: `${viewers.join('・')}で開いています`, html: picon('eye', 12) }) : null,
    card.pinnedInAgent ? h('span', { class: 'fflag', title: 'Codex アプリでピン留め', html: picon('bookmark', 12) }) : null,
  ].filter(Boolean);
  return flags.length ? h('span', { class: 'fflags' }, ...flags) : null;
}
function faceExtras(card) {
  const out = [];
  if (card.priority) out.push(h('span', { class: `pill prio-${card.priority}`, text: { high: '優先度 高', medium: '優先度 中', low: '優先度 低' }[card.priority] }));
  if (card.due) out.push(h('span', { class: `pill${Date.parse(card.due) < Date.now() - 86400000 ? ' due-over' : ''}`, text: `期限 ${new Date(card.due).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })}` }));
  if (card.note) out.push(h('span', { title: 'メモあり', html: picon('note', 12) }));
  if (card.requests) out.push(requestPill(card.requests));
  if (card.grouped?.length) out.push(h('span', { class: 'pill', title: card.grouped.map((g) => g.title).join('\n'), text: `＋${card.grouped.length}` }));
  if (card.subagents) out.push(h('span', { class: 'pill', title: 'このセッションが起動したサブエージェント', text: `サブ ${card.subagents.total}${card.subagents.running ? `（${card.subagents.running}）` : ''}` }));
  if (card.archived) out.push(h('span', { text: 'アーカイブ済' }));
  if (card.hidden) out.push(h('span', { text: '非表示' }));
  return out;
}

function renderFaceCard(card, list) {
  const kind = faceKind();
  const task = card.kind === 'task';
  const el = cardShell(card, ` face face-${kind}${task ? ' task' : ''}`);
  const rich = kind === 'rich', compact = kind === 'compact';
  el.append(h('div', { class: 'frow' }, faceGlyph(card.status), h('div', { class: 'ftitle', text: card.title }), compact ? null : faceFlags(card),
    compact ? h('span', { class: 'fwho' }, faceWho(task ? 'task' : card.agent)) : null,
    compact ? h('span', { class: 'ftime', title: fmtDate(card.updatedAt), text: relTime(card.updatedAt) }) : null));
  if (compact) return finishFace(el, card, list);
  const now = task ? faceTaskNow(card) : faceNow(card);
  if (now && !(rich && !task && !(card.status === 'running' || card.status === 'waiting') && card.last)) el.append(now);
  if (rich) {
    if (!task && card.last && card.status !== 'running' && card.status !== 'waiting') el.append(h('div', { class: 'fquote', title: card.last, text: card.last }));
    const plan = card.signals?.plan;
    if (plan?.total) el.append(h('div', { class: 'fprog', title: `計画 ${plan.done}/${plan.total}${plan.current ? `\nいま: ${plan.current}` : ''}` },
      h('span', { class: 'num', text: `${plan.done}/${plan.total}` }), h('span', { class: 'bar' }, h('i', { style: { width: `${Math.round(plan.done / plan.total * 100)}%` } }))));
    if (!task && card.status === 'waiting') el.append(h('div', { class: 'fask' },
      card.canDesktop ? h('button', { class: 'btn-primary', type: 'button', text: 'アプリで答える', onpointerdown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); resume(card.id, { route: 'desktop' }); } }) : null,
      h('button', { class: 'btn', type: 'button', text: '内容を見る', onpointerdown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); if (state.styles.peek === 'on') togglePeek(card); else openCard(card.id); } })));
    if (task && card.links.length) el.append(h('div', { class: 'flinks' }, ...card.links.slice(0, 3).map((l) => h('span', { class: 'flink', title: l.title }, faceGlyph(l.status), faceWho(l.agent), h('span', { class: 'ellipsis', text: l.title })))));
  }
  const foot = h('div', { class: 'ffoot' }, faceWho(task ? 'task' : card.agent), dirPill(card.directory || { name: 'カテゴリ無し' }));
  if (!task) {
    const branch = card.git?.branch || card.branch;
    if (branch) foot.append(h('span', { class: 'fbranch ellipsis', title: gitTitleOr(card), text: branch }));
    const stat = faceStat(card);
    if (stat) foot.append(stat);
    if (card.signals?.ctx && ctxPct(card.signals.ctx) >= 75) foot.append(h('span', { class: ctxPct(card.signals.ctx) >= 90 ? 'sig-hot' : 'sig-warn', title: ctxTitle(card.signals.ctx), text: `◔ ${ctxLabel(card.signals.ctx)}` }));
    if (rich && card.host) foot.append(h('span', { class: 'host-chip', title: `SSH: ${card.host.alias}`, text: card.host.label }));
    if (rich) foot.append(acctChip(card));
    if (card.pr) foot.append(prPill(card.pr));
  } else if (card.pr) foot.append(prPill(card.pr));
  const labels = faceLabels(card);
  if (labels) foot.append(labels);
  foot.append(...faceExtras(card), h('span', { class: 'ftime', title: fmtDate(card.updatedAt), text: relTime(card.updatedAt) }));
  el.append(foot);
  return finishFace(el, card, list);
}
const gitTitleOr = (card) => (card.git ? gitTitle(card.git) : card.branch || '');
function faceTaskNow(card) {
  if (!card.links.length) return h('div', { class: 'fnow', text: card.pending?.length ? '開始したセッションを待っています' : 'セッションはまだありません' });
  const n = (s) => card.links.filter((l) => l.status === s).length;
  const parts = [`${card.links.length} セッション`, n('running') ? `実行中 ${n('running')}` : null, n('waiting') ? `入力待ち ${n('waiting')}` : null, n('aborted') ? `中断 ${n('aborted')}` : null].filter(Boolean);
  return h('div', { class: `fnow${n('waiting') ? ' fnow-wait' : n('running') ? ' fnow-run' : ''}`, text: parts.join(' · ') });
}
function finishFace(el, card, list) {
  const latest = card.kind === 'task' ? [...card.links].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] : null;
  const onResume = card.kind === 'task' ? (latest ? (opts) => resume(latest.id, opts) : null) : (opts) => resume(card.id, opts);
  attachCardBehavior(el, card, list, onResume);
  return withPeek(el, card);
}

// ---- inline reply: Space opens a card in place, r goes straight to the input ----
const peekDrafts = new Map();
state.peek = null; // { id, d, loading, error }
function withPeek(el, card) {
  if (card.kind === 'task' || state.styles.peek !== 'on') return el;
  el.append(h('button', { class: 'card-peek', type: 'button', title: 'その場で読んで返信（Space / r）', 'aria-label': `${card.title} をその場で返信`, 'aria-expanded': String(state.peek?.id === card.id), html: picon('message', 14),
    onpointerdown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); togglePeek(card); } }));
  if (state.peek?.id === card.id) { el.classList.add('peeking'); el.append(peekBox(card)); }
  return el;
}
function repaintCard(id, { focusInput = false } = {}) {
  const hit = findCard(id), el = document.querySelector(`.card[data-card-id="${CSS.escape(id)}"]`);
  if (!hit || hit.link || !el || state.drag) return;
  const had = el.contains(document.activeElement);
  const next = renderCard(hit.card, hit.list);
  el.replaceWith(next);
  if (focusInput) next.querySelector('.peek-input')?.focus();
  else if (had) next.focus({ preventScroll: true });
}
async function togglePeek(card, { focusInput = false } = {}) {
  if (state.peek?.id === card.id) {
    if (focusInput) return document.querySelector(`.card[data-card-id="${CSS.escape(card.id)}"] .peek-input`)?.focus();
    state.peek = null; repaintCard(card.id); return;
  }
  const before = state.peek?.id;
  state.peek = { id: card.id, d: null, loading: true, error: null };
  if (before) repaintCard(before);
  repaintCard(card.id);
  try {
    const d = await bridge.callTool('canban_get_session', { cardId: card.id, messages: 4 });
    if (state.peek?.id !== card.id) return;
    state.peek.d = d; state.peek.loading = false;
    const hit = findCard(card.id); if (hit) hit.card.unread = false;
  } catch (e) {
    if (state.peek?.id !== card.id) return;
    state.peek.loading = false; state.peek.error = e.message;
  }
  repaintCard(card.id, { focusInput });
}
function closePeek() { if (!state.peek) return false; const id = state.peek.id; state.peek = null; repaintCard(id); refocus(document.querySelector(`.card[data-card-id="${CSS.escape(id)}"]`)); return true; }
function peekBox(card) {
  const box = h('div', { class: 'peek-box', onpointerdown: (e) => e.stopPropagation(), onclick: (e) => e.stopPropagation(), onkeydown: (e) => { if (e.key !== 'Escape') e.stopPropagation(); } });
  const pk = state.peek;
  if (pk.loading) return (box.append(h('div', { class: 'muted', text: '読み込み中…' })), box);
  if (pk.error || !pk.d) return (box.append(h('div', { class: 'muted', text: `読み込めませんでした: ${pk.error || ''}` })), box);
  box.append(...peekContent(card, pk.d, { limit: 3, onClose: closePeek, onSent: async () => {
    state.peek = { id: card.id, d: null, loading: true, error: null };
    repaintCard(card.id); load();
    const d2 = await bridge.callTool('canban_get_session', { cardId: card.id, messages: 4 }).catch(() => null);
    if (state.peek?.id === card.id) { state.peek.loading = false; state.peek.d = d2; repaintCard(card.id); }
  } }));
  requestAnimationFrame(() => $('.peek-input', box)?.dispatchEvent(new Event('input')));
  return box;
}
// What a reply shows: the last messages, what the session waits for, and the input. Shared by the card's
// inline reply and the inbox preview (onSent refreshes whichever shows it; onClose is the Esc of an empty input).
function peekContent(card, d, { limit = 3, onSent, onClose }) {
  const out = [], s = d.session, D = d.dispatch;
  const said = d.recentMessages.length ? d.recentMessages : (d.feed?.items || []).filter((it) => (it.k === 'user' || it.k === 'assistant') && it.text).map((it) => ({ role: it.k, text: it.text }));
  for (const m of said.slice(-limit)) {
    out.push(h('div', { class: `pmsg ${m.role}` }, h('span', { class: `pwho${m.role === 'user' ? '' : ` who-${s.agent}`}`, text: m.role === 'user' ? 'あなた' : s.agent === 'codex' ? 'Codex' : 'Claude' }),
      h('div', { class: 'ptext', html: mdInline(m.text.length > 420 && limit <= 3 ? `${m.text.slice(0, 420)}…` : m.text) })));
  }
  if (!said.length) out.push(h('div', { class: 'muted', text: d.messagesError ? `メッセージを取得できませんでした: ${d.messagesError}` : 'メッセージはありません' }));
  if (s.status === 'waiting') {
    const what = activityText(s.activity, 'waiting', s.signals) || STATUS_LABELS.waiting;
    out.push(h('div', { class: 'pwait' }, h('b', { text: what }), h('span', { text: 'Canban からは答えられません。アプリで答えてください。' }),
      h('div', { class: 'row' }, d.launch?.desktop ? h('button', { class: 'btn-primary', type: 'button', text: 'アプリで開く', onclick: () => resume(card.id, { route: 'desktop' }) }) : null,
        h('button', { class: 'btn', type: 'button', text: '詳細を開く', onclick: () => openCard(card.id) }))));
  } else if (s.status === 'aborted') out.push(h('div', { class: 'pwait pwait-err' }, h('b', { text: '中断しました' }), h('span', { text: '続けるには指示を送ってください。' })));
  if (!D.settings.enabled) { out.push(h('div', { class: 'muted', text: '指示の送信は設定でオフになっています。' })); return out; }
  const elevated = !!D.permission?.elevated;
  const busy = s.status === 'running' || s.status === 'waiting' || !!s.codexFollowUps;
  const ta = h('textarea', { class: 'peek-input', rows: 1, 'aria-label': '返信', placeholder: elevated ? '制限なしのセッションです。詳細で確認してから送ってください' : busy ? '実行中です。送ると順番待ちに入ります' : 'このセッションに返信', disabled: elevated });
  ta.value = peekDrafts.get(card.id) || '';
  const sendBtn = h('button', { class: 'send-round', type: 'button', title: busy ? 'キューに追加（Enter）' : '送信（Enter）', 'aria-label': busy ? 'キューに追加' : '送信', disabled: !ta.value.trim(), html: picon(busy ? 'queue' : 'send', 14) });
  const fit = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`; sendBtn.disabled = !ta.value.trim() || elevated; };
  ta.addEventListener('input', () => { peekDrafts.set(card.id, ta.value); fit(); });
  const send = async () => {
    const prompt = ta.value.trim();
    if (!prompt || sendBtn.disabled) return;
    sendBtn.disabled = true; ta.disabled = true;
    try {
      await bridge.callTool('canban_dispatch', { cardId: card.id, prompt, imageIds: [], skills: [], when: busy ? 'queue' : 'now', expectedUpdatedAt: s.updatedAt || null, allowElevated: false });
      peekDrafts.delete(card.id);
      toast(busy ? 'キューに追加しました' : '送信しました');
      await onSent?.();
    } catch (e) { toast(e.message, true); ta.disabled = false; fit(); ta.focus(); }
  };
  sendBtn.onclick = send;
  ta.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) { e.preventDefault(); e.stopPropagation(); send(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!ta.value) onClose?.(); else ta.blur(); }
  });
  out.push(h('div', { class: 'peek-compose' }, ta, sendBtn),
    h('div', { class: 'peek-foot' }, h('span', { class: 'peek-keys' }, keyHint(['Enter'], '送信'), keyHint(['Esc'], '閉じる')),
      h('button', { class: 'link-btn', type: 'button', text: 'カードを開く', onclick: () => openCard(card.id) })));
  return out;
}

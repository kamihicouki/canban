// Part of board.html: included into its script by server/ui.mjs and shares its scope.
// Live status, unread and automatic-move rules
const STATUS_LABELS = { running: '実行中', waiting: '入力待ち', completed: '完了', aborted: '中断', idle: '待機' };
// Codex sections as triggers: "moved into § doing" (names come from the board).
function triggerLabel(t) {
  if (t.startsWith('section:')) {
    const sec = state.board?.codexSections?.find((x) => x.id === t.slice(8));
    return `Codex のセクション「${sec ? sec.name : t.slice(8, 16)}」に入ったら`;
  }
  return TRIGGER_LABELS[t] || t;
}
const TRIGGER_LABELS = {
  'status:running': '実行中になったら',
  'status:waiting': '入力待ちになったら',
  'status:completed': '完了したら',
  'status:aborted': '中断したら',
  archived: 'アーカイブされたら',
  activity: '新しい活動があったら',
  'pr:opened': 'PR / MR が作られたら',
  'pr:merged': 'PR / MR がマージされたら',
  'pr:closed': 'PR / MR が閉じられたら',
  'ci:failed': 'CI が失敗したら',
  'ci:passed': 'CI が通ったら',
};
const PR_STATE = { OPEN: ['open', 'オープン'], MERGED: ['merged', 'マージ済み'], CLOSED: ['closed', 'クローズ'] };
const CHECK_ICON = { passing: ['✓', 'CI 成功'], failing: ['✗', 'CI 失敗'], pending: ['●', 'CI 実行中'] };
function prPill(pr) {
  const [cls, label] = pr.isDraft && pr.state === 'OPEN' ? ['draft', 'ドラフト'] : PR_STATE[pr.state] || ['open', pr.state];
  const ck = CHECK_ICON[pr.checks];
  return h('button', { class: `pill pr-pill pr-${cls}`, title: `${pr.title}\n${label}${ck ? ` / ${ck[1]}` : ''}\n${pr.url}`,
    onpointerdown: (e) => e.stopPropagation(),
    onclick: (e) => { e.stopPropagation(); bridge.openLink(pr.url).catch(() => copyText(pr.url, 'PR の URL')); } },
    `${pr.provider === 'gitlab' ? '!' : '#'}${pr.number}`, ck ? h('span', { class: `ck ck-${pr.checks}`, text: ` ${ck[0]}` }) : null);
}
function renderStatusBar(b) {
  const bar = $('#statusBar');
  bar.replaceChildren(...['running', 'waiting', 'completed', 'aborted'].filter((k) => b.statusCounts[k] || state.filters.status === k).map((k) =>
    h('button', { class: 'status-chip', 'aria-pressed': String(state.filters.status === k), title: `${STATUS_LABELS[k]} ${b.statusCounts[k]}（クリックでこれだけを表示）`,
      onclick: () => { state.filters.status = state.filters.status === k ? '' : k; saveFilters(); state.shown = {}; load(); } },
      h('span', { class: `sdot s-${k}` }), String(b.statusCounts[k]))));
  bar.title = ['running', 'waiting', 'completed', 'aborted'].map((k) => `${STATUS_LABELS[k]} ${b.statusCounts[k] || 0}`).join('・');
}
// ---- live signals (context, plan, edited files, rate limits) ----
const WAIT_TEXT = { question: '❓ 質問への回答待ち', plan: '📋 計画の承認待ち' };
function fmtTok(n) {
  if (!n) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}
function ctxPct(ctx) { return ctx?.window ? Math.min(100, Math.round((ctx.used / ctx.window) * 100)) : null; }
const heat = (pct) => (pct >= 90 ? 'hot' : pct >= 75 ? 'warn' : '');
function ctxLabel(ctx) {
  const pct = ctxPct(ctx);
  return pct != null ? `${pct}%` : fmtTok(ctx.used);
}
function ctxTitle(ctx) {
  const pct = ctxPct(ctx);
  return `コンテキスト: ${ctx.used.toLocaleString()} トークン${ctx.window ? ` / ${ctx.window.toLocaleString()}（${pct}%）` : '（上限は不明）'}`;
}
function activityText(activity, status, sig) {
  const w = status === 'waiting' && sig?.wait ? WAIT_TEXT[sig.wait] : null;
  return w ? (activity ? `${w} · ${activity}` : w) : activity || null;
}
const MODE_TEXT = { 'danger-full-access': 'フルアクセス', 'workspace-write': 'ワークスペース書き込み', 'read-only': '読み取り専用', bypassPermissions: '権限確認なし', acceptEdits: '編集は自動承認', plan: 'プランモード', default: '毎回確認', auto: 'auto', dontAsk: '確認しない' };
// The detail's "now" box: model / effort / mode, context meter, plan and edited files.
function renderSignals(sig, git) {
  const box = h('div', { class: 'sig-box', 'aria-live': 'polite' });
  if (git) box.append(h('div', { title: gitTitle(git), text: [`⎇ ${git.branch || '（detached HEAD）'}`, ...gitSummary(git)].join(' · ') + (gitSummary(git).length ? '' : ' · 変更なし') }));
  if (!sig) { box.hidden = !git; return box; }
  const chips = [sig.model, sig.effort ? `effort ${sig.effort}` : null, sig.mode ? (MODE_TEXT[sig.mode] || sig.mode) : null, sig.subRunning ? `🤖 サブエージェント ${sig.subRunning} 動作中` : null].filter(Boolean);
  if (chips.length) box.append(h('div', { class: 'chips' }, ...chips.map((c) => h('span', { class: 'chip', text: c }))));
  if (sig.ctx) {
    const pct = ctxPct(sig.ctx);
    box.append(h('div', { class: 'meter', title: ctxTitle(sig.ctx) }, h('span', { text: 'コンテキスト' }),
      pct != null ? h('span', { class: 'bar' }, h('i', { class: heat(pct), style: { width: `${pct}%` } })) : h('span', { class: 'grow' }),
      h('span', { text: pct != null ? `${pct}%（${fmtTok(sig.ctx.used)} / ${fmtTok(sig.ctx.window)}）` : `${fmtTok(sig.ctx.used)} トークン` })));
  }
  if (sig.plan) {
    box.append(h('div', { text: `計画 ${sig.plan.done}/${sig.plan.total}` }),
      ...(sig.plan.steps || []).map((x) => h('div', { class: `plan-step ${x.s}` }, h('span', { text: x.s === 'done' ? '☑' : x.s === 'doing' ? '▶' : '☐' }), h('span', { text: x.t }))));
  }
  if (sig.files) {
    box.append(h('div', { text: `このターンで編集したファイル（${sig.files.count}）` }),
      h('div', { class: 'file-list' }, ...(sig.files.paths || sig.files.names).map((p, i) => h('div', { title: p, text: sig.files.names[i] || p }))));
  }
  if (!box.childElementCount) box.hidden = true;
  return box;
}
// Live git state of the session's folder (running sessions and the open card).
function gitSummary(g) {
  return [g.changed ? `変更 ${g.changed}` : null, g.untracked ? `未追跡 ${g.untracked}` : null, g.ahead ? `↑${g.ahead}` : null, g.behind ? `↓${g.behind}` : null].filter(Boolean);
}
function gitTitle(g) {
  return `ブランチ: ${g.branch || '（detached HEAD）'}\nコミットしていない変更: ${g.changed} ファイル\n追跡していないファイル: ${g.untracked}\nリモートより ${g.ahead} 進み / ${g.behind} 遅れ`;
}
function gitPill(g, fallback) {
  const extra = [g.changed + g.untracked ? `±${g.changed + g.untracked}` : null, g.ahead ? `↑${g.ahead}` : null, g.behind ? `↓${g.behind}` : null].filter(Boolean).join(' ');
  return h('span', { class: 'ellipsis', title: gitTitle(g), text: `⎇ ${g.branch || fallback || 'detached'}${extra ? ` ${extra}` : ''}` });
}
function renderLimits(l) {
  if (state.board) state.board.limits = l;
  workspace.renderLimitChip(l);
  if (openViewKind() === 'usage') refreshViews();
}
function hasLive(b) { return (b.statusCounts?.running || 0) + (b.statusCounts?.waiting || 0) > 0; }

const announced = new Set();
function announceAutoMoves(b) {
  for (const m of b.recentAutoMoves || []) {
    const key = `${m.cardId}@${m.at}`;
    if (announced.has(key)) continue;
    announced.add(key);
    if (Date.now() - m.at > 90e3) continue; // only fresh moves get a toast
    const list = b.lists.find((l) => l.id === m.toListId);
    toastAction(`⚡「${m.title}」を「${list?.title ?? m.toListId}」へ移動しました`, '元に戻す', () =>
      act('canban_undo_move', { cardId: m.cardId }, { okMsg: '元に戻しました' }));
  }
}
function toastAction(msg, label, fn) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = h('div', { class: 'toast', role: 'status' }, msg, ' ',
    h('button', { class: 'toast-btn', text: label, onclick: () => { t.remove(); fn(); } }));
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 8000);
}

const runningRules = new Set();
async function runRuleNow(ruleId) {
  if (runningRules.has(ruleId)) return;
  const updateButtons = (busy) => {
    for (const button of document.querySelectorAll('[data-run-rule]')) {
      if (button.dataset.runRule !== ruleId) continue;
      button.disabled = busy;
      button.textContent = busy ? '実行中…' : '今すぐ実行';
      button.setAttribute('aria-busy', String(busy));
    }
  };
  runningRules.add(ruleId);
  updateButtons(true);
  try {
    const { result } = await act('canban_run_rule', { ruleId });
    toast(`${result.moved} 件のカードを移動しました${result.errors?.length ? '（一部のセッションを取得できませんでした）' : ''}`);
  } catch {
    // act already displays the server error and refreshes the board.
  } finally {
    runningRules.delete(ruleId);
    updateButtons(false);
  }
}

function rulesMenu(anchor) {
  const b = state.board;
  const listName = (id) => (id === 'any' ? 'どのリストでも' : b.lists.find((l) => l.id === id)?.title ?? '（削除済みリスト）');
  const listSelect = (value, withAny) => pickerButton({ title: withAny ? '移動元のリスト' : '移動先のリスト', value,
    items: () => [withAny ? { value: 'any', label: 'どのリストでも' } : null, ...b.lists.map((l) => ({ value: l.id, label: l.title, color: l.color }))].filter(Boolean) });
  const rows = b.settings.rules.map((r) => h('div', { class: 'rule-row', 'data-key': `${triggerLabel(r.trigger)} ${listName(r.fromListId)} ${listName(r.toListId)}` },
    h('label', { class: 'row grow' },
      h('input', { type: 'checkbox', checked: r.enabled, 'aria-label': `この${T.automation}を有効にする`,
        onchange: (e) => act('canban_set_rule', { ...r, enabled: e.target.checked }).then(() => rulesMenu(anchor)) }),
      h('span', { text: `${triggerLabel(r.trigger)}、${listName(r.fromListId)} → ${listName(r.toListId)}` })),
    h('div', { class: 'rule-actions' },
      h('button', { class: 'btn rule-run', 'data-run-rule': r.id, disabled: runningRules.has(r.id), 'aria-busy': String(runningRules.has(r.id)),
        'aria-label': `${triggerLabel(r.trigger)}の自動化を今すぐ実行`, title: '現在の条件に一致するカードに適用します。自動実行が無効でも実行できます。',
        text: runningRules.has(r.id) ? '実行中…' : '今すぐ実行', onclick: () => runRuleNow(r.id) }),
      h('button', { class: 'icon-btn', 'aria-label': `この${T.automation}を削除`, text: '🗑', onclick: () => act('canban_delete_rule', { ruleId: r.id }).then(() => rulesMenu(anchor)) }))));
  const trig = pickerButton({ title: 'きっかけ', value: 'status:completed', items: () => [...Object.entries(TRIGGER_LABELS).map(([value, label]) => ({ value, label })),
    ...(b.codexSections || []).map((x) => ({ value: `section:${x.id}`, label: triggerLabel(`section:${x.id}`), group: 'Codex セクション' }))] });
  const from = listSelect('any', true);
  const to = listSelect(b.lists[1]?.id ?? b.lists[0].id, false);
  const body = h('div', {},
    rows.length > 5 ? rowFilter(rows) : null,
    rows.length ? rows : h('p', { class: 'muted', text: `${T.automation}はまだありません` }),
    h('div', { class: 'sep' }),
    h('div', { class: 'field-label', text: `新しい${T.automation}` }),
    trig, h('div', { class: 'row', style: { marginTop: '6px' } }, from, h('span', { text: '→' }), to),
    h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn-primary', text: '追加',
      onclick: () => act('canban_set_rule', { enabled: true, trigger: trig.value, fromListId: from.value, toListId: to.value }, { okMsg: `${T.automation}を追加しました` }).then(() => rulesMenu(anchor)) })),
    h('p', { class: 'muted', text: '状態が変わった瞬間にだけ動きます。ボードを閉じていても、Canban を入れた Codex か Claude デスクトップが起動していれば 60 秒ごとに評価されます。自動で動いたカードには ⚡ が付き、直後のお知らせから元に戻せます。' }),
    h('p', { class: 'muted', text: '「今すぐ実行」は、画面の絞り込みに関係なく、現在の条件と移動元に一致するカードを移動します。無効にしたルールも手動実行できます。「新しい活動があったら」は取得したすべてのセッションが対象です。アーカイブ済みのカードを見るには、表示設定でアーカイブ済みを含めてください。' }),
    b.git && b.git.available === false ? h('p', { class: 'muted', text: `PR / CI の${T.automation}は使えません: ${b.git.reason}` }) : null);
  popover(anchor, `${T.automation}（カードの自動移動）`, body, { width: 400 });
}

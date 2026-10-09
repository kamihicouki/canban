// Part of board.html: included into its script by server/ui.mjs and shares its scope.
// Keyboard: global shortcuts, command palette (⌘K) and the ? overlay
const typingIn = (t) => t?.closest?.('input, textarea, select, [contenteditable]');
document.addEventListener('keydown', e => {
  if (e.altKey && !e.metaKey && !e.ctrlKey && !e.isComposing && e.code === 'KeyA' && !typingIn(e.target) && !document.querySelector('.popover')) {
    const picker = claudeAccountPicker(focusedPane());
    if (picker) { e.preventDefault(); picker.click(); }
  }
});
function focusedListId() {
  const a = document.activeElement;
  return a?.closest?.('.list')?.dataset.listId || state.board?.defaultListId;
}
function quickAdd() {
  const focused = document.activeElement;
  const laneName = focused?.closest?.('.lane')?.dataset.lane;
  const listId = focused?.closest?.('.list')?.dataset.listId;
  return taskQuickAdd.open({ listId, lane: state.lanes.find(l => l.key === laneName) });
}
function shortcutHints(entries, className = '') {
  return h('div', { class: `shortcut-hints ${className}`, 'aria-label': 'この画面のキー' },
    ...entries.map(([key, label, disabled = false]) => h('span', { class: 'shortcut-hint', 'aria-disabled': disabled ? 'true' : null },
      h('kbd', { text: key }), h('span', { text: label }))));
}
// Read the rendered list, including its lane and pagination, rather than the unfiltered board data.
// The originating lane survives a board redraw even when the same card occurs in several label lanes.
function displayedListCards(id, origin = cardReturn) {
  if (inboxOn()) return inboxRows().filter(el => el.getClientRects().length);
  const lists = $$('#board .list');
  const originList = origin?.closest?.('.list');
  const lane = originList?.closest('.lane')?.dataset.lane;
  const contains = list => $$('.card', list).some(el => el.dataset.cardId === id);
  const list = lists.find(el => originList && el.dataset.listId === originList.dataset.listId
    && el.closest('.lane')?.dataset.lane === lane && contains(el)) || lists.find(contains);
  return list ? $$('.card', list).filter(el => el.getClientRects().length) : [];
}
function stepDisplayedCard(delta) {
  const overlay = !paneLayer.hidden;
  if (overlay) return stepOpenCard(delta);
  if (inboxOn()) return inboxStep(delta);
  const focused = document.activeElement?.closest?.('#board .card');
  const id = overlay ? panes[0]?.id : focused?.dataset.cardId;
  const cards = id ? displayedListCards(id, overlay ? cardReturn : focused) : $$('#board .card').filter(el => el.getClientRects().length);
  const index = cards.findIndex(el => el.dataset.cardId === id);
  const next = index < 0 ? cards[delta > 0 ? 0 : cards.length - 1] : cards[index + delta];
  if (!next) return;
  next.focus({ preventScroll: true });
  next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function panePromptInput() {
  const active = document.activeElement?.closest?.('.pane');
  const ordered = active ? [active, ...panes.map(p => p.el).filter(el => el !== active)] : panes.map(p => p.el);
  return ordered.map(el => el.querySelector('[data-sec="send"] textarea:not([readonly]):not([disabled])')).find(Boolean);
}
function focusPanePrompt() {
  const input = panePromptInput();
  if (!input) return;
  input.focus({ preventScroll: true });
  input.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function refreshShortcutHints() {
  const upper = document.querySelector('.popover, dialog[open]');
  const input = document.activeElement;
  const typing = typingIn(input);
  const modKey = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
  const globalKeys = [['?', 'キー一覧'], [`${modKey}K`, 'コマンド']];
  let entries;
  if (!paneLayer.hidden) {
    if (upper) entries = [];
    else if (typing) entries = [
      ...(input.closest('[data-sec="send"]') && input.closest('.prompt-composer') ? [[`${modKey}Enter`, input.closest('.pane').dataset.kind === 'task' ? 'セッション開始' : '送信']] : []),
      ['Esc', '入力を抜ける'], [`${modKey}K`, 'コマンド'],
    ];
    else if (panes[0]?.kind === 'view') entries = [[openViewKind() === 'analytics' ? 'a' : 'u', '閉じる'], ['r', '更新'], ...globalKeys, ['Esc', '閉じる']];
    else {
      const cards = displayedListCards(panes[0]?.id), index = cards.findIndex(el => el.dataset.cardId === panes[0]?.id);
      entries = [['k', '前のカード', index <= 0], ['j', '次のカード', index < 0 || index === cards.length - 1],
        ['⇧←', '左のリストへ', !adjacentPaneList(focusedPane(), -1)], ['⇧→', '右のリストへ', !adjacentPaneList(focusedPane(), 1)],
        ...(panes.length > 1 ? [['[ / ]', '横のカード']] : []), ['1', 'テキスト'], ['2', 'プレビュー'], ['3', '要点'],
        ...(focusedPane()?.kind === 'session' ? [['z', 'アーカイブ / 復元'], ['Delete', '履歴削除']] : []),
        ...(panePromptInput() ? [['i', '指示欄']] : []), ...(focusedPane()?.el.dataset.detail === 'thread' && focusedPane()?.kind === 'session' ? [['d', '詳細パネル'], ['f', '変更']] : []), ['r', '更新'], ...globalKeys, ['Esc', '閉じる']];
    }
    paneHints.replaceChildren(...shortcutHints(entries).childNodes);
    shortcutMap.hidden = entries.length === 0;
    positionShortcutMap();
  }
  boardKeyHints.hidden = !paneLayer.hidden || !!upper;
  if (!boardKeyHints.hidden) {
    if (typing) entries = input.id === 'q' ? [['↓ / Enter', 'カードへ'], ['Esc', '検索をクリア']] : [['⌘K / Ctrl+K', 'コマンド']];
    else if (workspace.utilityPage()) entries = [...globalKeys, ['Esc', 'パネルを閉じる']];
    else if (input?.matches('.card')) entries = [['j / k', '次 / 前'], ['Enter', '開く'], ['Space', 'その場で返信'], ['l', 'ラベル'], ['m', 'リストへ移動'], ...globalKeys];
    else entries = [['j / k', 'カード選択'], ['/', '検索'], ['c', 'タスク追加'], ['i', timelineOn() ? 'ボード' : '時間軸'], ...(state.lens ? [['Esc', '照らすのをやめる']] : []), ['b', 'ナビゲーション'], ['a / u', '分析 / Usage'], ['r', '更新'], ...globalKeys];
    boardKeyHints.replaceChildren(...shortcutHints(entries).childNodes);
  }
}
const boardKeyHints = shortcutHints([], 'board-shortcuts');
document.body.append(boardKeyHints);
document.addEventListener('focusin', refreshShortcutHints);
document.addEventListener('focusout', () => queueMicrotask(refreshShortcutHints));
document.addEventListener('click', refreshShortcutHints);
const SHORTCUTS = [
  ['全体', [
    ['/', '検索にフォーカス（Esc でクリア、↓ / Enter で最初のカードへ）'], ['⌘K / Ctrl+K', `コマンドパレット（カード・ビュー・${T.category}・操作を検索して実行）`],
    ['p', `${T.category}・プロジェクトで絞り込み`], ['b', 'サイドバーの開閉'], ['[ / ]', '前 / 次のスイムレーンへ'],
    ['c', 'タスクを追加'], ['1〜9', '保存したビューに切り替え'], ['a', '分析を開く / 閉じる'], ['r', '再読み込み'], ['?', 'この一覧'],
  ]],
  ['時間（寿命）', [
    ['i', 'ボード（リストごと）と時間軸（時間ごと）を切り替え'], ['時間の帯で ← →', '日を移動（Home / End で最古 / 今日）。Enter で照らす'],
    ['Esc', '照らすのをやめる（ボード）'], ['⌘K', '「期間: …」「…のカードを照らす」'],
  ]],
  ['Slack', [['v', 'Slackタイムラインの表示 / 非表示（ボード）'], ['c / l / t', 'メッセージ上: タスク作成 / カードへ追加 / 返信'], ['Alt+s', 'カード内: Slack資料の追加ボタンへ'], ['Esc', 'タイムライン内: 非表示']]],
  ['カードを選択中', [
    ['Enter', '詳細を開く'], ['Space / r', 'その場で読んで返信（r は入力欄へ）'], ['l', 'ラベル'], ['g', `${T.category}`], ['m', 'リストへ移動'],
    ['← →', '隣のリストへ移動'], ['↑ ↓ / Home End', 'リスト内で移動'], ['⌥ + 矢印', 'フォーカスだけ移動'],
    ['o', '再開（既定）'], ['d / t', 'デスクトップ / ターミナルで再開'], ['w n s e', 'ターミナル: 新規ウィンドウ / 新規タブ / 分割 / 既存'],
  ]],
  ['カードを開いている間', [
    ['Alt+a', 'Claude の実行アカウントを選ぶ（このマシンのセッション）'],
    ['Shift+← / →', '左右の隣のリストへ移動（端で停止、入力中・配置調整中は無効）'],
    ['j / k', '表示リストの次 / 前のカードを開く（端で停止）'], ['[ / ]', '横に並んだ隣のカードへ（タスクと紐付いたセッション）'], ['1 2 3', '会話の表示: テキスト / プレビュー / 要点'],
    ['z', 'エージェントのセッションをアーカイブ / 復元'], ['Delete', 'セッションと会話履歴を削除（確認あり）'], ['i', '指示の入力欄へ'], ['d / f', 'スレッド表示: 詳細パネル / 変更を開閉'], ['⌥Enter', '入力欄: キューに追加（⌘Enter は送信）'], ['o', '再開'], ['l g m', 'ラベル / ' + T.category + ' / リスト移動'], ['c', 'タスクを追加'], ['⌘K', 'コマンドパレット'], ['?', 'この一覧'], ['Esc', '入力欄を抜ける → 閉じる'],
  ]],
  ['カードのサイズ', [['右端・下端 + 矢印', 'カードの幅と高さを調整（同じ種類のカードで共通）'], ['右端・下端 + Home', '既定のサイズへ戻す']]],
  ['ピッカー', [['文字を入力', '絞り込み'], ['↑ ↓ / Enter', '選ぶ'], ['Space', '複数選択の切り替え（入力が空のとき）'], ['Esc', '閉じる']]],
];
function showShortcuts() {
  const body = h('div', { class: 'keys' }, SHORTCUTS.flatMap(([group, keys]) => [h('h4', { text: group }), ...keys.flatMap(([k, v]) => [h('kbd', { text: k }), h('span', { text: v })])]));
  const p = popover($('#q'), 'キーボードショートカット', body, { width: 520 });
  p.classList.add('palette');
  p.querySelector('.close').focus();
}
function commandPalette() {
  const sessionPane = !paneLayer.hidden && focusedPane()?.kind === 'session' && focusedPane()?.d?.session ? focusedPane() : null;
  const b = state.board;
  if (!b) return;
  const f = state.filters;
  const actions = [
    { label: openViewKind() === 'analytics' ? '分析を閉じる' : '分析を開く', run: toggleAnalytics, hint: 'a' },
    { label: openViewKind() === 'usage' ? 'Agent Usage を閉じる' : 'Agent Usage を開く', run: () => toggleView('usage'), hint: 'u' },
    ...(paneLayer.hidden || panes[0]?.kind !== 'view' ? [
      { label: paneLayer.hidden ? '次のカードにフォーカス' : '次のカードを開く', run: () => stepDisplayedCard(1), hint: 'j' },
      { label: paneLayer.hidden ? '前のカードにフォーカス' : '前のカードを開く', run: () => stepDisplayedCard(-1), hint: 'k' },
    ] : []),
    ...(!paneLayer.hidden && panes[0]?.kind !== 'view' ? [
      ...PANE_MODES.map(([mode, label], i) => ({ label: `会話を${label}で表示`, run: () => setPaneMode(mode), hint: String(i + 1) })),
      ...(panePromptInput() ? [{ label: '指示欄にフォーカス', run: focusPanePrompt, hint: 'i' }] : []),
      { label: 'カードを閉じる', run: closeCards, hint: 'Esc' },
    ] : []),
    ...DRAWER_PAGES.map((page) => ({ label: `${WORKSPACE_PAGES.find(([id]) => id === page)[1]}を開く`, run: () => workspace.navigate(page) })),
    { label: '再読み込み', run: () => paneLayer.hidden ? load({ refresh: true }) : openCard(panes[0].id), hint: 'r' },
    { label: 'すべて既読にする', run: () => act('canban_mark_all_seen', {}, { okMsg: 'すべて既読にしました' }) },
    { label: state.sideOpen ? 'サイドバーを閉じる' : 'サイドバーを開く', run: () => toggleSidebar(), hint: 'b' },
    { label: 'タスクを追加', run: () => taskQuickAdd.open(), hint: 'c' },
    { label: slackUi.visible ? 'Slackタイムラインを隠す' : 'Slackタイムラインを表示', run: () => slackUi.toggle(), hint: 'v' },
    ...((slackUi.selected && slackUi.visible) ? [
      { label: '選択したSlackメッセージをタスクにする', run: () => slackUi.create(slackUi.selected), hint: 'c' },
      { label: '選択したSlackメッセージをカードに追加', run: () => slackUi.link(slackUi.el,slackUi.selected), hint: 'l' },
      { label: '選択したSlackメッセージの返信を読む', run: () => { const node = [...slackUi.el.querySelectorAll('[data-slack-key]')].find(n => n.dataset.slackKey === slackUi.selected.key); if (node) slackUi.thread(node,slackUi.selected); }, hint: 't' },
    ] : []),
    { label: 'Slack資料の追加ボタンへ', run: () => focusedPane()?.el.querySelector('.slack-add-prompt')?.focus(), hint: 'Alt+s' },
    ...(!paneLayer.hidden && focusedPane()?.kind !== 'view' ? [
      ...[-1, 1].filter(step => adjacentPaneList(focusedPane(), step)).map(step => {
        const p = focusedPane(), target = adjacentPaneList(p, step);
        return { label: `カードを${step < 0 ? '左' : '右'}のリスト「${target.title}」へ移動`, run: () => movePaneAdjacent(p, step), hint: `Shift+${step < 0 ? '←' : '→'}` };
      }),
      ...(sessionPane ? [
        { label: sessionPane.d?.card.archived ? 'セッションカードをアーカイブから戻す' : 'セッションをアーカイブ', run: () => paneKeyButton(sessionPane, 'z')?.click(), hint: 'z' },
        ...(sessionPane.d?.launch?.claudeAccounts?.length ? [{ label: 'Claude の実行アカウントを選ぶ', run: () => claudeAccountPicker(sessionPane)?.click(), hint: 'Alt+a' }] : []),
        { label: 'セッションと会話履歴を削除…', run: () => confirmSessionCardDelete(sessionPane), hint: 'Delete' },
      ] : []),
      { label: 'カード: サイズを初期化', run: resetCardLayout },
      { label: 'カード: サイズを変更', run: () => focusedPane()?.el.querySelector('.pane-corner')?.focus() },
    ] : []),
    { label: '絞り込みをすべて解除', run: () => { $('#q').value = ''; setScope({ directory: '', project: '', q: '', status: '', host: '' }); } },
    ...Object.entries(LANE_MODES).map(([v, t]) => ({ label: `スイムレーン: ${t}`, run: () => { f.swimlane = v; state.soloLane = null; saveFilters(); render(); } })),
    ...Object.entries(LANE_HEIGHTS).map(([v, [t]]) => ({ label: `レーンの高さ: ${t}`, run: () => { f.laneHeight = v; saveFilters(); render(); } })),
    { label: 'キーボードショートカット', run: showShortcuts, hint: '?' },
    ...LAYOUTS.map(([id, name]) => ({ label: `レイアウト: ${name}`, run: () => setLayout(id) })),
    { label: timelineOn() ? 'ボードで表示' : '時間軸で表示', run: toggleBoardView, hint: 'i' },
    ...PERIODS.filter(([k]) => Number(f.days) !== k).map(([k, n]) => ({ label: `期間: ${n}`, run: () => setScope({ days: k }) })),
    ...Object.entries(LIFE_LABELS).map(([k, n]) => ({ label: `${n}のカードを照らす`, run: () => pinLens({ life: k }) })),
    ...[['light', 'ライト'], ['dark', 'ダーク'], ['system', 'システム']].map(([k, n]) => ({ label: `色: ${n}`, run: () => setThemePref(k) })),
  ];
  const run = new Map();
  const items = [];
  const add = (group, badge, label, fn, extra = {}) => { const value = `${items.length}`; run.set(value, fn); items.push({ value, label, group, badge, ...extra }); };
  actions.forEach((a) => add('操作', '操作', a.label, a.run, { hint: a.hint }));
  (b.settings.views || []).forEach((v, i) => add('ビュー', 'ビュー', v.name, () => applyView(v), { hint: i < 9 ? i + 1 : '' }));
  state.lanes.forEach((l) => add('レーン', 'レーン', l.name, () => jumpToLane(l.key), { hint: l.count, color: l.color }));
  b.directories.forEach((d) => add(`${T.category}`, '📂', d.name, () => setScope({ directory: d.id }), { hint: d.count, color: d.color }));
  b.projects.forEach((p) => add('プロジェクト', '📁', p.name, () => setScope({ project: p.name }), { hint: p.count }));
  b.labels.forEach((l) => add('ラベルで絞り込み', '🏷', l.name, () => setScope({ label: l.id }), { color: l.color }));
  for (const l of b.lists) for (const c of l.cards) {
    add('カード', l.title, c.title, () => {
      openCard(c.id);
    }, { dot: c.status !== 'idle' ? c.status : null, hint: c.directory?.name || c.project || '', keywords: `${c.branch || ''} ${c.agent || ''}` });
  }
  const p = picker($('#q'), {
    title: 'コマンド', items, width: 560, placeholder: `カード・ビュー・${T.category}・操作を検索…`, limit: 200,
    onPick: (v) => run.get(v)?.(),
  });
  p.classList.add('palette');
}
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || document.querySelector('dialog[open]')) return;
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    const palette = document.querySelector('.popover.palette');
    if (palette) closePopover(palette); else commandPalette();
    return;
  }
  if (e.key === 'c' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing && !typingIn(e.target) && !taskQuickAdd.dialog?.open && !document.querySelector('.popover')) { e.preventDefault(); quickAdd(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing || !paneLayer.hidden || typingIn(e.target) || document.querySelector('.popover')) return;
  const onCard = e.target.classList?.contains('card');
  const k = e.key;
  const run = {
    j: () => stepDisplayedCard(1), k: () => stepDisplayedCard(-1),
    '/': focusSearch, '?': showShortcuts, b: () => toggleSidebar(), '[': () => stepLane(-1), ']': () => stepLane(1),
    r: () => load({ refresh: true }).then(() => toast('最新の状態に更新しました')), a: toggleAnalytics, u: () => toggleView('usage'),
    c: quickAdd, v: () => slackUi.toggle(), p: () => scopePicker($('#logo')), i: toggleBoardView,
    Escape: state.lens ? () => pinLens(null) : null,
  }[k];
  if (run) { e.preventDefault(); return run(); }
  // 1–9: switch saved views
  if (/^[1-9]$/.test(k) && !onCard) {
    const v = state.board?.settings?.views?.[Number(k) - 1];
    if (v) applyView(v);
  }
});
$('#seenBtn').addEventListener('click', () => act('canban_mark_all_seen', {}, { okMsg: 'すべて既読にしました' }));
$('#perfBtn').addEventListener('click', (e) => perfPanel(e.currentTarget));
$('#refresh').addEventListener('click', () => load({ refresh: true }).then(() => toast('最新の状態に更新しました')));

// board: wheel over empty space scrolls horizontally like Trello
$('#board').addEventListener('wheel', (e) => {
  if (e.target.closest('.cards') || state.filters.swimlane) return;
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { $('#board').scrollLeft += e.deltaY; e.preventDefault(); }
}, { passive: false });

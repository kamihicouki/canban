// Part of board.html: included into its script by server/ui.mjs and shares its scope.
// Task card detail
function findCard(cardId) {
  for (const l of state.board?.lists || []) for (const c of l.cards) if (c.id === cardId) return { card: c, list: l };
  return null;
}

// The sessions linked to a task: the ones beside it on the layer scroll into view, the rest open on their own.
const taskRelatedTitle = (card) => `紐付いたセッション（${card.links.length}）`;
function taskLinkButton(taskId) {
  return h('button', { class: 'icon-btn task-link', type: 'button', text: '＋', title: 'セッションを紐付ける', 'aria-label': 'セッションを紐付ける', onclick: (e) => taskLinkMenu(e.currentTarget, taskId) });
}
function taskRelatedNodes(card) {
  const cardId = card.id, { total } = taskOverlayIds(cardId, card.links);
  const rows = card.links.map((l) => h('div', { class: 'sub-row task-related-row', 'data-session-id': l.id },
    h('span', { class: `sdot s-${l.status}` }),
    h('div', { class: 'task-related-copy grow' },
      h('button', { class: 'link-btn', text: l.title, title: '詳細を見る', onclick: () => selectTaskThread(cardId, l.id) }),
      h('div', { class: 'task-related-meta' }, h('span', { class: `badge ${l.agent}`, text: l.agent === 'codex' ? 'Codex' : 'Claude' }),
        l.host ? h('span', { class: 'host-chip', text: l.host.label }) : null,
        h('span', { class: 'muted', text: `${STATUS_LABELS[l.status]}・${relTime(l.updatedAt)}` }))),
    h('div', { class: 'task-related-actions' },
      h('button', { class: 'seg-btn', title: shortcutHelp(), text: '再開', onclick: e => resume(l.id, optsFromEvent(e)) }),
      h('button', { class: 'icon-btn', 'aria-label': '紐付けを解除', title: '紐付けを解除', html: picon('close', 12),
        onclick: () => act('canban_unlink_session', { taskId: cardId, sessionId: l.id }, { okMsg: '紐付けを解除しました' }).then(() => openCard(cardId)) }))));
  const pending = card.pending.length ? [h('div', { class: 'msg' },
    card.pending.map((x) => `${x.expired ? '⚠ 見つかりません' : '⏳ 開始待ち'}: ${x.agent === 'codex' ? 'Codex' : 'Claude'}（${relTime(x.startedAt)}）`).join(' / '), ' ',
    h('button', { class: 'link-btn', text: '取り消す', onclick: () => act('canban_clear_pending', { taskId: cardId }).then(() => openCard(cardId)) }))] : [];
  const more = total > TASK_SESSIONS_MAX ? [h('p', { class: 'muted task-related-more', text: `横に並べるのは ${TASK_SESSIONS_MAX} 件までです。ほかの会話はここから個別に開けます。` })] : [];
  return [...(rows.length ? rows : [h('p', { class: 'muted', text: 'なし' })]), ...pending, ...more];
}
function paintTaskRelated(p, card) {
  const sec = $('[data-sec="related"]', p.el);
  if (!sec) return;
  const signature = JSON.stringify([card.links.map((l) => [l.id, l.title, l.status, l.agent, l.host?.label, relTime(l.updatedAt)]), card.pending]);
  if (sec.dataset.signature === signature) return;
  sec.dataset.signature = signature;
  $('.th-sec-b', sec).replaceChildren(...taskRelatedNodes(card));
  const heading = $('.th-sec-t', sec);
  if (heading?.firstChild) heading.firstChild.textContent = taskRelatedTitle(card);
}
async function taskLinkMenu(anchor, taskId) {
  try {
    const linked = findCard(taskId)?.card.linkedSessionIds || [];
    const board = await bridge.callTool('canban_get_board', { days: 0, includeArchived: true });
    const candidates = board.lists.flatMap((l) => l.cards).flatMap((c) => c.kind === 'task' ? c.links.map((x) => ({ ...x, title: `${x.title}（${c.title}から移動）` })) : [c]);
    const cards = [...new Map(candidates.filter((c) => !c.subagent && !linked.includes(c.id)).map((c) => [c.id, c])).values()];
    const rows = cards.map((c) => h('button', { class: 'menu-item', 'data-key': c.title, text: c.title, onclick: async () => {
      await act('canban_link_session', { taskId, sessionId: c.id }, { okMsg: 'タスクに紐付けました' }); closePopover();
    } }));
    popover(anchor, '通常のセッションを紐付ける', h('div', {}, rows.length ? [rowFilter(rows), ...rows] : h('p', { class: 'muted', text: '紐付けられるセッションがありません' })), { width: 400 });
  } catch (e) { toast(e.message, true); }
}

async function loadTask(p, found) {
  if (p.rendered && workspace.hasDrafts(p.el)) { paintTaskRelated(p, found.card); return; } // what is being typed stays
  const cardId = p.id;
  const { card, list } = found;
  p.taskCard = card;
  const b = state.board;
  const title = h('textarea', { class: 'title-input', rows: 2, maxlength: 300, 'aria-label': 'タイトル' });
  title.value = card.title; title.defaultValue = card.title;
  title.onchange = () => title.value.trim() && workspace.saveField(title, value => act('canban_update_task', { cardId, title: value }));
  const desc = h('textarea', { class: 'note', placeholder: '説明（新しいセッションへの依頼文にも使われます）', 'aria-label': '説明' });
  desc.value = card.description;
  desc.defaultValue = card.description;
  desc.onblur = () => desc.value !== desc.defaultValue && workspace.saveField(desc, value => act('canban_update_task', { cardId, description: value }, { okMsg: '保存しました' }));

  const listSel = cardListControls(p, list.id);

  const memo = h('textarea', { class: 'note', 'aria-label': 'メモ', placeholder: 'タスクのメモ' });
  memo.value = memo.defaultValue = card.note || '';
  memo.onblur = () => memo.value !== memo.defaultValue && workspace.saveField(memo, value => act('canban_update_card', { cardId, note: value }, { okMsg: 'メモを保存しました' }));

  // --- start a new session
  const t = { ...card.target, ...(card.context?.agent ? { agent: card.context.agent } : {}), ...(card.context?.host ? { hostId: card.context.host } : {}) };
  if (t.hostId && !b.hosts.some(host => !host.cloud && (host.local ? 'local' : host.id) === t.hostId)) t.hostId = 'local';
  const agentSel = h('select', { class: 'text-input', 'aria-label': 'AI App' }, h('option', { value: 'codex', text: 'Codex' }), h('option', { value: 'claude', text: 'Claude Code' }));
  agentSel.value = t.agent || 'codex';
  const hostSel = pickerButton({ title: 'マシン', value: t.hostId || 'local', stack: false,
    items: () => b.hosts.filter(x => !x.cloud).map((x) => ({ value: x.local ? 'local' : x.id, label: x.local ? 'このマシン' : `⌂ ${x.label}${x.enabled ? '' : '（読み取りオフ）'}`, keywords: x.alias || '' })),
    onChange: () => { fillFolders(); paintAccount(); composer.contextChanged(); } });
  // The account to start with: Claude Desktop switches to that account's signed-in profile.
  const accountFor = (agent) => [t.account, card.context?.account].find(k => k && k.split(':')[0] === agent) || '';
  const acctSel = pickerButton({ title: 'アカウント', popoverTitle: '開始するアカウント', value: accountFor(agentSel.value), stack: false, width: 340, placeholder: 'メールで検索',
    items: () => [{ value: '', label: `${agentSel.value === 'codex' ? 'Codex' : 'Claude'} · いまのログイン`, description: 'Desktop・CLI の現在のアカウントで開始' }, ...accountItems(agentSel.value)] });
  acctSel.classList.add('start-account');
  const paintAccount = () => {
    const remote = hostSel.value !== 'local';
    if (remote || (acctSel.value && acctSel.value.split(':')[0] !== agentSel.value)) acctSel.value = remote ? '' : accountFor(agentSel.value);
    acctSel.disabled = remote; acctSel.repaint();
    if (remote) acctSel.title = 'リモートのマシンでは、そのマシンのログインで開始します';
  };
  agentSel.addEventListener('change', paintAccount);
  paintAccount();
  const dl = h('datalist', { id: `folders-${cardId}` });
  const cwd = h('input', { class: 'text-input', list: dl.id, placeholder: '作業フォルダ（絶対パス）', value: t.cwd || '', 'aria-label': '作業フォルダ' });
  const fillFolders = () => dl.replaceChildren(...b.folders.filter((f) => f.hostId === hostSel.value).map((f) => h('option', { value: f.cwd, label: f.project || '' })));
  fillFolders();
  const prompt = h('textarea', { class: 'note', 'aria-label': '依頼文' });
  prompt.value = taskRequestText(card.title, card.description, card.note);
  prompt.defaultValue = prompt.value;
  const composer = promptComposer(prompt, { key: `start:${cardId}`, context: () => ({ agent: agentSel.value, hostId: hostSel.value, cwd: cwd.value.trim() }), submit: () => start() });
  agentSel.addEventListener('change', () => composer.contextChanged());
  cwd.addEventListener('change', () => composer.contextChanged());
  const startButtons = [];
  const start = async (opts = {}) => {
    if (composer.draft.sending) return;
    try {
      const payload = composer.payload();
      composer.setSending(true); startButtons.forEach(b => { b.disabled = true; });
      const r = await bridge.callTool('canban_start_session', { taskId: cardId, agent: agentSel.value, hostId: hostSel.value, cwd: cwd.value.trim(), prompt: prompt.value, account: acctSel.value || null, ...payload, ...opts });
      toast(r.note || `${acctSel.value ? accountName(acctSel.value) : agentSel.value === 'codex' ? 'Codex' : 'Claude'} で開始しました。セッションが現れると自動で紐付きます`, !!r.note);
      composer.clear();
      prompt.value = ''; workspace.draftValues.set(prompt, '');
      load();
    } catch (e) {
      toast(e.message, true);
    } finally {
      composer.setSending(false); startButtons.forEach(b => { b.disabled = false; });
    }
  };
  startButtons.push(h('button', { class: 'btn-primary', title: shortcutHelp(), text: `▶ 開始（${routeLabel(b.settings.launch.route, { desktop: true })}）`, onclick: e => start(optsFromEvent(e)) }),
    h('button', { class: 'btn', text: 'デスクトップで', onclick: () => start({ route: 'desktop' }) }),
    h('button', { class: 'btn', text: 'ターミナルで', onclick: () => start({ route: 'terminal' }) }));

  const prio = h('select', { class: 'text-input', 'aria-label': '優先度' },
    h('option', { value: '', text: '未設定' }), h('option', { value: 'high', text: '高' }), h('option', { value: 'medium', text: '中' }), h('option', { value: 'low', text: '低' }));
  prio.value = card.priority || '';
  prio.onchange = () => workspace.saveField(prio, value => act('canban_update_card', { cardId, priority: value || null }));
  const due = h('input', { class: 'text-input', type: 'date', 'aria-label': '期限' });
  due.value = card.due ? card.due.slice(0, 10) : '';
  due.onchange = () => workspace.saveField(due, value => act('canban_update_card', { cardId, due: value || null }));
  const labelState = { labels: [...card.labels] };

  const secs = {
    breadcrumb: { nodes: [cardCrumb(listSel)] },
    title: { nodes: [title] },
    status: { nodes: [h('div', { class: 'sub row' }, taskQuickAdd.button(), h('span', { class: 'badge task-badge', text: T.taskCard }), h('span', { class: 'row pane-status' }, h('span', { class: `sdot s-${card.status}` }), STATUS_LABELS[card.status]))] },
    conv: { title: '説明', nodes: [desc], hint: '説明は Canban に保存します。新しいセッションの依頼文にも使います。' },
    memo: { title: 'メモ', nodes: [memo] },
    related: { title: taskRelatedTitle(card), extra: taskLinkButton(cardId), nodes: taskRelatedNodes(card), hint: 'ホームのセッションをこのカードへドラッグして紐付けることもできます。' },
    send: { title: '新しいセッションを開始', extra: h('span', {}, ...keycap('i'), ' ', ...keycap('Alt+a')), nodes: [h('div', { class: 'start-grid' }, agentSel, hostSel, acctSel, cwd, dl),
      h('button', { class: 'btn', text: '説明・メモを依頼文に取り込む', onclick: () => {
        if (prompt.value !== prompt.defaultValue && prompt.value.trim()) return toast('入力中の依頼文があります。先に内容を確認してください', true);
        prompt.value = taskRequestText(title.value, desc.value, memo.value);
        prompt.dispatchEvent(new Event('input', { bubbles: true }));
      } }), composer.root,
      h('div', { class: 'muted', text: 'デスクトップで開始すると、依頼文に画像の参照を含めます。' }),
      h('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap' } },
        ...startButtons)], hint: '開始したセッションは、AI App・マシン・フォルダ・依頼文が一致すると自動でこのカードに紐付きます。' },
    add: { nodes: [taskQuickAdd.summary(card),
      h('button', { class: 'side-btn', text: '所属を変更', onclick: () => taskQuickAdd.edit(card, list) }), h('button', { class: 'side-btn', 'data-pane-key': 'l', onclick: e => labelPicker(e.currentTarget, cardId, labelState, () => {}) }, h('span', { html: picon('tag', 14) }), ' ラベル', keycap('l')),
      h('button', { class: 'side-btn', 'data-pane-key': 'g', onclick: e => directoryPicker(e.currentTarget, card, { cwd: cwd.value.trim() || null, after: () => openCard(cardId) }) }, h('span', { html: picon('folder', 14) }), ` ${T.category}: ${card.directory?.name || 'カテゴリ無し'}`, keycap('g'))] },
    prio: { nodes: [prio, due] },
    other: { nodes: [h('button', { class: 'side-btn danger-text', text: 'カードを削除', onclick: async () => { if (confirmInline(p.el, `この${T.taskCard}を削除します。紐付いたセッション自体は消えません。`)) { await act('canban_delete_task', { cardId }, { okMsg: '削除しました' }); closeCards(); } } })] },
  };
  if (card.slackRefs?.length) secs.slack = { nodes: [slackUi.sources(cardId, prompt)] };
  p.status = card.status;
  p.el.setAttribute('aria-label', `タスクカード詳細: ${card.title}`);
  renderTaskThreadPane(p, card, secs);
  paintPaneButtons(p); applyPaneAttrs(p);
  p.rendered = true;
  workspace.trackDrafts(p.el);
}

// Two-step confirm without window.confirm (blocked in sandboxed iframes).
function confirmInline(host, message) {
  if (host.dataset.confirming === message) { delete host.dataset.confirming; return true; }
  host.dataset.confirming = message;
  toast(`${message} もう一度押すと実行します`);
  setTimeout(() => { if (host.dataset.confirming === message) delete host.dataset.confirming; }, 4000);
  return false;
}

function kv(k, v) { return [h('dt', { text: k }), h('dd', { text: v })]; }

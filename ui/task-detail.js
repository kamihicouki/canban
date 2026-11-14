// Part of board.html: included into its script by server/ui.mjs and shares its scope.
// A durable waiting launch must finish cancellation before its request ID can be replaced.
async function cancelTaskLaunchWait(draft, callTool) {
  if (!draft.launchRequest || !['waiting-for-quit', 'waiting-for-login', 'prepared', 'opening'].includes(draft.launchResult?.state)) return true;
  const response = await callTool('canban_cancel_start_session', { clientRequestId: draft.launchRequest.clientRequestId });
  rememberTaskLaunchResult(draft, response.result || response);
  return draft.launchResult.state === 'cancelled';
}

// Terminal and remote folder routes cannot claim that a saved Project was applied.
function taskLaunchLocation(selected, args, hosts) {
  if (!selected) return args;
  const hostId = selected.hostId || (selected.kind === 'ssh' ? hosts.find(h => h.id === selected.sshHost || h.alias === selected.sshHost)?.id : 'local');
  if (args.route === 'desktop' && args.agent === 'codex' && hostId === 'local') return { ...args, hostId: 'local', cwd: '', projectId: selected.id, sourceRef: selected.sourceRef };
  if (args.route === 'desktop' && args.agent === 'claude') throw new Error('保存環境の完全適用は未確認です。元アプリで開始するかフォルダ指定を選んでください');
  const cwd = selected.cwd || selected.root || (selected.roots?.length === 1 ? selected.roots[0] : '');
  if (!hostId || !cwd?.startsWith('/')) throw new Error('開始設定の作業フォルダとマシンを確認できません。フォルダを指定してください');
  return { ...args, cwd, hostId, account: hostId === 'local' || args.route === 'desktop' ? args.account : null };
}

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
      h('div', { class: 'task-related-meta' }, h('span', { class: `badge ${l.agent}`, text: agentLabel(l.agent) }),
        cardSurface(l) ? h('span', { class: 'pill', text: SURFACE_META[cardSurface(l)]?.short || cardSurface(l) }) : null,
        l.host ? h('span', { class: 'host-chip', text: l.host.label }) : null,
        h('span', { class: 'muted', text: `${STATUS_LABELS[l.status]}・${relTime(l.updatedAt)}` }))),
    h('div', { class: 'task-related-actions' },
      h('button', { class: 'seg-btn', title: shortcutHelp(), text: '再開', onclick: e => resume(l.id, optsFromEvent(e)) }),
      h('button', { class: 'icon-btn', 'aria-label': '紐付けを解除', title: '紐付けを解除', html: picon('close', 12),
        onclick: () => act('canban_unlink_session', { taskId: cardId, sessionId: l.id }, { okMsg: '紐付けを解除しました' }).then(() => openCard(cardId)) }))));
  const pending = card.pending.length ? [h('div', { class: 'msg' },
    card.pending.map((x) => `${x.expired ? '⚠ 見つかりません' : '⏳ 開始待ち'}: ${agentLabel(x.agent)}（${relTime(x.startedAt)}）`).join(' / '), ' ',
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

function taskHandoffQuote(task, card) {
  const links = card.links || [];
  return [
    '引継ぎ（保存された目的・観測状態・報告者の提案）',
    `目的:\n${task.description || '未記入'}`,
    `現在地（担当会話の状態。仕事の完了確認とは別）:\n${links.length ? links.map(link => `${link.title}: ${link.statusKnown === false ? '状態未確認' : STATUS_LABELS[link.status] || '状態未確認'}`).join('\n') : '担当会話なし'}`,
    `次の行動（提案）:\n${task.nextAction || '未記入'}`,
    ...links.filter(link => link.last).map(link => `担当会話の最終返答（発言時刻未取得）・${link.title}:\n${link.last}`),
    task.latestNoteSummary ? `最新報告の抜粋:\n${task.latestNoteSummary.text}` : '追記報告なし',
  ].join('\n\n');
}

// Explicit quoting appends after the entire draft; an existing selection is never replaced.
function appendTaskHandoffDraft(input, quote, EventType = Event) {
  if (!input.value.endsWith(quote)) {
    input.value += `${input.value ? '\n\n' : ''}${quote}`;
    input.dispatchEvent(new EventType('input', { bubbles: true }));
  }
  input.focus();
  input.setSelectionRange?.(input.value.length, input.value.length);
}

function taskHandoffSection(p, card, prompt, composer) {
  let task = null, notes = [], nextCursor = null, busy = false, historyOpen = false, renderedSignature = '';
  const summary = h('div'), history = h('div');
  const notice = h('p', { class: 'muted', role: 'status', 'aria-live': 'polite', text: '引継ぎを読み込み中…' });
  const retry = h('button', { class: 'link-btn', type: 'button', text: '再読み込み', hidden: true, onclick: () => p.refreshTaskHandoff(true) });
  const more = h('button', { class: 'link-btn', type: 'button', text: '報告の続きを読む', hidden: true, onclick: () => p.loadMoreTaskNotes() });
  const quote = h('button', { class: 'btn', type: 'button', disabled: true, title: '引継ぎを依頼欄の末尾に引用（Alt+Shift+H）', onclick: () => p.quoteTaskHandoff() }, '引継ぎを引用 ', ...keycap('Alt+Shift+H'));
  const save = h('button', { class: 'link-btn', type: 'button', title: '入力文を報告に追記（Alt+Shift+N）。エージェントへは送信しません', onclick: () => p.appendTaskReport() }, '入力文を報告に追記 ', ...keycap('Alt+Shift+N'));
  const section = h('div', {}, summary, notice, retry, h('div', { class: 'row' }, quote, save), history, more);
  const reportSource = value => value.sourceSessionId ? `報告元（指定）: ${value.sourceSessionId}` : '報告元: 指定なし';
  const reportNodes = note => [
    h('div', { class: 'muted', text: `${fmtDate(note.at)} · ${reportSource(note)} · 報告` }),
    h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }, text: note.text }),
    note.proposedNextAction !== undefined ? h('p', { class: 'muted', text: note.proposedNextAction === null ? '次の行動の提案を解除' : `次の行動（提案）: ${note.proposedNextAction}` }) : null,
  ].filter(Boolean);
  const draw = () => {
    const current = p.taskCard || card, links = current.links || [];
    const signature = JSON.stringify([links.map(link => [link.id, link.title, link.status, link.statusKnown, link.last]), task?.revision, notes.map(note => note.id), nextCursor]);
    if (signature === renderedSignature) return;
    renderedSignature = signature;
    summary.replaceChildren(
      h('p', { class: 'muted', text: `現在地（担当会話の状態）: ${links.length ? links.map(link => `${link.title} · ${link.statusKnown === false ? '状態未確認' : STATUS_LABELS[link.status] || '状態未確認'}`).join(' / ') : '担当会話なし'}。仕事の完了確認とは別です。` }),
      task?.nextAction ? h('div', {}, h('strong', { text: '次の行動（提案）' }), h('p', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }, text: task.nextAction }), h('p', { class: 'muted', text: task.nextActionReport ? `${fmtDate(task.nextActionReport.at)} · ${reportSource(task.nextActionReport)}` : '報告者の提案' })) : h('p', { class: 'muted', text: task ? '次の行動の提案は未記入です' : '次の行動の提案は未取得です' }),
      ...links.filter(link => link.last).map(link => h('div', {}, h('strong', { text: `担当会話の最終返答 · ${link.title}` }), h('p', { class: 'muted', text: '発言時刻は未取得です。会話の更新時刻とは区別します。' }), h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }, text: link.last }))),
      ...(task?.latestNoteSummary ? [h('div', {}, h('strong', { text: '最新報告の抜粋' }), ...reportNodes(task.latestNoteSummary))] : []),
    );
    const details = h('details', { open: historyOpen, ontoggle: e => { historyOpen = e.currentTarget.open; } }, h('summary', { text: task ? `追記報告 ${task.totalNotes}件（表示 ${notes.length}件）` : '追記報告（未取得）' }),
      h('p', { class: 'muted', text: '報告元は指定されたIDです。認証済みの作者や人による承認・完了確認を表しません。' }),
      ...notes.map(note => h('div', { class: 'th-sec' }, ...reportNodes(note))));
    history.replaceChildren(details);
    more.hidden = !nextCursor; quote.disabled = !task;
  };
  const load = async (after) => {
    if (busy) return;
    busy = true; more.disabled = retry.disabled = true; retry.hidden = true;
    notice.textContent = '引継ぎを読み込み中…';
    try {
      const response = await bridge.callTool('canban_get_task', { taskId: p.id, ...(after ? { after } : {}) });
      task = response.task; notes = after ? [...notes, ...task.notes] : task.notes;
      nextCursor = task.nextCursor;
      p.taskHandoffRevision = task.revision;
      notice.textContent = task.totalNotes ? '報告と次の行動は提案です。承認や完了確認は行いません。' : '追記報告はまだありません。入力欄の文を報告として保存できます。';
      draw();
      return true;
    } catch (error) { notice.textContent = `引継ぎは未確認です: ${error.message}`; retry.hidden = false; return false; }
    finally { busy = false; more.disabled = retry.disabled = false; }
  };
  p.refreshTaskHandoff = async (force = false) => {
    if (task && !force && p.taskHandoffRevision === (p.taskCard?.handoff?.revision ?? 0)) { draw(); return true; }
    return load();
  };
  p.loadMoreTaskNotes = () => nextCursor && load(nextCursor);
  p.quoteTaskHandoff = () => {
    if (!task) return toast('引継ぎを取得してから引用してください', true);
    if (composer.draft.sending || composer.draft.launchRequest) return toast('進行中の開始依頼があります。新しい依頼に切り替えてから引用してください', true);
    appendTaskHandoffDraft(prompt, taskHandoffQuote(task, p.taskCard || card));
  };
  p.appendTaskReport = async () => {
    if (save.disabled || composer.draft.sending) return;
    const text = prompt.value;
    if (!text.trim() || text.length > 20000) { prompt.focus(); return toast('報告本文は1〜20000文字で入力してください', true); }
    const previous = composer.draft.handoffRequest;
    const request = previous?.text === text ? previous : { text, clientRequestId: crypto.randomUUID() };
    composer.draft.handoffRequest = request;
    save.disabled = true; notice.textContent = '報告を保存中…';
    try {
      await bridge.callTool('canban_append_task_note', { taskId: p.id, ...request });
      const readBack = await p.refreshTaskHandoff(true);
      notice.textContent = readBack ? '報告を保存しました。入力文は保持しています。エージェントへは送信していません。' : '報告は保存済みですが、引継ぎの再取得は未確認です。入力文を保持しています。';
    } catch (error) { notice.textContent = `報告を保存できませんでした: ${error.message}`; }
    finally { save.disabled = false; }
  };
  draw();
  p.refreshTaskHandoff(true);
  return section;
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
  p.taskCard = found.card;
  if (p.rendered && workspace.hasDrafts(p.el)) { paintTaskRelated(p, found.card); p.refreshTaskHandoff?.(); return; } // what is being typed stays
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
  const agentSel = h('select', { class: 'text-input', 'aria-label': 'AI App' },
    h('option', { value: 'codex', text: 'Codex' }),
    h('option', { value: 'claude', text: 'Claude Code' }),
    h('option', { value: 'gemini', text: 'Gemini CLI' }),
    h('option', { value: 'antigravity', text: 'Antigravity' }),
    h('option', { value: 'cursor', text: 'Cursor' }),
    h('option', { value: 'grok', text: 'Grok' }));
  agentSel.value = t.agent || 'codex';
  const hostSel = pickerButton({ title: 'マシン', value: t.hostId || 'local', stack: false,
    items: () => b.hosts.filter(x => !x.cloud).map((x) => ({ value: x.local ? 'local' : x.id, label: x.local ? 'このマシン' : `⌂ ${x.label}${x.enabled ? '' : '（読み取りオフ）'}`, keywords: x.alias || '' })),
    onChange: () => { fillFolders(); paintAccount(); composer.contextChanged(); } });
  // The account to start with: Claude Desktop switches to that account's signed-in profile.
  const accountFor = (agent) => [t.account, card.context?.account].find(k => k && k.split(':')[0] === agent) || '';
  const acctSel = pickerButton({ title: 'アカウント', popoverTitle: '開始するアカウント', value: accountFor(agentSel.value), stack: false, width: 340, placeholder: 'メールで検索',
    items: () => [{ value: '', label: `${agentLabel(agentSel.value)} · いまのログイン`, description: 'Desktop・CLI の現在のアカウントで開始' }, ...accountItems(agentSel.value)] });
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
  let launchTargets = null;
  const preset = h('select', { class: 'text-input', 'aria-label': '開始設定' }, h('option', { value: '__folder', text: 'フォルダを指定して開始' }));
  const presetInfo = h('span', { class: 'muted' });
  const nativeStart = h('button', { class: 'link-btn', type: 'button', text: '元アプリで開始', hidden: true, onclick: () => bridge.openLink('claude://code/new') });
  const presetValue = () => preset.value.startsWith('project:') ? launchTargets?.codex?.projects?.find(p => p.id === preset.value.slice(8)) : preset.value.startsWith('environment:') ? launchTargets?.claude?.environments?.find(e => e.id === preset.value.slice(12)) : null;
  const paintPreset = () => {
    const selected = presetValue();
    cwd.readOnly = !!selected; hostSel.disabled = !!selected;
    presetInfo.textContent = selected ? `${selected.cwd || selected.roots?.join('・') || ''} · ${selected.kind || selected.hostId || ''}${agentSel.value === 'claude' ? ' · 保存環境の完全適用は未確認です。元アプリで開始するかフォルダ指定を選んでください' : ''}` : '';
    nativeStart.hidden = !selected || agentSel.value !== 'claude';
    composer.contextChanged();
  };
  const fillPresets = () => {
    const previous = preset.value;
    preset.replaceChildren(h('option', { value: '__folder', text: 'フォルダを指定して開始' }), ...(agentSel.value === 'codex' ? launchTargets?.codex?.projects || [] : launchTargets?.claude?.environments || []).map(p => h('option', { value: `${agentSel.value === 'codex' ? 'project' : 'environment'}:${p.id}`, text: `${agentSel.value === 'codex' ? 'Codexのプロジェクト' : 'Claudeの環境'}: ${p.name} · ${p.hostId || p.kind}` })));
    if ([...preset.options].some(p => p.value === previous)) preset.value = previous;
    paintPreset();
  };
  preset.onchange = paintPreset;
  const prompt = h('textarea', { class: 'note', 'aria-label': '依頼文' });
  prompt.value = taskRequestText(card.title, card.description, card.note);
  prompt.defaultValue = prompt.value;
  const startButtons = [];
  // Codex-style: the round button starts on the default route; ⋯ picks the other route explicitly.
  const routeMenu = (anchor) => popover(anchor, '開始する場所', h('div', {},
    h('button', { class: 'menu-item', text: 'デスクトップアプリで開始', onclick: () => { closePopover(); start({ route: 'desktop' }); } }),
    h('button', { class: 'menu-item', text: 'ターミナルで開始', onclick: () => { closePopover(); start({ route: 'terminal' }); } }),
    composer.draft.launchRequest ? h('button', { class: 'menu-item', onclick: () => { closePopover(); p.newTaskRequest(); } }, '新しい依頼に切り替える ', ...keycap('Enter')) : null), { width: 220, placement: 'top' });
  startButtons.push(h('button', { class: 'cx-ico', type: 'button', title: '開始する場所を選ぶ', 'aria-label': '開始する場所を選ぶ', html: picon('more', 16), onclick: e => routeMenu(e.currentTarget) }),
    h('button', { class: 'send-round', type: 'button', title: `${routeLabel(b.settings.launch.route, { desktop: true })}で開始（⌘Enter）\n${shortcutHelp()}`, 'aria-label': '開始', html: picon('send', 15), onclick: e => start(optsFromEvent(e)) }));
  const importButton = h('button', { class: 'cx-ico', type: 'button', title: '説明・メモを依頼文に取り込む', 'aria-label': '説明・メモを依頼文に取り込む', html: picon('undo', 16), onclick: () => {
    if (prompt.value !== prompt.defaultValue && prompt.value.trim()) return toast('入力中の依頼文があります。先に内容を確認してください', true);
    prompt.value = taskRequestText(title.value, desc.value, memo.value);
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
  } });
  const launchNotice = h('span', { text: '画像は起動後にコピーし、アプリの入力欄で⌘Vを押してください' });
  const copyImages = h('button', { class: 'link-btn', type: 'button', text: '画像をコピー', hidden: true, onclick: async () => {
    const imageIds = composer.draft.launchResult?.imageIds || composer.draft.launchRequest?.imageIds || [];
    if (!imageIds.length) return;
    try {
      const response = await bridge.callTool('canban_copy_prompt_images', { imageIds });
      const result = response.result || response;
      launchNotice.textContent = result.state === 'copied' ? '画像をコピーしました。アプリの入力欄で⌘Vを押してください。' : result.reason || '画像をコピーできませんでした。';
    } catch (e) { toast(e.message, true); }
  } });
  const paintLaunchImages = () => {
    const r = composer.draft.launchResult, request = composer.draft.launchRequest;
    copyImages.hidden = r?.state !== 'opened' || request?.route !== 'desktop' || !(r.imageIds || request.imageIds)?.length;
    copyImages.disabled = !(r?.attachmentCopyAvailable ?? launchTargets?.desktopCapabilities?.clipboardImages);
  };
  const composer = promptComposer(prompt, { key: `start:${cardId}`, context: () => ({ agent: agentSel.value, hostId: hostSel.value, cwd: cwd.value.trim() }), submit: () => start(),
    placeholder: 'このタスクで何をしてほしいですか？', leading: [importButton], actions: startButtons, place: [agentSel, preset, presetInfo, nativeStart, hostSel, acctSel, cwd, dl],
    keys: [keyHint(['⌘', 'Enter'], '開始'), keyHint(['$'], 'スキル'), launchNotice, copyImages] });
  p.copyTaskImages = () => copyImages.click();
  p.canCopyTaskImages = () => !copyImages.hidden && !copyImages.disabled;
  p.newTaskRequest = async () => {
    if (composer.draft.sending) return;
    composer.setSending(true); startButtons.forEach(b => { b.disabled = true; });
    try {
      if (!await cancelTaskLaunchWait(composer.draft, (name, args) => bridge.callTool(name, args))) {
        launchNotice.textContent = '前回の開始を取り消せませんでした。元アプリと開始結果を確認してください。';
        return;
      }
      const previous = composer.draft;
      if (previous.launchResult?.state === 'uncertain' && previous.launchRequest?.route === 'desktop' && previous.launchResult?.route !== 'cloud' && previous.launchRequest?.runOn !== 'cloud') {
        await bridge.callTool('canban_acknowledge_desktop_launch', { clientRequestId: previous.launchRequest.clientRequestId });
      }
      beginNewTaskRequest(composer.draft);
      paintLaunchImages();
      launchNotice.textContent = '新しい依頼に切り替えました。前回の未確認結果は保持し、開始を押すと同じ文面でも新しい依頼になります。';
      prompt.focus();
    } catch (e) { toast(e.message, true); }
    finally { composer.setSending(false); startButtons.forEach(b => { b.disabled = false; }); }
  };
  p.hasTaskLaunchRequest = () => !!composer.draft.launchRequest;
  if (composer.draft.launchNewRequest) launchNotice.textContent = '新しい依頼に切り替えました。開始を押すと新しい依頼になります。';
  else if (composer.draft.launchResult && composer.draft.launchResult.state !== 'opened') launchNotice.textContent = '前回の開始結果は未確認です。同じ内容は結果を確認し、編集した内容は新しい依頼として開始します。';
  agentSel.addEventListener('change', fillPresets);
  bridge.callTool('canban_launch_targets', {}).then(targets => {
    launchTargets = targets; fillPresets(); paintLaunchImages();
    const savedRef = card.launchSelection?.selectedRefs?.[0];
    const saved = agentSel.value === 'codex' ? targets.codex?.projects?.find(p => sourceRefKey(p.sourceRef) === sourceRefKey(savedRef) && sourceRefKey(savedRef)) : targets.claude?.environments?.find(p => sourceRefKey(p.sourceRef) === sourceRefKey(savedRef) && sourceRefKey(savedRef));
    if (saved) { preset.value = `${agentSel.value === 'codex' ? 'project' : 'environment'}:${saved.id}`; paintPreset(); }
  }).catch(() => { presetInfo.textContent = '開始設定は未取得です。フォルダ指定は利用できます'; });
  cwd.addEventListener('change', () => composer.contextChanged());
  const start = async (opts = {}) => {
    if (composer.draft.sending) return;
    try {
      const payload = composer.payload();
      composer.setSending(true); startButtons.forEach(b => { b.disabled = true; });
      const selected = presetValue();
      const prefs = state.board.settings.launch;
      const args = taskLaunchLocation(selected, { taskId: cardId, agent: agentSel.value, hostId: hostSel.value, cwd: cwd.value.trim(), prompt: prompt.value, account: acctSel.value || null, ...payload, route: prefs.route, terminal: prefs.terminal, target: prefs.target, ...opts }, b.hosts);
      if (args.route === 'desktop' && args.agent === 'codex' && args.hostId !== 'local' && !launchTargets?.desktopCapabilities?.codexRemote) throw new Error('このDesktopでのリモート下書き表示は実機確認が必要です');
      if (args.route === 'desktop' && args.agent === 'claude') {
        const capabilities = await desktopAccounts.refresh();
        args.account ||= desktopAccounts.defaultAccount();
        const problem = desktopAccounts.problem(args.account);
        if (problem) throw new Error(problem);
        args.allowDesktopSwitch = !!capabilities?.accountSwitch && args.account !== capabilities.activeAccount;
      }
      const sameRequest = taskSessionRequest({ launchRequest: composer.draft.launchRequest }, args, () => null) === composer.draft.launchRequest;
      if (!sameRequest && composer.draft.launchRequest?.agent === 'claude' && composer.draft.launchRequest?.route === 'desktop' && composer.draft.launchResult?.state === 'uncertain') throw new Error('元アプリで前回の開始結果を確認し、「新しい依頼に切り替える」を選んでください');
      if (!sameRequest && !await cancelTaskLaunchWait(composer.draft, (name, args) => bridge.callTool(name, args))) throw new Error('前回の開始を取り消せませんでした。元アプリと開始結果を確認してください');
      const request = taskSessionRequest(composer.draft, args, () => crypto.randomUUID());
      const r = await bridge.callTool('canban_start_session', request);
      rememberTaskLaunchResult(composer.draft, r);
      paintLaunchImages();
      launchNotice.textContent = r.state === 'opened' ? '開始を依頼しました。適用結果は元アプリで確認してください。' : '前回の開始結果は未確認です。同じ内容は結果を確認し、編集した内容は新しい依頼として開始します。';
      toast(r.note || `${acctSel.value ? accountName(acctSel.value) : agentLabel(agentSel.value)} で開始しました。セッションが現れると自動で紐付きます`, !!r.note);
      if (r.state !== 'opened') return; // unresolved launch keeps the original request for idempotent retries
      if (request.route === 'desktop' && request.imageIds?.length) { load(); return; }
      delete composer.draft.launchRequest;
      if (prompt.value === request.prompt) { composer.clear(); prompt.value = ''; workspace.draftValues.set(prompt, ''); }
      load();
    } catch (e) {
      toast(e.message, true);
    } finally {
      composer.setSending(false); startButtons.forEach(b => { b.disabled = false; });
    }
  };

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
    status: { nodes: [h('div', { class: 'sub row' }, taskQuickAdd.button(), h('span', { class: 'badge task-badge', text: T.taskCard }), h('span', { class: 'row pane-status' }, h('span', { class: `sdot s-${card.status}` }), STATUS_LABELS[card.status]), h('span', { class: 'muted', text: 'リンクしたセッションの状態', title: 'タスクやGoalの完了とは別です' }))] },
    conv: { title: '説明', nodes: [desc], hint: '説明は Canban に保存します。新しいセッションの依頼文にも使います。' },
    handoff: { title: '仕事の引継ぎ', nodes: [taskHandoffSection(p, card, prompt, composer)] },
    memo: { title: 'メモ', nodes: [memo] },
    cardRelations: { title: '関連するカード', nodes: [cardRelationsSection(cardId)], extra: h('span', {}, ...keycap('Alt+Shift+R')) },
    related: { title: taskRelatedTitle(card), extra: taskLinkButton(cardId), nodes: taskRelatedNodes(card), hint: 'ホームのセッションをこのカードへドラッグして紐付けることもできます。' },
    send: { title: '新しいセッションを開始', extra: h('span', {}, ...keycap('i'), ' ', ...keycap('Alt+a')), nodes: [h('div', { class: 'send-box' }, composer.root)], hint: '開始したセッションは、AI App・マシン・フォルダ・依頼文が一致すると自動でこのカードに紐付きます。' },
    add: { nodes: [sourceDetails(card), taskQuickAdd.summary(card),
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

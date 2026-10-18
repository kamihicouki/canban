// One retained dialog outside all page rendering/inert regions.
const taskQuickAdd = {
  draft: null,
  button(className = 'btn') {
    return h('button', { type: 'button', class: `${className} quick-task-trigger`, text: '＋ タスク',
      title: 'タスクを追加（c）', 'aria-label': 'タスクを追加', onclick: () => this.open({ mode: 'task' }) });
  },
  async open(source = {}) {
    if (this.dialog?.open) { this.title.focus(); return; }
    if (!state.board) {
      try { state.board = await bridge.callTool('canban_get_board', { days: 30 }); }
      catch (error) { toast(error.message, true); return; }
    }
    closePopover();
    this.loadTargets();
    if (source.mode || source.listId || source.lane || source.slackMessage) this.mode = source.mode || 'task';
    const soloLane = state.lanes.find(l => l.key === state.soloLane);
    if (source.slackMessage) {
      const message = source.slackMessage;
      this.slackDrafts ||= new Map(); this.beforeSlackDraft = this.draft;
      const previous = this.slackDrafts.get(message.key);
      this.draft = previous?.title ? previous : { ...taskCreationDefaults(state.board, state.filters, { soloLane }),
        title: (message.text.trim().split('\n')[0] || message.files?.[0]?.name || 'Slackの依頼').slice(0,300), description: '',
        directory: slackUi.data.workspaces.find(w => w.id === message.team)?.channels.find(c => c.id === message.channel)?.directory || '__none',
        slackSource: message.key, slackPreview: message, clientRequestId: null };
      this.slackDrafts.set(message.key,this.draft); this.mount(); return;
    }
    // A dismissed draft keeps its actual destination; chips make that destination visible.
    if (!this.draft || this.draft.editCardId || (!this.draft.title && !this.draft.description)) {
      this.draft = { ...taskCreationDefaults(state.board, state.filters, { ...source, soloLane }), title: '', description: '', clientRequestId: null };
    }
    this.mount();
  },
  edit(card, list) {
    if (this.dialog?.open) return;
    this.creationDraft = this.draft;
    this.draft = { editCardId: card.id, card, listId: list.id, title: card.title, description: card.description || '',
      directory: card.directoryId || null, labels: [...card.labels], context: { ...card.context }, sourceContext: (card.sourceContext || []).map(x => ({ ...x, ref: { ...x.ref } })) };
    this.mount();
  },
  mount(focusSelector = null) {
    const draft = this.draft, edit = !!draft.editCardId;
    this.mode ||= 'task';
    this.sessionDraft ||= sessionCreationDefaults(state.board, draft.context);
    if (!this.dialog?.open) this.returnFocus = document.activeElement;
    this.dialog?.remove();
    const session = !edit && this.mode === 'session';
    const field = (label, control) => h('label', { class: 'creation-field' }, h('span', { class: 'creation-label', text: label }), control);
    const title = this.title = h('input', { class: 'text-input task-title', maxlength: 300, required: true,
      'aria-label': 'タスクのタイトル', placeholder: '例：リリースの準備をする', value: draft.title,
      oninput: e => { draft.title = e.target.value; } });
    const desc = h('textarea', { class: 'note task-description', rows: 4, maxlength: 20000, 'aria-label': '説明',
      placeholder: 'やることや、完了の目安を書いておけます', oninput: e => { draft.description = e.target.value; } });
    desc.value = draft.description;
    const feedback = this.feedback = h('div', { class: 'task-quick-feedback', role: 'status', hidden: true });
    const openAfter = h('input', { type: 'checkbox', checked: !!draft.openAfterCreate, onchange: e => { draft.openAfterCreate = e.target.checked; } });
    const form = this.form = h('form'), content = h('div', { class: 'creation-body' });
    if (edit) content.append(this.attributes(draft, state.board, false));
    else if (session) content.append(this.sessionFields(field));
    else content.append(field('タイトル', title), field('説明（任意）', desc),
      this.attributes(draft, state.board, true, 'placement'),
      h('details', { class: 'creation-details' }, h('summary', { text: '整理の詳細' }), this.attributes(draft, state.board, false, 'organization')),
      ...(draft.slackPreview ? [h('details', { class: 'creation-details' }, h('summary', { text: `Slack資料: ${draft.slackPreview.workspace} / ${draft.slackPreview.channelName}` }), h('p', { class: 'slack-body', text: draft.slackPreview.text }))] : []),
      h('label', { class: 'creation-open-after' }, openAfter, '作成後にカードを開く'));
    this.primary = h('button', { type: 'submit', class: 'btn-primary' },
      h('span', { text: edit ? '保存' : session ? this.sessionActionLabel() : 'タスクを作成' }), keycap('⌘/Ctrl', 'Enter'));
    this.newRequestButton = session ? h('button', { type: 'button', class: 'btn session-new-request', hidden: !this.sessionDraft.startRequest, text: '新しい依頼', onclick: async () => {
      const previous = this.sessionDraft;
      if (['waiting-for-quit','waiting-for-login','prepared','opening'].includes(previous.startResult?.state)) {
        await this.cancelSessionWait();
        if (previous.startResult?.state !== 'cancelled') return;
      }
      if (previous.startResult?.state === 'uncertain') {
        try { await bridge.callTool('canban_acknowledge_desktop_launch', { clientRequestId: previous.startRequest.clientRequestId }); }
        catch (e) { toast(e.message, true); return; }
      }
      if (previous.startResult?.state === 'opened') this.composer?.clear();
      this.sessionDraft = { ...previous, prompt: previous.startResult?.state === 'opened' ? '' : previous.prompt };
      delete this.sessionDraft.startRequest; delete this.sessionDraft.startResult;
      this.mount();
    } }) : null;
    form.append(content, feedback, h('div', { class: 'task-quick-actions' }, this.primary, this.newRequestButton,
      h('button', { type: 'button', class: 'btn creation-cancel', text: 'キャンセル', onclick: () => this.dialog.close() })));
    form.addEventListener('submit', e => { e.preventDefault(); this.submit(!!draft.openAfterCreate); });
    form.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.stopPropagation(); return; }
      if (e.isComposing || e.keyCode === 229) { if (e.key === 'Enter') e.preventDefault(); return; }
      if (e.key === 'Enter' && ((e.metaKey || e.ctrlKey) || e.target === title)) {
        e.preventDefault(); e.stopPropagation(); this.submit(!!draft.openAfterCreate);
      }
    });
    const dialog = this.dialog = h('dialog', { class: 'task-quick-dialog', 'aria-labelledby': 'task-quick-heading' },
      h('div', { class: 'task-quick-head' }, h('h2', { id: 'task-quick-heading', text: edit ? 'タスクの所属を変更' : '作成' }),
        h('button', { type: 'button', class: 'icon-btn', html: picon('close', 16), 'aria-label': '閉じる', onclick: () => dialog.close() }, keycap('Esc'))),
      edit || draft.slackSource ? null : h('div', { class: 'creation-modes', role: 'group', 'aria-label': '作成するもの' },
        [['task', 'タスクカード', 'あとで取り組む仕事'], ['session', '今すぐ始める', 'アプリで新しい依頼']].map(([mode, label, detail]) =>
          h('button', { type: 'button', 'data-create-mode': mode, 'aria-pressed': String(this.mode === mode), onclick: () => { this.mode = mode; this.mount(`[data-create-mode="${mode}"]`); } },
            h('span', { class: 'creation-mode-title', text: label }), h('span', { text: detail })))), form);
    dialog.addEventListener('click', e => {
      e.stopPropagation();
      if (e.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      if ((e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) && !draft.submitting && !this.sessionDraft.submitting) dialog.close();
    });
    dialog.addEventListener('cancel', e => { if (draft.submitting || this.sessionDraft.submitting) e.preventDefault(); });
    dialog.addEventListener('close', () => {
      if (draft.slackSource) { this.draft = this.beforeSlackDraft; this.beforeSlackDraft = null; }
      if (edit) this.draft = this.creationDraft;
      const focus = this.returnFocus;
      if (focus?.isConnected && !focus.closest('[inert]')) focus.focus({ preventScroll: true });
    });
    document.body.append(dialog);
    dialog.showModal();
    if (session) {
      this.title = form.querySelector('.session-prompt');
      this.paintSessionState();
      if (this.sessionDraft.startResult) this.showSessionFeedback(this.sessionDraft.startResult);
    }
    if (focusSelector) dialog.querySelector(focusSelector)?.focus();
    else if (edit) form.querySelector('select')?.focus(); else this.title.focus();
  },
  // The desktop apps' own lists (Claude の環境 / Codex のプロジェクト・クラウド環境), read fresh per open.
  async loadTargets() {
    await desktopAccounts.refresh().catch(() => null);
    if (this.sessionDraft && !this.sessionDraft.desktopAccount) this.sessionDraft.desktopAccount = desktopAccounts.defaultAccount();
    const account = this.sessionDraft?.agent === 'claude' && this.sessionDraft?.route === 'desktop' ? this.sessionDraft.desktopAccount : this.sessionDraft?.account;
    const pending = this.targetsPending = bridge.callTool('canban_launch_targets', account ? { account } : {}).catch(() => null);
    const targets = await pending;
    if (pending !== this.targetsPending) return;
    this.targets = targets || { claude: { environments: [] }, codex: { projects: [], cloudEnvironments: [] }, failed: true };
    if (this.dialog?.open && this.mode === 'session' && !this.draft?.editCardId && !this.sessionDraft?.startRequest && !this.sessionDraft?.submitting) {
      const active = document.activeElement, prompt = active?.classList.contains('session-prompt');
      const at = prompt ? [active.selectionStart, active.selectionEnd] : null;
      this.mount(prompt ? '.session-prompt' : active?.getAttribute('aria-label') ? `[aria-label="${active.getAttribute('aria-label')}"]` : null);
      if (at) this.form.querySelector('.session-prompt')?.setSelectionRange(...at);
    }
  },
  sessionActionLabel() {
    const draft = this.sessionDraft;
    if (draft.startRequest) return '開始結果を確認';
    if (sessionRunsInCloud(draft)) return 'クラウドで開始';
    if (draft.route === 'desktop' && draft.agent === 'claude') return draft.desktopAccount ? `${accountName(draft.desktopAccount)} で Claude を開く` : 'Desktop アカウントを選択';
    if (draft.route === 'terminal') return `${draft.agent === 'codex' ? 'Codex' : 'Claude Code'}を開始`;
    return `${draft.agent === 'codex' ? 'Codex' : 'Claude'}を開く`;
  },
  sessionFields(field) {
    const draft = this.sessionDraft, board = state.board;
    const choices = [['codex', 'desktop', 'Codex', 'デスクトップ'], ['claude', 'desktop', 'Claude', 'デスクトップのCode'],
      ['codex', 'terminal', 'Codex CLI', 'ターミナル'], ['claude', 'terminal', 'Claude Code', 'ターミナル']];
    const destinations = h('fieldset', { class: 'session-destination' }, h('legend', { class: 'creation-label', text: 'AI App・開く方法' }),
      h('div', { class: 'session-destinations' }, choices.map(([agent, route, label, detail]) => {
        const radio = h('input', { type: 'radio', name: 'session-destination', value: `${agent}-${route}`, checked: draft.agent === agent && draft.route === route,
          onchange: () => { draft.agent = agent; draft.route = route; if (!draft.account?.startsWith(`${agent}:`)) draft.account = null; this.mount('input[name="session-destination"]:checked'); } });
        return h('label', { class: 'session-choice' }, radio, h('span', {}, h('strong', { text: label }), h('span', { text: detail })));
      })));
    const targets = this.targets;
    applySessionTargetDefaults(draft, targets);
    draft.sourceRef = targets?.codex?.projects?.find(p => p.id === draft.projectId)?.sourceRef || null;
    const cwd = h('input', { class: 'text-input session-cwd', list: 'quick-start-folders', autocomplete: 'off', placeholder: '/Users/…/project',
      'aria-label': '作業フォルダ', value: draft.cwd, oninput: e => { draft.cwd = e.target.value; } });
    const folders = h('datalist', { id: 'quick-start-folders' }, (board.folders || []).filter(f => f.hostId === draft.hostId).map(f => h('option', { value: f.cwd, text: f.project || f.cwd })));
    const prompt = h('textarea', { class: 'note session-prompt', rows: 4, maxlength: 20000, required: true, 'aria-label': '依頼内容',
      placeholder: '何をしてほしいですか？', oninput: e => { draft.prompt = e.target.value; } });
    prompt.value = draft.prompt;
    // Same composer as session cards: images and $skills ride along with the start request. The form's ⌘Enter submits.
    const composer = this.composer = promptComposer(prompt, { key: 'quick-start', context: () => ({ agent: draft.agent, route: draft.route, hostId: draft.hostId, cwd: draft.cwd.trim() }),
      keys: [keyHint(['⌘', 'Enter'], '開始'), keyHint(['$'], 'スキル')] });
    const select = (label, value, choices, change) => {
      const el = h('select', { class: 'text-input', 'aria-label': label, onchange: e => change(e.target.value) }, choices.map(([v, text]) => h('option', { value: v, text })));
      if (!choices.some(([v]) => v === value)) el.append(h('option', { value, text: `${value}（選び直してください）` }));
      el.value = value;
      return field(label, el);
    };
    const hostLabel = id => id === 'local' ? 'このマシン' : board.hosts.find(x => x.id === id)?.label || id.replace(/^remote-ssh-discovered:/, '');
    // Desktop routes start where the app would: Claude の「環境」, Codex の「プロジェクト」と「実行場所」.
    const desktop = draft.route === 'desktop', loading = desktop && !targets;
    const place = [];
    if (desktop && draft.agent === 'claude') {
      place.push(select('開始設定（Claudeの環境）', loading ? '__loading' : draft.environmentId, [...(loading ? [['__loading', '読み込み中…']] : []),
        ...(targets?.claude.environments || []).map(e => [e.id, `${e.name}${e.kind === 'ssh' ? ` · ${e.sshLabel}` : ''}`]), ['__folder', 'フォルダを指定して開始']],
        value => { draft.environmentId = value; this.mount('select[aria-label="開始設定（Claudeの環境）"]'); }));
    }
    if (desktop && draft.agent === 'codex') {
      place.push(h('div', { class: 'creation-environment session-codex-place' },
        select('開始設定（Codexのプロジェクト）', loading ? '__loading' : draft.projectId, [...(loading ? [['__loading', '読み込み中…']] : []),
          ...(targets?.codex.projects || []).map(p => [p.id, p.hostId === 'local' ? p.name : `${p.name} · ${hostLabel(p.hostId)}`]), ['__none', 'プロジェクトなしで作業'], ['__folder', 'フォルダを指定して開始']],
          value => { draft.projectId = value; draft.cloudEnvironment = null; applySessionTargetDefaults(draft, targets); this.mount('select[aria-label="開始設定（Codexのプロジェクト）"]'); }),
        select('実行先', draft.runOn, [['local', 'このコンピューター'], ['cloud', 'クラウド']], value => { draft.runOn = value; applySessionTargetDefaults(draft, targets); this.mount('select[aria-label="実行先"]'); })));
      if (draft.runOn === 'cloud') place.push(select('クラウドの環境', draft.cloudEnvironment || '', [...(draft.cloudEnvironment ? [] : [['', '環境を選んでください']]),
        ...(targets?.codex.cloudEnvironments || []).map(e => [e.id, e.name])], value => { draft.cloudEnvironment = value || null; }));
    }
    const folder = sessionUsesFolder(draft);
    const environment = h('div', { class: 'creation-environment' },
      folder ? select('マシン', draft.hostId, board.hosts.filter(host => !host.cloud).map(host => [host.local ? 'local' : host.id, host.local ? 'このマシン' : host.label]), value => { draft.hostId = value; draft.cwd = ''; if (value !== 'local' && !desktop) draft.account = null; this.mount('select[aria-label="マシン"]'); }) : null,
      desktop && draft.agent === 'claude' ? null : select('アカウント', draft.account || '', [['', 'いまのログイン'], ...(desktop || draft.hostId === 'local' ? board.accounts?.accounts || [] : []).filter(a => a.key.startsWith(`${draft.agent}:`)).map(a => [a.key, accountName(a.key)])], value => { draft.account = value || null; draft.environmentId = null; this.targets = null; this.loadTargets(); this.mount('select[aria-label="アカウント"]'); }));
    if (draft.route === 'terminal') environment.append(
      select('ターミナル', draft.terminal, (board.terminals || []).map(t => [t.id, t.label]), value => { draft.terminal = value; this.mount('select[aria-label="ターミナル"]'); }),
      select('ターミナルの表示先', draft.target, Object.entries(TARGET_LABELS).filter(([id]) => (board.terminals.find(t => t.id === draft.terminal)?.targets || ['new-window']).includes(id)), value => { draft.target = value; }));
    const remoteCodex = draft.route === 'desktop' && draft.agent === 'codex' && !sessionRunsInCloud(draft) && sessionHostId(draft, targets) !== 'local';
    const cloud = sessionRunsInCloud(draft);
    const unsupportedEnvironment = desktop && draft.agent === 'claude' && !folder;
    const presetIssue = unsupportedSessionPreset(draft, targets);
    const note = presetIssue || (remoteCodex && !targets?.desktopCapabilities?.codexRemote ? 'このDesktopでのリモート下書き表示は未確認です。実機確認が完了してから開始できます。'
      : cloud ? 'Codex Cloud にタスクを送信して開始します。新規画面は開きません。結果は Codex の「クラウド」で確認してください。'
      : targets?.failed && desktop ? 'アプリの一覧を読み込めませんでした。フォルダを指定して開けます。'
      : desktop ? '新規画面に依頼を渡します。送信はアプリで行ってください。' : '選んだフォルダでCLIを起動し、依頼を開始します。');
    const chosenEnvironment = targets?.claude?.environments?.find(e => e.id === draft.environmentId);
    const chosenProject = targets?.codex?.projects?.find(p => p.id === draft.projectId);
    const execution = loading ? '未確認（開始設定を取得中）' : cloud ? 'Codex Cloud' : unsupportedEnvironment ? chosenEnvironment ? `${chosenEnvironment.kind === 'ssh' ? chosenEnvironment.sshLabel || chosenEnvironment.sshHost : 'このマシン'}（保存設定の指定・未適用）` : '未確認' : !folder && draft.projectId !== '__none' ? chosenProject ? hostLabel(chosenProject.hostId) : '未確認' : draft.hostId === 'local' || board.hosts.some(h => h.id === draft.hostId) ? hostLabel(sessionHostId(draft, targets)) : '未確認';
    return h('div', { class: 'session-fields' }, destinations,
      desktop && draft.agent === 'claude' ? desktopAccountPicker({ key: 'quick-start', value: draft.desktopAccount, onChange: (value, meta) => { draft.desktopAccount = value; if (meta?.initial) { this.paintSessionState(); return; } draft.environmentId = null; this.targets = null; this.loadTargets(); this.mount('.desktop-account-picker'); } }) : null,
      ...place, folder ? field(`作業フォルダ${desktop ? '（任意）' : ''}`, cwd) : null, folder ? folders : null,
      unsupportedEnvironment ? h('button', { type: 'button', class: 'link-btn', text: '元アプリで開始', onclick: () => bridge.openLink('claude://code/new') }) : null,
      h('div', { class: 'creation-field' }, h('span', { class: 'creation-label', text: '依頼内容' }), composer.root), h('p', { class: `creation-route-note${remoteCodex && !targets?.desktopCapabilities?.codexRemote ? ' error' : ''}`, text: `実行先（開始要求）: ${execution}。${note}` }),
      h('details', { class: 'creation-details', open: remoteCodex || draft.environmentOpen, ontoggle: e => { draft.environmentOpen = e.target.open; } }, h('summary', { text: `実行環境 · ${cloud ? 'クラウド' : hostLabel(sessionHostId(draft, targets))} · ${(desktop && draft.agent === 'claude' ? draft.desktopAccount : draft.account) ? accountName(desktop && draft.agent === 'claude' ? draft.desktopAccount : draft.account) : 'いまのログイン'}` }), environment));
  },
  paintSessionState() {
    const draft = this.sessionDraft;
    const locked = !!draft.startRequest;
    const loading = !locked && draft.route === 'desktop' && !this.targets;
    this.form.querySelectorAll('.session-fields input,.session-fields textarea,.session-fields select').forEach(el => {
      const text = el.tagName === 'TEXTAREA' || el.type === 'text';
      el.disabled = !!draft.submitting || (locked && !text);
      if (text) el.readOnly = locked;
    });
    this.form.querySelectorAll('.session-fields .cx-box button').forEach(el => { el.disabled = !!draft.submitting || locked; });
    const presetIssue = !locked && !loading && unsupportedSessionPreset(draft, this.targets);
    const unverifiedRemote = !loading && draft.route === 'desktop' && draft.agent === 'codex' && !sessionRunsInCloud(draft) && sessionHostId(draft, this.targets) !== 'local' && !this.targets?.desktopCapabilities?.codexRemote;
    const desktopIssue = !locked && draft.route === 'desktop' && draft.agent === 'claude' && desktopAccounts.problem(draft.desktopAccount);
    this.form.querySelectorAll('.desktop-account-picker').forEach(el => { el.disabled = locked || !!draft.submitting; });
    this.primary.disabled = !!desktopIssue || !!presetIssue || loading || unverifiedRemote || !!draft.submitting || ['opened','cancelled','uncertain','failed'].includes(draft.startResult?.state);
    this.primary.querySelector('span').textContent = loading ? '環境を読み込み中…' : presetIssue ? 'フォルダ指定を選んでください' : unverifiedRemote ? '実機確認が必要です' : draft.startResult?.state === 'opened' ? (draft.startResult.route === 'cloud' ? '送信しました' : '開きました') : this.sessionActionLabel();
    if (this.newRequestButton) this.newRequestButton.hidden = !locked;
  },
  showSessionFeedback(result, refreshError) {
    this.feedback.hidden = false;
    const waiting = ['waiting-for-quit', 'waiting-for-login', 'prepared', 'opening'].includes(result.state);
    this.feedback.classList.toggle('error', ['uncertain', 'failed'].includes(result.state));
    const message = [result.note || result.reason || (result.state === 'cancelled' ? '開始待機を取り消しました。本文と画像は保持しています。' : waiting ? 'Desktop の準備を待っています。' : 'ターミナルを開きました。実行状況はターミナルで確認してください。'),
      result.state === 'opened' ? `タスクカードは作成していません。${result.route === 'cloud' ? '' : 'セッションはアプリで作成された後にボードへ表示されます。'}` : '',
      refreshError ? '表示の更新に失敗しました。起動は繰り返していません。' : ''].filter(Boolean).join(' ');
    const imageIds = result.imageIds || this.sessionDraft.startRequest?.imageIds || [];
    const canCopy = result.attachmentCopyAvailable ?? this.targets?.desktopCapabilities?.clipboardImages;
    const copyMessage = result.imageCopy?.state === 'copied' ? '画像をコピーしました。アプリの入力欄で⌘Vを押してください。' : result.imageCopy?.reason;
    this.feedback.replaceChildren(...[h('span', { text: [message,copyMessage].filter(Boolean).join(' ') }),
      waiting ? h('button', { type: 'button', class: 'btn', text: '開始待機を取り消す', onclick: () => this.cancelSessionWait() }) : null,
      result.state === 'opened' && imageIds.length ? h('button', { type: 'button', class: 'btn', text: '画像をコピー', 'aria-label': '画像をコピー', disabled: !canCopy, onclick: () => this.copySessionImages() }, keycap('Enter')) : null,
      result.state === 'opened' && imageIds.length ? h('span', { class: 'muted', text: canCopy ? 'アプリで画像を貼り付けてください（⌘V）' : '画像の受取りは実機未確認です。アプリの通常の添付操作を使ってください。' }) : null,
    ].filter(Boolean));
    clearTimeout(this.startStatusTimer);
    const draft = this.sessionDraft, id = draft.startRequest?.clientRequestId;
    if (waiting && id && this.dialog?.open) this.startStatusTimer = setTimeout(async () => {
      if (this.sessionDraft !== draft || !this.dialog?.open || draft.startRequest?.clientRequestId !== id) return;
      try {
        const response = await bridge.callTool('canban_get_start_session', { clientRequestId: id });
        if (!response.result || this.sessionDraft !== draft) return;
        draft.startResult = response.result; this.showSessionFeedback(response.result); this.paintSessionState();
      } catch { this.feedback.textContent = '状態を確認できません。本文と画像は保持しています。「開始結果を確認」で再確認できます。'; }
    }, 2500);

  },
  async copySessionImages() {
    const draft = this.sessionDraft, imageIds = draft.startResult?.imageIds || draft.startRequest?.imageIds;
    if (draft.copyingImages || draft.startResult?.state !== 'opened' || !imageIds?.length) return;
    draft.copyingImages = true;
    try {
      const response = await bridge.callTool('canban_copy_prompt_images', { imageIds });
      draft.startResult = { ...draft.startResult, imageCopy: response.result || response };
      this.showSessionFeedback(draft.startResult);
    } catch (error) { this.feedback.textContent = `画像をコピーできませんでした。${error.message}`; }
    finally { draft.copyingImages = false; }
  },
  async cancelSessionWait() {
    const draft = this.sessionDraft;
    if (!draft.startRequest || draft.submitting) return;
    try {
      const response = await bridge.callTool('canban_cancel_start_session', { clientRequestId: draft.startRequest.clientRequestId });
      draft.startResult = response.result || response;
      this.showSessionFeedback(draft.startResult); this.paintSessionState();
    } catch (error) { this.feedback.textContent = `状態を確認できません。${error.message} 本文と画像は保持しています。`; }
  },
  async submitSession() {
    const draft = this.sessionDraft;
    if (draft.submitting || draft.startResult?.state === 'opened') return;
    const promptInput = this.form.querySelector('.session-prompt');
    if (promptInput && !draft.startRequest) draft.prompt = promptInput.value; // skill picks edit the text without an input event
    if (!draft.prompt.trim()) return promptInput?.focus();
    const presetIssue = !draft.startRequest && this.targets && unsupportedSessionPreset(draft, this.targets);
    if (presetIssue) {
      this.feedback.hidden = false; this.feedback.classList.add('error'); this.feedback.textContent = presetIssue;
      return;
    }
    if (!draft.startRequest && draft.route === 'desktop' && !this.targets) {
      this.feedback.hidden = false; this.feedback.classList.remove('error'); this.feedback.textContent = '環境を読み込み中です。取得後に開始できます。';
      return;
    }
    if (!draft.startRequest && sessionRunsInCloud(draft) && !draft.cloudEnvironment) {
      this.feedback.hidden = false; this.feedback.classList.add('error'); this.feedback.textContent = 'クラウドの環境を選んでください。';
      return this.form.querySelector('select[aria-label="クラウドの環境"]')?.focus();
    }
    if (!draft.startRequest && sessionUsesFolder(draft) && ((draft.cwd && !draft.cwd.startsWith('/')) || (!draft.cwd.trim() && draft.route === 'terminal'))) {
      this.feedback.hidden = false; this.feedback.classList.add('error'); this.feedback.textContent = '作業フォルダを絶対パスで指定してください。';
      return this.form.querySelector('.session-cwd').focus();
    }
    if (!draft.startRequest && draft.agent === 'codex' && draft.route === 'desktop' && !sessionRunsInCloud(draft) && sessionHostId(draft, this.targets) !== 'local' && !this.targets?.desktopCapabilities?.codexRemote) return;
    if (!draft.startRequest) {
      const capabilities = this.targets?.desktopCapabilities;
      if (draft.agent === 'claude' && draft.route === 'desktop' && desktopAccounts.problem(draft.desktopAccount)) return desktopAccounts.openSetup();
      draft.allowDesktopSwitch = draft.agent === 'claude' && draft.route === 'desktop' && !!capabilities?.accountSwitch && !!draft.desktopAccount && draft.desktopAccount !== capabilities.activeAccount;
      try { draft.attachments = this.composer.payload(); } catch (error) { this.feedback.hidden = false; this.feedback.classList.add('error'); this.feedback.textContent = error.message; return; }
    }
    this.busy(true);
    this.feedback.hidden = false; this.feedback.classList.remove('error'); this.feedback.textContent = sessionRunsInCloud(draft) ? 'Codex Cloud に送信しています…' : 'アプリを開いています…';
    live.ownActAt = Date.now();
    try {
      const saved = await saveQuickSessionDraft(draft, { callTool: (name, args) => bridge.callTool(name, args), refresh: () => load({ throwOnError: true }), newRequestId: () => crypto.randomUUID() });
      if (saved) this.showSessionFeedback(saved.result, saved.refreshError);
    } catch (error) {
      this.feedback.classList.add('error');
      this.feedback.textContent = `${error.message} 入力は保持しています。「開始結果を確認」は同じ依頼を照会します。新しい依頼を送る前にアプリを確認してください。`;
    } finally { this.busy(false); this.paintSessionState(); }
  },
  attributes(draft, board, showList, scope = 'all') {
    const area = h('div', { class: 'task-attributes' });
    const select = (label, current, choices, change) => {
      const input = h('select', { 'aria-label': label, onchange: e => change(e.target.value) },
        choices.map(([value, text]) => h('option', { value, text })));
      if (!choices.some(([value]) => value === current)) input.append(h('option', { value: current, text: current }));
      input.value = current;
      area.append(h('label', { class: 'task-attribute' }, h('span', { text: label }), input));
    };
    if (showList) select('列', draft.listId, board.lists.map(l => [l.id, l.title]), value => { draft.listId = value; });
    if (scope !== 'organization') select('カテゴリ', draft.directory || '', [['', '自動'], ['__none', 'カテゴリ無し'], ...board.directories.map(d => [d.id, d.name])], value => { draft.directory = value || null; });
    if (scope === 'placement') return area;
    const contextSelect = (key, label, choices, none) => {
      const value = Object.hasOwn(draft.context, key) ? draft.context[key] ?? '__none' : '__auto';
      select(label, value, [['__auto', '未指定'], ...(none ? [['__none', none]] : []), ...choices], next => {
        if (next === '__auto') delete draft.context[key]; else draft.context[key] = next === '__none' ? null : next;
      });
    };
    if (Object.hasOwn(draft.context, 'project')) contextSelect('project', '旧プロジェクト（保存済み）', [], 'なし');
    const sourceChoices = new Map([...(board.sourceFacets || []).map(x => [x.key, x]), ...(draft.sourceContext || []).map(x => [sourceRefKey(x.ref), { key: sourceRefKey(x.ref), ref: x.ref }])]);
    for (const facet of sourceChoices.values()) {
      const input = h('input', { type: 'checkbox', checked: (draft.sourceContext || []).some(x => sourceRefKey(x.ref) === facet.key), onchange: () => {
        draft.sourceContext = (draft.sourceContext || []).filter(x => sourceRefKey(x.ref) !== facet.key);
        if (input.checked) draft.sourceContext.push({ ref: facet.ref });
      } });
      area.append(h('label', { class: 'side-check', title: sourceFacetTitle(facet) }, input, `開始予定 · ${sourceFacetLabel(facet, board.sourceFacets)}`));
    }
    contextSelect('folder', '作業フォルダ', [...new Set((board.folders || []).map(f => f.name || f.cwd?.split('/').filter(Boolean).pop()).filter(Boolean))].map(name => [name, name]), 'フォルダなし');
    if (Object.hasOwn(draft.context, 'section')) contextSelect('section', '旧セクション（保存済み）', [], 'なし');
    contextSelect('agent', 'AI App', [['codex', 'Codex'], ['claude', 'Claude Code']], '指定なし');
    contextSelect('host', 'マシン', board.hosts.filter(host => !host.cloud).map(host => [host.local ? 'local' : host.id, host.local ? 'このマシン' : host.label]));
    contextSelect('account', 'アカウント', (board.accounts?.accounts || []).map(a => [a.key, accountName(a.key)]), 'アカウント不明');
    const summary = h('summary');
    const paintLabels = () => { summary.textContent = `ラベル: ${draft.labels.length ? draft.labels.map(id => board.labels.find(l => l.id === id)?.name || id).join('・') : 'なし'}`; };
    paintLabels();
    area.append(h('details', { class: 'task-label-choices' }, summary, board.labels.map(label => {
      const checkbox = h('input', { type: 'checkbox', checked: draft.labels.includes(label.id), onchange: e => {
        draft.labels = e.target.checked ? [...new Set([...draft.labels, label.id])] : draft.labels.filter(id => id !== label.id);
        paintLabels();
      } });
      return h('label', {}, checkbox, label.name);
    })));
    return area;
  },
  busy(value) {
    this.dialog.querySelectorAll('input,textarea,select,button').forEach(el => { el.disabled = value; });
    this.dialog.querySelector('.task-quick-head button').disabled = value;
    this.form.setAttribute('aria-busy', String(value));
  },
  async submit(openResult = false) {
    if (!this.draft?.editCardId && this.mode === 'session') return this.submitSession();
    const draft = this.draft;
    if (!draft || draft.submitting) return;
    if (!draft.title.trim()) return this.title.focus();
    this.busy(true);
    this.feedback.hidden = false;
    this.feedback.classList.remove('error');
    this.feedback.textContent = draft.editCardId ? '保存しています…' : '作成しています…';
    live.ownActAt = Date.now();
    try {
      if (draft.editCardId) {
        draft.submitting = true;
        const response = await bridge.callTool('canban_update_task', { cardId: draft.editCardId, context: draft.context, sourceContext: draft.sourceContext, directory: draft.directory, labels: draft.labels });
        const result = response.result || response;
        Object.assign(draft.card, { context: result.context, sourceContext: result.sourceContext || [], directoryId: result.directoryId || null, labels: result.labels,
          directory: state.board.directories.find(d => d.id === result.directoryId) || null });
        panes.find(p => p.id === draft.editCardId)?.el.querySelector('.task-context-summary')?.replaceWith(this.summary(draft.card));
        draft.submitting = false;
        this.dialog.close();
        load().catch(error => toast(`所属は保存しました。表示を更新できませんでした: ${error.message}`, true));
        return;
      }
      const saved = await saveQuickTaskDraft(draft, { callTool: (name, args) => bridge.callTool(name, args),
        refresh: () => load({ throwOnError: true }), newRequestId: () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() :
          [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('') });
      if (!saved) return;
      if (draft.slackSource) slackUi.refresh();
      this.title.value = draft.title;
      const message = saved.matches ? `「${saved.result.title}」を作成しました。` : `前回の「${saved.result.title}」を確認しました。現在の入力は保持しています。`;
      const reasons = this.hiddenReasons(saved.result);
      const warning = [reasons.length ? `現在の表示条件から外れています（${reasons.join('・')}）。` : '',
        saved.refreshError ? '保存は完了しました。表示の更新に失敗しました。' : ''].filter(Boolean).join(' ');
      this.feedback.replaceChildren(h('span', { text: `${message} ${warning}` }), h('button', { type: 'button', class: 'link-btn', text: 'カードを開く', onclick: () => this.openResult(saved.result) }));
      if (openResult) this.openResult(saved.result);
    } catch (error) {
      this.feedback.classList.add('error');
      this.feedback.textContent = `${error.message} 入力は保持しています。同じ内容で再試行できます。`;
    } finally {
      draft.submitting = false;
      this.busy(false);
      if (this.dialog.open) (draft.editCardId ? this.form.querySelector('select') : this.title)?.focus();
    }
  },
  projected(result) {
    const b = state.board, context = result.context || {};
    return { ...result, id: result.cardId, directory: b.directories.find(d => d.id === result.directoryId) || null,
      project: context.project || null, folder: context.folder || null, agent: context.agent || context.account?.split(':')[0] || null,
      host: context.host && context.host !== 'local' ? { id: context.host, label: b.hosts.find(h => h.id === context.host)?.label || context.host } : null,
      account: context.account || null, codexSection: context.section ? { id: context.section } : null, labels: result.labels || [] };
  },
  hiddenReasons(result) {
    const f = state.filters, card = this.projected(result), reasons = [];
    if ((f.sourceFilters || []).some(f => !cardSourceRelations(card).some(r => sourceRefKey(r.ref) === sourceRefKey(f.ref) && (!f.relation || r.type === f.relation)))) reasons.push('元アプリ');
    if (f.status && f.status !== 'idle') reasons.push('実行状態');
    if (f.pinnedOnly) reasons.push('ピン留め');
    if (f.dotScope === 'only') reasons.push('dot');
    if (f.directory && (f.directory === '__none' ? !!card.directory : card.directory?.id !== f.directory)) reasons.push('カテゴリ');
    if (f.label && (f.label === '__none' ? card.labels.length : !card.labels.includes(f.label))) reasons.push('ラベル');
    for (const [key, label] of [['project', 'プロジェクト'], ['folder', 'フォルダ'], ['section', 'セクション'], ['agent', 'AI App'], ['host', 'マシン'], ['account', 'アカウント']]) {
      if (!f[key] || (key === 'agent' && f[key] === 'all')) continue;
      const value = key === 'host' ? card.host?.id || 'local' : key === 'section' ? card.codexSection?.id : card[key];
      if (f[key] === '__none' ? !!value : value !== f[key]) reasons.push(label);
    }
    const hay = [card.title, card.description, card.directory?.name, ...Object.values(card.context), ...card.labels.map(id => state.board.labels.find(l => l.id === id)?.name)].filter(Boolean).join('\n').toLowerCase();
    if (f.q && !hay.includes(f.q.toLowerCase().trim())) reasons.push('検索');
    if (state.soloLane && laneIdForCard(card, f.swimlane) !== state.soloLane) reasons.push('単独表示のレーン');
    return reasons;
  },
  openResult(result) {
    if (this.dialog?.open) this.dialog.close();
    openCard(result.cardId);
  },
  summary(card) {
    const names = { project: '旧プロジェクト', folder: '作業フォルダ', section: '旧セクション', agent: 'AI App', host: 'マシン', account: 'アカウント' };
    return h('div', { class: 'task-context-summary' }, Object.entries(card.context || {}).map(([key, value]) => {
      let text = value || 'なし';
      if (key === 'agent' && value) text = value === 'codex' ? 'Codex' : 'Claude Code';
      if (key === 'host' && value) text = value === 'local' ? 'このマシン' : state.board.hosts.find(h => h.id === value)?.label || value;
      if (key === 'account' && value) text = accountName(value);
      if (key === 'section' && value) text = state.board.codexSections?.find(s => s.id === value)?.name || value;
      return h('span', { text: `${names[key]}: ${text}` });
    }));
  },
};

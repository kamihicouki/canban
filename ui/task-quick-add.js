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
      directory: card.directoryId || null, labels: [...card.labels], context: { ...card.context } };
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
    const form = this.form = h('form');
    if (edit) form.append(this.attributes(draft, state.board, false));
    else if (session) form.append(this.sessionFields(field));
    else form.append(field('タイトル', title), field('説明（任意）', desc),
      this.attributes(draft, state.board, true, 'placement'),
      h('details', { class: 'creation-details' }, h('summary', { text: '整理の詳細' }), this.attributes(draft, state.board, false, 'organization')),
      ...(draft.slackPreview ? [h('details', { class: 'creation-details' }, h('summary', { text: `Slack資料: ${draft.slackPreview.workspace} / ${draft.slackPreview.channelName}` }), h('p', { class: 'slack-body', text: draft.slackPreview.text }))] : []),
      h('label', { class: 'creation-open-after' }, openAfter, '作成後にカードを開く'));
    this.primary = h('button', { type: 'submit', class: 'btn-primary' },
      h('span', { text: edit ? '保存' : session ? this.sessionActionLabel() : 'タスクを作成' }), keycap('⌘/Ctrl', 'Enter'));
    this.newRequestButton = session ? h('button', { type: 'button', class: 'btn session-new-request', hidden: !this.sessionDraft.startRequest, text: '新しい依頼', onclick: () => {
      const previous = this.sessionDraft;
      if (previous.startResult?.state === 'opened') this.composer?.clear();
      this.sessionDraft = { ...previous, prompt: previous.startResult?.state === 'opened' ? '' : previous.prompt };
      delete this.sessionDraft.startRequest; delete this.sessionDraft.startResult;
      this.mount();
    } }) : null;
    form.append(feedback, h('div', { class: 'task-quick-actions' }, this.primary, this.newRequestButton,
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
    const pending = this.targetsPending = bridge.callTool('canban_launch_targets', {}).catch(() => null);
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
    if (draft.route === 'terminal') return `${draft.agent === 'codex' ? 'Codex' : 'Claude Code'}を開始`;
    return `${draft.agent === 'codex' ? 'Codex' : 'Claude'}を開く`;
  },
  sessionFields(field) {
    const draft = this.sessionDraft, board = state.board;
    const choices = [['codex', 'desktop', 'Codex', 'デスクトップ'], ['claude', 'desktop', 'Claude', 'デスクトップのCode'],
      ['codex', 'terminal', 'Codex CLI', 'ターミナル'], ['claude', 'terminal', 'Claude Code', 'ターミナル']];
    const destinations = h('fieldset', { class: 'session-destination' }, h('legend', { class: 'creation-label', text: '開始先' }),
      h('div', { class: 'session-destinations' }, choices.map(([agent, route, label, detail]) => {
        const radio = h('input', { type: 'radio', name: 'session-destination', value: `${agent}-${route}`, checked: draft.agent === agent && draft.route === route,
          onchange: () => { draft.agent = agent; draft.route = route; if (!draft.account?.startsWith(`${agent}:`)) draft.account = null; this.mount('input[name="session-destination"]:checked'); } });
        return h('label', { class: 'session-choice' }, radio, h('span', {}, h('strong', { text: label }), h('span', { text: detail })));
      })));
    const targets = this.targets;
    applySessionTargetDefaults(draft, targets);
    const cwd = h('input', { class: 'text-input session-cwd', list: 'quick-start-folders', autocomplete: 'off', placeholder: '/Users/…/project',
      'aria-label': '作業フォルダ', value: draft.cwd, oninput: e => { draft.cwd = e.target.value; } });
    const folders = h('datalist', { id: 'quick-start-folders' }, (board.folders || []).filter(f => f.hostId === draft.hostId).map(f => h('option', { value: f.cwd, text: f.project || f.cwd })));
    const prompt = h('textarea', { class: 'note session-prompt', rows: 4, maxlength: 20000, required: true, 'aria-label': '依頼内容',
      placeholder: '何をしてほしいですか？', oninput: e => { draft.prompt = e.target.value; } });
    prompt.value = draft.prompt;
    // Same composer as session cards: images and $skills ride along with the start request. The form's ⌘Enter submits.
    const composer = this.composer = promptComposer(prompt, { key: 'quick-start', context: () => ({ agent: draft.agent, hostId: draft.hostId, cwd: draft.cwd.trim() }),
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
      place.push(select('環境', loading ? '__loading' : draft.environmentId, [...(loading ? [['__loading', '読み込み中…']] : []),
        ...(targets?.claude.environments || []).map(e => [e.id, `${e.name}${e.kind === 'ssh' ? ` · ${e.sshLabel}` : ''}`]), ['__folder', 'フォルダを指定']],
        value => { draft.environmentId = value; this.mount('select[aria-label="環境"]'); }));
    }
    if (desktop && draft.agent === 'codex') {
      place.push(h('div', { class: 'creation-environment session-codex-place' },
        select('プロジェクト', loading ? '__loading' : draft.projectId, [...(loading ? [['__loading', '読み込み中…']] : []),
          ...(targets?.codex.projects || []).map(p => [p.id, p.hostId === 'local' ? p.name : `${p.name} · ${hostLabel(p.hostId)}`]), ['__none', 'プロジェクトなしで作業'], ['__folder', 'フォルダを指定']],
          value => { draft.projectId = value; draft.cloudEnvironment = null; applySessionTargetDefaults(draft, targets); this.mount('select[aria-label="プロジェクト"]'); }),
        select('実行場所', draft.runOn, [['local', 'このコンピューター'], ['cloud', 'クラウド']], value => { draft.runOn = value; applySessionTargetDefaults(draft, targets); this.mount('select[aria-label="実行場所"]'); })));
      if (draft.runOn === 'cloud') place.push(select('クラウドの環境', draft.cloudEnvironment || '', [...(draft.cloudEnvironment ? [] : [['', '環境を選んでください']]),
        ...(targets?.codex.cloudEnvironments || []).map(e => [e.id, e.name])], value => { draft.cloudEnvironment = value || null; }));
    }
    const folder = sessionUsesFolder(draft);
    const environment = h('div', { class: 'creation-environment' },
      folder ? select('マシン', draft.hostId, board.hosts.filter(host => !host.cloud).map(host => [host.local ? 'local' : host.id, host.local ? 'このマシン' : host.label]), value => { draft.hostId = value; draft.cwd = ''; if (value !== 'local') draft.account = null; this.mount('select[aria-label="マシン"]'); }) : null,
      select('アカウント', draft.account || '', [['', 'いまのログイン'], ...(draft.hostId === 'local' ? board.accounts?.accounts || [] : []).filter(a => a.key.startsWith(`${draft.agent}:`)).map(a => [a.key, accountName(a.key)])], value => { draft.account = value || null; }));
    if (draft.route === 'terminal') environment.append(
      select('ターミナル', draft.terminal, (board.terminals || []).map(t => [t.id, t.label]), value => { draft.terminal = value; this.mount('select[aria-label="ターミナル"]'); }),
      select('開く場所', draft.target, Object.entries(TARGET_LABELS).filter(([id]) => (board.terminals.find(t => t.id === draft.terminal)?.targets || ['new-window']).includes(id)), value => { draft.target = value; }));
    const remoteCodex = draft.route === 'desktop' && draft.agent === 'codex' && !sessionRunsInCloud(draft) && sessionHostId(draft, targets) !== 'local';
    const cloud = sessionRunsInCloud(draft);
    const note = remoteCodex ? 'Codexの新規画面にはリモート接続先を渡せません。「Codex CLI」を選ぶか、実行場所をクラウドにしてください。'
      : cloud ? 'Codex Cloud にタスクを送信して開始します。新規画面は開きません。結果は Codex の「クラウド」で確認してください。'
      : targets?.failed && desktop ? 'アプリの一覧を読み込めませんでした。フォルダを指定して開けます。'
      : desktop ? '新規画面に依頼を渡します。送信はアプリで行ってください。' : '選んだフォルダでCLIを起動し、依頼を開始します。';
    return h('div', { class: 'session-fields' }, destinations, ...place, folder ? field(`作業フォルダ${desktop ? '（任意）' : ''}`, cwd) : null, folder ? folders : null,
      h('div', { class: 'creation-field' }, h('span', { class: 'creation-label', text: '依頼内容' }), composer.root), h('p', { class: `creation-route-note${remoteCodex ? ' error' : ''}`, text: note }),
      h('details', { class: 'creation-details', open: remoteCodex || draft.environmentOpen, ontoggle: e => { draft.environmentOpen = e.target.open; } }, h('summary', { text: `実行環境 · ${cloud ? 'クラウド' : hostLabel(sessionHostId(draft, targets))} · ${draft.account ? accountName(draft.account) : 'いまのログイン'}` }), environment));
  },
  paintSessionState() {
    const draft = this.sessionDraft;
    const locked = !!draft.startRequest;
    this.form.querySelectorAll('.session-fields input,.session-fields textarea,.session-fields select').forEach(el => {
      const text = el.tagName === 'TEXTAREA' || el.type === 'text';
      el.disabled = !!draft.submitting || (locked && !text);
      if (text) el.readOnly = locked;
    });
    this.form.querySelectorAll('.session-fields .cx-box button').forEach(el => { el.disabled = !!draft.submitting || locked; });
    this.primary.disabled = !!draft.submitting || draft.startResult?.state === 'opened';
    this.primary.querySelector('span').textContent = draft.startResult?.state === 'opened' ? (draft.startResult.route === 'cloud' ? '送信しました' : '開きました') : this.sessionActionLabel();
    if (this.newRequestButton) this.newRequestButton.hidden = !locked;
  },
  showSessionFeedback(result, refreshError) {
    this.feedback.hidden = false;
    this.feedback.classList.toggle('error', result.state !== 'opened');
    this.feedback.textContent = [result.note || 'ターミナルを開きました。実行状況はターミナルで確認してください。',
      result.state === 'opened' ? `タスクカードは作成していません。${result.route === 'cloud' ? '' : 'セッションはアプリで作成された後にボードへ表示されます。'}` : '',
      refreshError ? '表示の更新に失敗しました。起動は繰り返していません。' : ''].filter(Boolean).join(' ');
  },
  async submitSession() {
    const draft = this.sessionDraft;
    if (draft.submitting || draft.startResult?.state === 'opened') return;
    const promptInput = this.form.querySelector('.session-prompt');
    if (promptInput && !draft.startRequest) draft.prompt = promptInput.value; // skill picks edit the text without an input event
    if (!draft.prompt.trim()) return promptInput?.focus();
    if (!draft.startRequest && draft.route === 'desktop' && !this.targets) return;
    if (!draft.startRequest && sessionRunsInCloud(draft) && !draft.cloudEnvironment) {
      this.feedback.hidden = false; this.feedback.classList.add('error'); this.feedback.textContent = 'クラウドの環境を選んでください。';
      return this.form.querySelector('select[aria-label="クラウドの環境"]')?.focus();
    }
    if (!draft.startRequest && sessionUsesFolder(draft) && ((draft.cwd && !draft.cwd.startsWith('/')) || (!draft.cwd.trim() && draft.route === 'terminal'))) {
      this.feedback.hidden = false; this.feedback.classList.add('error'); this.feedback.textContent = '作業フォルダを絶対パスで指定してください。';
      return this.form.querySelector('.session-cwd').focus();
    }
    if (!draft.startRequest && draft.agent === 'codex' && draft.route === 'desktop' && !sessionRunsInCloud(draft) && sessionHostId(draft, this.targets) !== 'local') return;
    if (!draft.startRequest) {
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
    contextSelect('project', 'プロジェクト', (board.projects || []).map(p => [p.name, p.name]), 'プロジェクトなし');
    contextSelect('folder', 'フォルダ', [...new Set((board.folders || []).map(f => f.name || f.cwd?.split('/').filter(Boolean).pop()).filter(Boolean))].map(name => [name, name]), 'フォルダなし');
    contextSelect('section', 'セクション', (board.codexSections || []).map(s => [s.id, s.name]), 'セクションなし');
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
        const response = await bridge.callTool('canban_update_task', { cardId: draft.editCardId, context: draft.context, directory: draft.directory, labels: draft.labels });
        const result = response.result || response;
        Object.assign(draft.card, { context: result.context, directoryId: result.directoryId || null, labels: result.labels,
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
    const names = { project: 'プロジェクト', folder: 'フォルダ', section: 'セクション', agent: 'AI App', host: 'マシン', account: 'アカウント' };
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

// One retained dialog outside all page rendering/inert regions.
const taskQuickAdd = {
  draft: null,
  button(className = 'btn') {
    return h('button', { type: 'button', class: `${className} quick-task-trigger`, text: '＋ タスク',
      title: 'タスクを追加（c）', 'aria-label': 'タスクを追加', onclick: () => this.open() });
  },
  async open(source = {}) {
    if (this.dialog?.open) { this.title.focus(); return; }
    if (!state.board) {
      try { state.board = await bridge.callTool('canban_get_board', { days: 30 }); }
      catch (error) { toast(error.message, true); return; }
    }
    closePopover();
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
    if (!this.draft || this.draft.editCardId || !this.draft.title) {
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
  mount() {
    const draft = this.draft, edit = !!draft.editCardId;
    this.dialog?.remove();
    this.returnFocus = document.activeElement;
    const title = this.title = h('input', { class: 'text-input task-title', maxlength: 300,
      'aria-label': 'タスクのタイトル', placeholder: 'タスクのタイトル（Enterで作成）', value: draft.title,
      oninput: e => { draft.title = e.target.value; } });
    title.hidden = edit;
    const desc = h('textarea', { class: 'note', rows: 3, maxlength: 20000, 'aria-label': '説明',
      placeholder: '説明（任意）', oninput: e => { draft.description = e.target.value; } });
    desc.value = draft.description;
    const feedback = this.feedback = h('div', { class: 'task-quick-feedback', role: 'status', hidden: true });
    const form = h('form', {}, title, this.attributes(draft, state.board, !edit),
      draft.slackPreview ? h('details', {}, h('summary', { text: `Slack資料: ${draft.slackPreview.workspace} / ${draft.slackPreview.channelName}` }), h('p', { class: 'slack-body', text: draft.slackPreview.text })) : null,
      edit ? null : h('details', {}, h('summary', { text: '詳細' }), desc),
      h('div', { class: 'task-quick-actions' },
        h('button', { type: 'submit', class: 'btn-primary', text: edit ? '保存' : '作成' }),
        edit ? null : h('button', { type: 'button', class: 'btn', text: '作成して開く', onclick: () => this.submit(true) }),
        h('button', { type: 'button', class: 'btn', text: '閉じる', onclick: () => this.dialog.close() })), feedback);
    form.addEventListener('submit', e => { e.preventDefault(); this.submit(); });
    form.addEventListener('keydown', e => {
      if (e.isComposing || e.keyCode === 229) { if (e.key === 'Enter') e.preventDefault(); return; }
      if (e.key === 'Enter' && e.target === title) { e.preventDefault(); this.submit(); }
    });
    this.form = form;
    const dialog = this.dialog = h('dialog', { class: 'task-quick-dialog', 'aria-labelledby': 'task-quick-heading' },
      h('div', { class: 'task-quick-head' }, h('h2', { id: 'task-quick-heading', text: edit ? 'タスクの所属を変更' : 'タスクを追加' }),
        h('button', { type: 'button', class: 'icon-btn', text: '✕', 'aria-label': '閉じる', onclick: () => dialog.close() })), form);
    dialog.addEventListener('cancel', e => { if (draft.submitting) e.preventDefault(); });
    dialog.addEventListener('close', () => {
      if (draft.slackSource) { this.draft = this.beforeSlackDraft; this.beforeSlackDraft = null; }
      if (edit) this.draft = this.creationDraft;
      const focus = this.returnFocus;
      if (focus?.isConnected && !focus.closest('[inert]')) focus.focus({ preventScroll: true });
    });
    document.body.append(dialog);
    dialog.showModal();
    if (edit) form.querySelector('select')?.focus(); else title.focus();
  },
  attributes(draft, board, showList) {
    const area = h('div', { class: 'task-attributes' });
    const select = (label, current, choices, change) => {
      const input = h('select', { 'aria-label': label, onchange: e => change(e.target.value) },
        choices.map(([value, text]) => h('option', { value, text })));
      if (!choices.some(([value]) => value === current)) input.append(h('option', { value: current, text: current }));
      input.value = current;
      area.append(h('label', { class: 'task-attribute' }, h('span', { text: label }), input));
    };
    if (showList) select('列', draft.listId, board.lists.map(l => [l.id, l.title]), value => { draft.listId = value; });
    select('カテゴリ', draft.directory || '', [['', '自動'], ['__none', 'カテゴリ無し'], ...board.directories.map(d => [d.id, d.name])], value => { draft.directory = value || null; });
    const contextSelect = (key, label, choices, none) => {
      const value = Object.hasOwn(draft.context, key) ? draft.context[key] ?? '__none' : '__auto';
      select(label, value, [['__auto', '未指定'], ...(none ? [['__none', none]] : []), ...choices], next => {
        if (next === '__auto') delete draft.context[key]; else draft.context[key] = next === '__none' ? null : next;
      });
    };
    contextSelect('project', 'プロジェクト', (board.projects || []).map(p => [p.name, p.name]), 'プロジェクトなし');
    contextSelect('folder', 'フォルダ', (board.folders || []).map(f => [f.name, f.name]), 'フォルダなし');
    contextSelect('section', 'セクション', (board.codexSections || []).map(s => [s.id, s.name]), 'セクションなし');
    contextSelect('agent', 'AI App', [['codex', 'Codex'], ['claude', 'Claude Code']], '指定なし');
    contextSelect('host', 'マシン', board.hosts.map(host => [host.local ? 'local' : host.id, host.local ? 'このマシン' : host.label]));
    contextSelect('account', 'アカウント', (board.accounts?.accounts || []).map(a => [a.key, a.label]), 'アカウント不明');
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
    this.form.querySelectorAll('input,textarea,select,button').forEach(el => { el.disabled = value; });
    this.dialog.querySelector('.task-quick-head button').disabled = value;
    this.form.setAttribute('aria-busy', String(value));
  },
  async submit(openResult = false) {
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
      this.showResult(saved.result, `${message} ${warning}`);
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
  showResult(result, message) {
    this.notice?.remove();
    this.notice = h('div', { class: 'task-result-notice', role: 'status' }, h('span', { text: message }),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'link-btn', text: 'カードを開く', onclick: () => this.openResult(result) }),
        h('button', { type: 'button', class: 'link-btn', text: '通知を閉じる', onclick: () => this.notice.remove() })));
    document.body.append(this.notice);
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
      if (key === 'account' && value) text = accountLabel(value);
      if (key === 'section' && value) text = state.board.codexSections?.find(s => s.id === value)?.name || value;
      return h('span', { text: `${names[key]}: ${text}` });
    }));
  },
};

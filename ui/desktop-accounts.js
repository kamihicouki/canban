// Desktop choices never use the CLI execution picker or its saved settings.
const desktopAccounts = {
  view: null, selections: new Map(), resumes: new Map(),
  async refresh() {
    if (!this.pending) this.pending = bridge.callTool('canban_desktop_accounts', {}).then(r => {
      this.view = r.result || r;
      for (const result of this.view.pendingLaunches || []) if (result.operation === 'resume' && !this.resumes.has(result.cardId)) {
        this.selections.set(result.cardId, result.account);
        this.resumes.set(result.cardId, { input: { cardId: result.cardId, route: 'desktop', desktopAccount: result.account, clientRequestId: result.clientRequestId, allowDesktopSwitch: true }, result });
      }
      return this.view;
    }).finally(() => { this.pending = null; });
    return this.pending;
  },
  defaultAccount() {
    const v = this.view;
    return v?.profiles?.some(p => p.account === v.lastAccount) ? v.lastAccount : v?.activeAccount || v?.profiles?.find(p => p.active)?.account || null;
  },
  selected(key) { return this.selections.get(key) || this.defaultAccount(); },
  problem(account) {
    if (!this.view) return 'Desktop の接続を確認してください';
    if (!account || !this.view.profiles?.some(p => p.account === account)) return '未接続です。Desktop の初回接続へ進んでください';
    if (this.view.pending?.active) return 'Desktop の初回接続を完了または取り消してください';
    if (account !== this.view.activeAccount && !this.view.accountSwitch) return '認証保持の再確認が必要です。アカウントメニューで3往復の確認を行ってください';
    return null;
  },
  status(account) {
    if (!this.view?.profiles?.some(p => p.account === account)) return '未接続';
    if (this.view.accountSwitch) return '利用可能';
    return ['ready','awaiting-observation'].includes(this.view.setup?.trial?.state) ? '接続確認中' : '再確認が必要';
  },
  openSetup() {
    if (taskQuickAdd.dialog?.open) taskQuickAdd.dialog.close();
    accountsMenu(document.querySelector('#accountsBtn'));
    document.querySelector('.acct-desktop')?.scrollIntoView({ block: 'nearest' });
  },
  repaint(cardId) { document.querySelectorAll('[data-desktop-resume-card]').forEach(el => { if (el.dataset.desktopResumeCard === cardId) el.paintResume?.(); }); },
  async startResume(cardId) {
    await this.refresh();
    const account = this.selected(cardId), problem = this.problem(account);
    if (problem) { this.openSetup(); throw new Error(problem); }
    let request = this.resumes.get(cardId);
    if (request?.submitting) return request.result;
    if (request?.result?.state === 'uncertain') throw new Error('起動結果が不明です。Desktop を確認してから「新しい再開要求」を選んでください');
    if (!request || ['opened','failed','cancelled'].includes(request.result?.state)) {
      request = { input: { cardId, route: 'desktop', desktopAccount: account, clientRequestId: crypto.randomUUID(), allowDesktopSwitch: true }, result: { state: 'prepared' } };
      this.resumes.set(cardId, request);
    }
    request.submitting = true; this.repaint(cardId);
    try { request.result = await bridge.callTool('canban_open_session', request.input); }
    catch (error) { request.result = { state: 'uncertain', reason: error.message }; throw error; }
    finally { request.submitting = false; this.repaint(cardId); }
    return request.result;
  },
  async cancelResume(cardId) {
    const request = this.resumes.get(cardId);
    if (!request) return;
    const response = await bridge.callTool('canban_cancel_start_session', { clientRequestId: request.input.clientRequestId });
    request.result = response.result || response; this.repaint(cardId);
  },
};

function desktopAccountPicker({ key, value = null, onChange = () => {} }) {
  if (value) desktopAccounts.selections.set(key, value);
  const items = () => {
    const keys = [...new Set([...(state.board?.accounts?.accounts || []).filter(a => a.agent === 'claude' || a.key.startsWith('claude:')).map(a => a.key), ...(desktopAccounts.view?.profiles || []).map(p => p.account), desktopAccounts.view?.activeAccount].filter(Boolean))];
    return keys.map(account => ({ value: account, label: accountName(account), description: desktopAccounts.status(account), keywords: account }));
  };
  const choose = account => { desktopAccounts.selections.set(key, account); paint(); onChange(account); };
  const button = pickerButton({ title: 'Desktop の起動アカウント', value: desktopAccounts.selected(key), stack: false, items, onChange: choose, placeholder: 'アカウント名で検索' });
  button.classList.add('desktop-account-picker');
  const status = h('span', { class: 'muted', role: 'status' });
  const setup = h('button', { type: 'button', class: 'link-btn', text: 'Desktop の接続・保持確認', onclick: () => desktopAccounts.openSetup() });
  const root = h('div', { class: 'desktop-account-field' }, h('div', { class: 'field-label' }, 'Desktop の起動アカウント', ...keycap('Alt+D')), button, status, setup);
  function paint() {
    const account = desktopAccounts.selected(key);
    const problem = desktopAccounts.problem(account);
    button.value = account; button.repaint(); status.textContent = problem || ''; status.hidden = !problem;
    setup.hidden = !problem;
  }
  const click = button.onclick;
  button.onclick = async () => { try { await desktopAccounts.refresh(); paint(); click(); } catch (e) { toast(e.message, true); } };
  desktopAccounts.refresh().then(() => { if (!desktopAccounts.selections.has(key)) { const account = desktopAccounts.defaultAccount(); if (account) { desktopAccounts.selections.set(key, account); onChange(account, { initial: true }); } } paint(); }).catch(() => { status.textContent = 'Desktop の接続を確認できません'; });
  paint(); return root;
}

function desktopResumeControl(cardId) {
  const feedback = h('div', { class: 'desktop-resume-feedback', role: 'status', 'aria-live': 'polite' });
  const launch = h('button', { type: 'button', class: 'side-btn', 'data-resume-desktop': '', onclick: () => desktopAccounts.startResume(cardId).catch(e => toast(e.message, true)) });
  const field = desktopAccountPicker({ key: cardId, onChange: () => paint() });
  const root = h('div', { class: 'desktop-resume-control', 'data-desktop-resume-card': cardId }, field, launch, feedback);
  let timer;
  function paint() {
    clearTimeout(timer);
    const request = desktopAccounts.resumes.get(cardId), result = request?.result, account = request?.input.desktopAccount || desktopAccounts.selected(cardId);
    const waiting = ['prepared','waiting-for-quit','waiting-for-login','opening'].includes(result?.state);
    launch.textContent = waiting ? '再開結果を確認' : `${account ? accountName(account) : 'アカウントを選択'} で Claude を開く`;
    launch.disabled = !!request?.submitting || result?.state === 'uncertain';
    field.querySelector('.desktop-account-picker').disabled = waiting || !!request?.submitting;
    feedback.replaceChildren(...[h('span', { text: result?.reason || result?.note || (result?.state === 'cancelled' ? '再開待機を取り消しました。選択と下書きは保持しています。' : '') }),
      waiting ? h('button', { type: 'button', class: 'btn', text: '再開待機を取り消す', onclick: () => desktopAccounts.cancelResume(cardId).catch(e => toast(e.message, true)) }) : null,
      result?.state === 'uncertain' ? h('button', { type: 'button', class: 'btn', text: 'Desktop 確認済み・新しい再開要求', onclick: async () => {
        try { await bridge.callTool('canban_acknowledge_desktop_launch', { clientRequestId: request.input.clientRequestId }); desktopAccounts.resumes.delete(cardId); paint(); } catch (e) { toast(e.message, true); }
      } }) : null].filter(Boolean));
    if (waiting && request && !request.submitting) timer = setTimeout(async () => {
      if (!root.isConnected || desktopAccounts.resumes.get(cardId) !== request) return;
      try { const response = await bridge.callTool('canban_get_start_session', { clientRequestId: request.input.clientRequestId }); if (response.result) request.result = response.result; }
      catch { feedback.textContent = '再開状況を確認できません。自動で再起動はしません。'; return; }
      paint();
    }, 2000);
  }
  root.paintResume = paint; paint(); return root;
}

function desktopPickerElement(reveal = false) {
  if (taskQuickAdd.dialog?.open) return taskQuickAdd.dialog.querySelector('.desktop-account-picker');
  const pane = focusedPane();
  if (reveal && pane?.id?.startsWith('claude:') && !pane.el.querySelector('.desktop-account-picker') && pane.detailNodes) openThreadSide(pane, 'details');
  return pane?.el.querySelector('.desktop-account-picker');
}

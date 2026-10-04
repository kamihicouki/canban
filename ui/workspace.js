// Common navigation, retained page forms and account/usage presentation.
// Existing tool-backed editors can mount their body in a page instead of a popover.
// The pages that open in the menu drawer (Trello's board menu), in tab order.
const DRAWER_PAGES = ['rules', 'labels', 'directories', 'views', 'hosts', 'usage', 'settings'];
const PAGE_ICONS = { rules: 'zap', labels: 'tag', directories: 'folder', views: 'bookmark', hosts: 'server', usage: 'gauge', settings: 'gear', analytics: 'chart', cards: 'cards', home: 'board' };
const workspace = {
  page: workspacePage(store.get('workspacePage', null), state.view === 'analytics' ? 'analytics' : dashOpen && store.get('panes', []).length ? 'cards' : 'home'),
  switching: false, initialized: false, entries: new Map(), draftValues: new WeakMap(), settingsTab: 'launch',
  pendingTask: store.get('activeTask', null), lastMenu: 'rules',
  init() {
    $('#brand').insertAdjacentHTML('afterbegin', LOGO_SVG);
    fillIcons();
    this.content = h('div', { class: 'app-content' });
    for (const el of [$('.topbar'), $('.boardbar'), $('#errbar'), $('.shell')]) this.content.append(el);
    document.body.append(this.content);
    // Management pages slide in from the right over the board; the header and board bar stay.
    this.title = h('h2');
    this.limit = h('button', { class: 'usage-link', 'aria-label': 'Agent Usageを開く', onclick: () => this.navigate('usage') });
    this.toolbar = h('header', { class: 'drawer-head' }, this.title, this.limit,
      h('button', { class: 'icon-btn drawer-close', type: 'button', 'aria-label': '閉じる（Esc）', title: '閉じる（Esc）', html: picon('close', 18), onclick: () => this.navigate('home') }));
    this.tabs = h('nav', { class: 'drawer-tabs', 'aria-label': 'メニューの項目' }, DRAWER_PAGES.map((id) =>
      h('button', { type: 'button', 'data-page': id, onclick: () => this.navigate(id) },
        h('span', { html: picon(PAGE_ICONS[id], 16) }), WORKSPACE_PAGES.find(([p]) => p === id)[1])));
    this.pages = h('div', { class: 'workspace-pages', 'aria-label': 'メニューの内容' });
    this.drawer = h('aside', { class: 'mgmt-drawer', hidden: true, 'aria-label': 'メニュー' }, this.toolbar, this.tabs, this.pages);
    this.scrim = h('div', { class: 'drawer-scrim', hidden: true, onclick: () => this.navigate('home') });
    $('.shell').append(this.scrim, this.drawer);
    paneBar.prepend(taskQuickAdd.button());
    $('#boardMenuBtn').addEventListener('click', () => this.navigate(this.utilityPage() ? 'home' : this.lastMenu));
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || e.defaultPrevented || !this.utilityPage() || document.querySelector('.popover, dialog[open]') || typingIn(e.target)) return;
      e.preventDefault(); this.navigate('home');
    });
    buildSelectionBar();
    buildLayouts();
    this.initialized = true;
    this.navigate(this.page, { save: false, reload: false });
    setInterval(() => {
      if (document.visibilityState !== 'visible' || !state.board) return;
      this.renderLimitChip(state.board.limits);
      if (this.page === 'usage') this.render(state.board);
    }, 30000);
  },
  utilityPage() { return !['home', 'analytics'].includes(this.page) && !(this.page === 'cards' && (panes.length || this.activeTask)); },
  navigate(value, { save = true, reload = true } = {}) {
    const requested = workspacePage(value);
    const next = requested === 'cards' && !panes.length && !store.get('panes', []).length && !this.pendingTask ? 'home' : requested;
    this.switching = true;
    try {
      this.page = next; state.view = next === 'analytics' ? 'analytics' : 'board';
      dashOpen = next === 'cards';
      closePopover();
      if (save) { store.set('workspacePage', next); store.set('view', state.view); store.set('dashOpen', dashOpen); }
      for (const o of $$('.overlay')) o.hidden = next !== 'cards' || o.dataset.taskId !== this.activeTask;
      state.modalOpen = next === 'cards' && !!document.querySelector('.overlay:not([hidden])');
      this.syncShell();
      paintDash(); layoutPanes();
      if (state.board && state.view !== 'analytics') render();
      if (reload) load();
    } finally { this.switching = false; }
  },
  syncDash() {
    if (!this.initialized || this.switching) return;
    if (dashOpen && panes.length && this.page !== 'cards') this.navigate('cards', { reload: false });
    else if (!dashOpen && this.lastDash && this.page === 'cards' && !state.modalOpen) this.navigate('home', { reload: false });
    else this.syncShell();
    this.lastDash = dashOpen;
  },
  syncShell() {
    document.body.dataset.page = this.page;
    if (this.page === 'analytics') $('#logo').textContent = '分析';
    const utility = this.utilityPage();
    if (utility && DRAWER_PAGES.includes(this.page)) this.lastMenu = this.page;
    this.drawer.hidden = !utility;
    this.scrim.hidden = !utility;
    $('#boardMenuBtn').setAttribute('aria-pressed', String(utility));
    for (const b of [...this.tabs.children, ...$$('#sidebar [data-page]')]) b.setAttribute('aria-current', b.dataset.page === this.page ? 'page' : 'false');
    this.title.replaceChildren(h('span', { html: picon(PAGE_ICONS[this.page] || 'more', 20) }), WORKSPACE_PAGES.find(([id]) => id === this.page)?.[1] || 'メニュー');
    for (const entry of this.entries.values()) entry.el.hidden = entry.page !== this.page || (entry.page === 'settings' && entry.tab !== this.settingsTab);
    const layerOpen = this.page === 'cards' && (dashOpen && panes.length || state.modalOpen);
    $('.shell').inert = !!layerOpen;
    $('.topbar').inert = !!layerOpen;
    $('.boardbar').inert = !!layerOpen;
    paintLayoutChrome();
  },
  trackDrafts(root) {
    for (const el of root.querySelectorAll('input:not([type=checkbox]):not([type=radio]),textarea,select')) {
      if (!this.draftValues.has(el)) this.draftValues.set(el, el.value);
    }
  },
  async restoreTask() {
    const id = this.pendingTask;
    if (typeof id !== 'string' || !id.startsWith('task:')) return;
    this.pendingTask = null;
    store.set('activeTask', null);
    await taskDash.open(id, { reveal: false });
    savePanes();
  },
  async saveField(el, save) {
    const value = el.value;
    try {
      await save(value);
      this.draftValues.set(el, value);
      if ('defaultValue' in el) el.defaultValue = value;
      return true;
    } catch { return false; }
  },
  hasDrafts(root = document) {
    return !!root.querySelector('[data-unsaved-form="true"]') || [...root.querySelectorAll('input,textarea,select')].some(el => this.draftValues.has(el) && this.draftValues.get(el) !== el.value);
  },
  render(board) {
    if (!this.initialized) return;
    this.renderLimitChip(board.limits); this.syncShell();
    if (!this.utilityPage()) return;
    const key = this.page === 'settings' ? `settings:${this.settingsTab}` : this.page;
    const existing = this.entries.get(key);
    if (existing && this.hasDrafts(existing.el)) return;
    const entry = existing || { el: h('section', { class: 'workspace-page', 'aria-label': this.title.textContent }), page: this.page, tab: this.settingsTab };
    this.entries.set(key, entry);
    if (!entry.el.isConnected) this.pages.append(entry.el);
    entry.el.replaceChildren(); entry.el.hidden = false;
    const panel = () => h('div', { class: 'page-panel' });
    const anchor = h('button', { hidden: true }); entry.el.append(anchor);
    const body = panel(); entry.el.append(body); anchor._pagePanel = body;
    const builders = { rules: rulesMenu, views: viewsMenu, labels: labelsManager, hosts: hostsMenu };
    if (builders[this.page]) builders[this.page](anchor);
    else if (this.page === 'settings') this.renderSettings(entry, anchor, body);
    else if (this.page === 'directories') this.renderDirectories(entry, board);
    else if (this.page === 'usage') this.renderUsage(entry, board);
    this.trackDrafts(entry.el);
    bridge.reportSize();
  },
  renderSettings(entry, anchor, body) {
    const tabs = [['launch', '再開・送信'], ['display', '表示'], ['accounts', 'アカウント'], ['shortcuts', 'ショートカット']];
    entry.el.prepend(h('div', { class: 'page-tabs', role: 'group', 'aria-label': '設定の種類' }, tabs.map(([key, name]) =>
      h('button', { text: name, 'aria-pressed': String(this.settingsTab === key), onclick: () => {
        this.settingsTab = key; this.render(state.board);
      } }))));
    if (this.settingsTab === 'accounts') accountsMenu(anchor);
    else if (this.settingsTab === 'display') { optionsMenu(anchor); body.prepend(h('h3', { text: 'レイアウトと色' }), layoutChooser(), h('div', { class: 'sep' })); }
    else if (this.settingsTab === 'shortcuts') body.append(h('div', { class: 'keys' }, SHORTCUTS.flatMap(([group, keys]) =>
      [h('h4', { text: group }), ...keys.flatMap(([k, v]) => [h('kbd', { text: k }), h('span', { text: v })])])));
    else settingsMenu(anchor);
    body.append(h('div', { class: 'sep' }), h('h3', { text: '画面状態の共有' }),
      h('p', { class: 'page-help', text: sharedUi.blocked ? '別の画面で更新されました。この画面と入力を保持したまま同期を停止しています。' : '前面に戻ったときに共有設定を取り込みます。入力途中の文章は共有しません。' }),
      h('p', { class: 'page-help', text: `共有リビジョン：${sharedUi.revision ?? '未取得'}` }));
    if (sharedUi.blocked) body.append(h('button', { class: 'btn', text: '共有状態を読み込む', onclick: () => reloadSharedUi() }));
  },
  renderDirectories(entry, board) {
    entry.el.replaceChildren();
    const grid = h('div', { class: 'page-grid' }), listing = h('div', { class: 'page-panel' }), editing = h('div', { class: 'page-panel' });
    listing.append(h('h2', { text: 'カテゴリ' }));
    for (const d of board.directories) listing.append(h('div', { class: 'rule-row' },
      h('button', { class: 'menu-item grow', text: d.name, onclick: () => {
        this.selectedDirectory = d.id; this.renderDirectories(entry, state.board);
      } }), h('span', { class: 'count', text: d.count ?? '' })));
    listing.append(h('button', { class: 'menu-item', text: `カテゴリ無し (${board.uncategorizedCount || 0})`, title: '分類を持たないカードの特殊カテゴリです', onclick: () => { this.navigate('home', { reload: false }); setScope({ directory: '__none' }); } }));
    const name = h('input', { class: 'text-input', placeholder: '新しいカテゴリ', 'aria-label': '新しいカテゴリ' });
    const create = () => name.value.trim() && act('canban_create_directory', { name: name.value.trim(), color: 'blue' }, { okMsg: 'カテゴリを追加しました' })
      .then(() => { name.value = ''; this.render(state.board); }).catch(() => {});
    listing.append(h('div', { class: 'row' }, name, h('button', { class: 'btn-primary', text: '追加', onclick: create })));
    name.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) create(); };
    const selected = board.directories.find(d => d.id === this.selectedDirectory) || board.directories[0];
    if (selected) {
      editing.append(h('h2', { text: 'カテゴリの設定' }));
      const a = h('button', { hidden: true }); const mount = h('div'); a._pagePanel = mount;
      editing.append(a, mount); directoryMenu(a, selected.id);
    } else editing.append(h('p', { text: 'カテゴリを追加してカードを整理できます。' }));
    grid.append(listing, editing); entry.el.append(grid);
    this.trackDrafts(entry.el);
  },
  usageAccounts(board) {
    if (board?.accounts) return board.accounts.accounts;
    return [{ agent: 'codex', label: 'Codex', limits: board?.limits }];
  },
  renderLimitChip(limits) {
    const list = this.usageAccounts(state.board || { limits }).filter(a => a.inHeader !== false);
    const text = list.map(a => {
      const selected = usageWindows(a.limits).map(w => usageWindow(w, a.limits.at)).filter(Boolean).at(-1);
      return `${a.label} ${selected ? `${selected.label} ${selected.stale ? '要更新' : `残り${selected.remaining}%`}` : '未取得'}`;
    }).join(' · ') || 'アカウントの利用上限：未取得';
    this.limit.textContent = text;
    // Account rings in the home header are the compact entry point to quota details.
    const bar = $('#limitsBar'); if (bar) bar.hidden = true;
    $('#accountsBtn')?.setAttribute('title', text);
  },
  table(headings, rows) {
    return h('div', { class: 'page-table-wrap' }, h('table', { class: 'page-table' },
      h('thead', {}, h('tr', {}, headings.map(text => h('th', { scope: 'col', text })))),
      h('tbody', {}, rows.map(row => h('tr', {}, row.map(value => h('td', {}, value)))))));
  },
  renderUsage(entry, board) {
    entry.el.replaceChildren();
    const quotaGrid = h('div', { class: 'quota-grid' });
    const accounts = this.usageAccounts(board);
    for (const agent of ['codex', 'claude']) {
      const list = accounts.filter(a => a.agent === agent);
      if (!list.length) quotaGrid.append(h('section', { class: 'page-panel' }, h('h2', { text: `${agent === 'codex' ? 'Codex' : 'Claude'}の利用上限` }),
        h('p', { text: '未取得' }), h('p', { class: 'page-help', text: '利用上限を確認できる記録がありません。' })));
      for (const a of list) {
        const windows = usageWindows(a.limits).map(w => usageWindow(w, a.limits.at)).filter(Boolean);
        const panel = h('section', { class: 'page-panel' }, h('div', { class: 'usage-heading' },
          h('h2', { text: `${agent === 'codex' ? 'Codex' : 'Claude'} · ${a.label}` }),
          h('span', { class: 'page-help', text: a.plan || 'アカウント単位' })),
          h('p', { class: 'page-help', text: `取得元：${a.limits?.source === 'live' ? 'サービスから取得' : a.limits?.source === 'desktop' ? 'Claude Desktopの記録' : 'セッションログ'} · 最終取得：${fmtDate(a.limits?.at)}` }));
        if (!windows.length) panel.append(h('p', { text: '未取得：利用上限を確認できる記録がありません。' }));
        for (const w of windows) panel.append(h('div', { class: 'usage-window' }, h('strong', { text: w.label }),
          w.stale ? h('div', { class: 'usage-stale', text: '要更新 — 残量を確定できません' }) :
            h('div', {}, h('div', { class: 'usage-meter', role: 'meter', 'aria-label': `${a.label} ${w.label}の使用率`, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': w.used },
              h('span', { class: 'usage-used', style: { width: `${w.used}%` }, text: w.used >= 20 ? `使用 ${w.used}%` : '' }),
              h('span', { class: 'usage-remaining', text: w.remaining >= 20 ? `残り ${w.remaining}%` : '' })),
              h('div', { class: 'usage-numbers', text: `使用 ${w.used}% · 残り ${w.remaining}%` })),
          h('span', { class: 'page-help', text: w.resetsAt ? `リセット：${fmtDate(w.resetsAt)}` : 'リセット時刻は未取得' })));
        panel.append(h('p', { class: 'page-help', text: `${a.count ?? 0} セッション · 15分以上更新がない記録や期限を過ぎた記録は「要更新」と表示します。` }));
        quotaGrid.append(panel);
      }
    }
    entry.el.append(h('div', { class: 'page-heading' }, h('div', {}, h('h2', { text: 'アカウントの利用上限' }),
      h('p', { class: 'page-help', text: 'アカウントごとの使用率と残量です。セッションのコンテキスト量は下段で確認できます。' })),
      h('button', { class: 'btn', text: 'アカウントを管理', onclick: () => { this.settingsTab = 'accounts'; this.navigate('settings'); } })), quotaGrid);
    const cards = board.lists.flatMap(l => l.cards).filter(c => c.kind !== 'task');
    const contexts = h('section', { class: 'page-panel' }, h('h2', { text: 'セッションのコンテキスト' }),
      h('p', { class: 'page-help', text: '現在のホームの絞り込みに一致するセッションです。コンテキスト量はアカウントの利用上限とは別の値です。' }));
    contexts.append(this.table(['セッション', 'エージェント', '使用量', '更新'], cards.slice(0,100).map(c => {
      const ctx = c.signals?.ctx;
      return [h('button', { class: 'link-btn', text: c.title, onclick: () => openCard(c.id) }), c.agent === 'codex' ? 'Codex' : 'Claude',
        ctx ? `${fmtTok(ctx.used)} / ${ctx.window ? fmtTok(ctx.window) : '上限未取得'}${ctx.window ? ` (${ctxPct(ctx)}%)` : ''}` : '未取得', fmtDate(c.updatedAt)];
    })));
    if (!cards.length) contexts.append(h('p', { text: '対象のセッションがありません。' }));
    if (cards.length > 100) contexts.append(h('p', { class: 'page-help', text: '先頭100件を表示しています。ホームで絞り込めます。' }));
    entry.el.append(contexts);
    const presence = h('section', { class: 'page-panel' }, h('h2', { text: '接続中の画面' }),
      h('p', { class: 'page-help', text: 'Canbanへ接続している画面です。CLIが実行中かどうかは、この接続状態では判断しません。' }));
    presence.append(this.table(['画面', '接続状態', '最終検出'], [
      ['現在の画面', live.on ? '接続中' : 'ボード取得済み', '現在'],
      ...live.presence.map(p => [p.app, '接続中', fmtDate(p.at)]),
    ])); entry.el.append(presence);
  },
};
workspace.init();

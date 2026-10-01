// Task workspaces reuse the existing pane renderers, dispatch gates and live feeds.
// Detached DOM stays in memory so switching contexts never destroys a draft.
taskDash = {
  active: null, general: null, contexts: new Map(), changing: false, queue: Promise.resolve(),
  run(action) {
    const next = this.queue.then(action);
    this.queue = next.catch(e => { toast(e.message, true); });
    return next;
  },
  hasDrafts() {
    return [...this.contexts.values(), ...(this.general ? [this.general] : [])].some(ctx => [...ctx.cache.values()].some(p => workspace.hasDrafts(p.el)));
  },
  primaryLinks(ctx) { return ctx.links.filter(id => !ctx.sessions.find(s => s.id === id)?.subagent); },
  snapshotPanes() { return panes.map(p => ({ id: p.id, space: p.space, mode: p.mode, size: p.size, note: p.note, free: p.free, hidden: false })); },
  remember(ctx = this.active) {
    if (!ctx || this.changing) return;
    ctx.state.panes = taskPanePreferences(ctx.id, this.primaryLinks(ctx), ctx.state.panes, this.snapshotPanes());
    ctx.state.paneGlobal = { ...paneGlobal };
    ctx.state.paneLayout = structuredClone(paneLayout);
    for (const p of panes) ctx.cache.set(p.id, p);
  },
  changed() {
    if (!this.active || this.changing) return;
    this.remember();
    const ctx = this.active;
    ctx.dirty = true; ctx.generation++;
    clearTimeout(ctx.timer);
    if (!ctx.blocked) ctx.timer = setTimeout(() => this.flush(ctx), 350);
    this.paintStatus();
  },
  async flush(ctx = this.active) {
    if (!ctx || !ctx.dirty || ctx.blocked) return;
    if (ctx.inflight) { await ctx.inflight; return this.flush(ctx); }
    clearTimeout(ctx.timer);
    const generation = ctx.generation;
    const stateToSave = structuredClone(ctx.state);
    ctx.inflight = (async () => {
      try {
        const r = sharedUiRecord(await bridge.callTool('canban_save_task_dashboard', { taskId: ctx.id, expectedRevision: ctx.revision, state: stateToSave }));
        if (r.conflict) { ctx.blocked = true; ctx.status = '別の画面で更新されました'; }
        else if (r.saved) { ctx.revision = r.revision; ctx.dirty = ctx.generation !== generation; ctx.status = '保存済み'; }
      } catch (e) { ctx.status = `保存できません: ${e.message}`; }
    })();
    this.paintStatus();
    await ctx.inflight; ctx.inflight = null;
    this.paintStatus();
    // A network failure stays visible and is retried explicitly, without a hot loop.
    if (ctx.dirty && !ctx.blocked && ctx.generation !== generation) ctx.timer = setTimeout(() => this.flush(ctx), 350);
  },
  detach(ctx) {
    for (const p of panes) {
      ctx.cache.set(p.id, p);
      const feed = live.feeds.get(p.id); if (feed) ctx.feeds.set(p.id, feed);
      live.feeds.delete(p.id); clearInterval(p.el._reqTimer); p.el.remove();
    }
    panes.splice(0);
  },
  attach(ctx, p, pref) {
    Object.assign(p, pref);
    panes.push(p); paneCanvas.append(p.el);
    if (!p.free && eff(p, 'space') === 'free') p.free = nextFree();
    const feed = ctx.feeds.get(p.id);
    if (feed) { live.feeds.set(p.id, feed); if (ctx === this.general) refreshDispatch(feed); }
    if (!live.on && p.d?.dispatch) watchRequests(p.el, p.d);
    applyPaneLayoutTo(p.el); refreshPane(p);
  },
  async open(id, { reveal = true } = {}) { return this.run(() => this.switchTo(id, reveal)); },
  async switchTo(id, reveal = true) {
    if (this.active?.id === id) { if (reveal) setDash(true, { quiet: true }); return; }
    // Read first: failure leaves the currently open workspace intact.
    const record = sharedUiRecord(await bridge.callTool('canban_get_task_dashboard', { taskId: id }));
    if (this.active) { this.remember(); await this.flush(); }
    else {
      this.general = { cache: new Map(), feeds: new Map(), panes: this.snapshotPanes(), paneGlobal: { ...paneGlobal }, paneLayout: structuredClone(paneLayout) };
      savePanes();
    }
    this.changing = true;
    this.detach(this.active || this.general);
    let ctx = this.contexts.get(id);
    if (!ctx) {
      ctx = { id, cache: new Map(), feeds: new Map(), generation: 0, dirty: false, blocked: false, revision: record.revision,
        state: record.state || { version: 1, preset: 'A', activeSessionId: null, panes: [], paneGlobal: { space: 'fixed', arrange: 'grid', mode: 'preview', size: 'L' }, paneLayout: normalizePaneLayout({ main: ['conv', 'memo', 'related', 'send'] }, PANE_LAYOUT_DEF, PANE_HEIGHTS) } };
      this.contexts.set(id, ctx);
    } else if (record.revision !== ctx.revision) {
      if (ctx.dirty) { ctx.blocked = true; ctx.status = '別の画面で更新されました'; }
      else { if (record.state) ctx.state = record.state; ctx.revision = record.revision; }
    }
    ctx.links = record.links; ctx.sessions = record.sessions || [];
    const ordered = ctx.state.panes.filter(p => p.id !== id && !p.hidden);
    ctx.page = Math.max(0, Math.floor(ordered.findIndex(p => p.id === ctx.state.activeSessionId) / (PANE_MAX - 1)));
    ctx.state.panes = taskPanePreferences(id, this.primaryLinks(ctx), ctx.state.panes);
    this.active = ctx; workspace.activeTask = id; workspace.pendingTask = null;
    Object.assign(paneGlobal, ctx.state.paneGlobal);
    paneLayout = normalizePaneLayout(ctx.state.paneLayout, PANE_LAYOUT_DEF, PANE_HEIGHTS);
    store.set('activeTask', id);
    this.changing = false;
    await this.show(); this.changed(); if (reveal) setDash(true, { quiet: true });
  },
  async show() {
    const ctx = this.active; if (!ctx) return;
    this.remember(ctx); this.changing = true;
    this.detach(ctx);
    const view = taskVisiblePanes(ctx.id, this.primaryLinks(ctx), ctx.state.panes, ctx.state.preset, ctx.state.activeSessionId, ctx.page, PANE_MAX);
    ctx.state.activeSessionId = view.active; ctx.page = view.page; ctx.view = view;
    try {
      for (const id of view.ids) {
        const pref = ctx.state.panes.find(p => p.id === id);
        const cached = ctx.cache.get(id);
        if (cached) {
          this.attach(ctx, cached, pref);
          if (id === ctx.id && !workspace.hasDrafts(cached.el)) await openTaskModal(id, pref);
          else if (id !== ctx.id) await openCard(id, pref);
        }
        else if (id === ctx.id) await openTaskModal(id, pref);
        else await openCard(id, pref);
      }
      const parent = panes.find(p => p.id === ctx.id);
      if (parent) { parent.el.classList.add('task-parent'); this.paintRelated(parent); }
      paneLayer.dataset.taskPreset = ctx.state.preset;
      this.paint(); paintPaneBar(); layoutPanes(); kickLive();
    } finally { this.changing = false; }
  },
  select(id) { return this.run(async () => {
    const ctx = this.active; if (!ctx || !this.primaryLinks(ctx).includes(id)) return;
    this.remember();
    const pref = ctx.state.panes.find(p => p.id === id); if (pref) pref.hidden = false;
    ctx.state.activeSessionId = id;
    const sessions = ctx.state.panes.filter(p => p.id !== ctx.id && !p.hidden);
    ctx.page = Math.floor(sessions.findIndex(p => p.id === id) / (PANE_MAX - 1));
    await this.show(); this.changed(); panes.find(p => p.id === id)?.el.focus({ preventScroll: true });
  }); },
  preset(value) { return this.run(async () => {
    if (!this.active) return;
    this.remember(); this.active.state.preset = value;
    if (value === 'free') { paneGlobal.space = 'free'; for (const p of this.active.state.panes) p.space = null; }
    else { paneGlobal.space = 'fixed'; for (const p of this.active.state.panes) p.space = null; }
    this.active.state.paneGlobal = { ...paneGlobal };
    await this.show(); this.changed();
  }); },
  custom() {
    if (!this.active || this.active.state.preset === 'free') return;
    this.active.state.preset = 'free'; paneLayer.dataset.taskPreset = 'free'; this.paint();
    this.run(async () => { await this.show(); this.changed(); });
  },
  close(id) {
    if (!this.active || this.changing) return false;
    if (id === this.active.id) this.leave(false);
    else this.run(async () => {
      const ctx = this.active; if (!ctx) return;
      this.remember(); const pref = ctx.state.panes.find(p => p.id === id); if (pref) pref.hidden = true;
      if (ctx.state.activeSessionId === id) ctx.state.activeSessionId = null;
      // show() captures the current panes: detach first so the hidden flag survives.
      this.changing = true; this.detach(ctx); this.changing = false;
      await this.show(); this.changed();
    });
    return true;
  },
  leave(open = true) { return this.run(async () => {
    if (!this.active) return;
    this.remember(); await this.flush(); this.changing = true;
    this.detach(this.active); this.active = null; workspace.activeTask = null; store.set('activeTask', null);
    delete paneLayer.dataset.taskPreset;
    if (this.general) {
      Object.assign(paneGlobal, this.general.paneGlobal); paneLayout = this.general.paneLayout;
      for (const pref of this.general.panes) { const p = this.general.cache.get(pref.id); if (p) this.attach(this.general, p, pref); }
    }
    this.changing = false; this.paint(); paintPaneBar(); layoutPanes(); kickLive();
    setDash(open && !!panes.length, { quiet: true });
    if (!open || !panes.length) workspace.navigate('home', { reload: false });
  }); },
  async reload() {
    const ctx = this.active; if (!ctx) return;
    try {
      const record = sharedUiRecord(await bridge.callTool('canban_get_task_dashboard', { taskId: ctx.id }));
      this.remember();
      // Reload presentation only; cached pane DOM and all draft inputs survive.
      ctx.state = record.state || ctx.state; ctx.links = record.links; ctx.sessions = record.sessions || [];
      ctx.revision = record.revision; ctx.blocked = false; ctx.dirty = false; ctx.status = '保存済み';
      ctx.state.panes = taskPanePreferences(ctx.id, this.primaryLinks(ctx), ctx.state.panes);
      Object.assign(paneGlobal, ctx.state.paneGlobal); paneLayout = normalizePaneLayout(ctx.state.paneLayout, PANE_LAYOUT_DEF, PANE_HEIGHTS);
      this.changing = true; this.detach(ctx); this.changing = false;
      await this.show();
    } catch (e) { toast(e.message, true); }
  },
  reconcile(board) {
    const ctx = this.active; if (!ctx) return;
    const card = board.lists.flatMap(l => l.cards).find(c => c.id === ctx.id);
    if (!card) return; // Filtered / unavailable is not an unlink operation.
    const links = card.linkedSessionIds || card.links.map(s => s.id);
    ctx.sessions = card.links;
    const parent = panes.find(p => p.id === ctx.id);
    if (parent) {
      parent.taskCard = card; parent.status = card.status;
      const status = $('.pane-status', parent.el);
      if (status) status.replaceChildren(h('span', { class: `sdot s-${card.status}` }), STATUS_LABELS[card.status]);
    }
    const changed = JSON.stringify(links) !== JSON.stringify(ctx.links);
    if (changed) this.run(async () => {
      if (this.active !== ctx) return;
      this.remember(); ctx.links = links;
      ctx.state.panes = taskPanePreferences(ctx.id, this.primaryLinks(ctx), ctx.state.panes);
      this.changing = true; this.detach(ctx); this.changing = false;
      await this.show(); this.changed();
    });
    else { if (parent) this.paintRelated(parent); this.paint(); }
  },
  paintRelated(parent) {
    const ctx = this.active; if (!ctx) return;
    const slot = $('.psec[data-sec="related"] .psec-b', parent.el); if (!slot) return;
    const links = this.primaryLinks(ctx);
    const heading = $('.psec[data-sec="related"] h3', parent.el); if (heading) heading.textContent = `関連する通常セッション（${links.length}）`;
    slot.replaceChildren(...(links.length ? links.map(id => {
      const s = ctx.sessions.find(s => s.id === id);
      return h('div', { class: 'sub-row' }, h('span', { class: `sdot s-${s?.status || 'idle'}` }),
        h('button', { class: 'link-btn ellipsis grow', text: s?.title || `未取得: ${id}`, onclick: () => this.select(id) }),
        h('button', { class: 'link-btn', text: 'タスクから外す', onclick: async () => {
          await act('canban_unlink_session', { taskId: ctx.id, sessionId: id }, { okMsg: 'タスクとの関連を解除しました' });
        } }));
    }) : [h('p', { class: 'muted', text: '通常のセッションはまだ紐付いていません。' })]));
    for (const pending of parent.taskCard?.pending || []) slot.append(h('p', { class: 'muted', text: `${pending.expired ? '見つかりません' : '開始待ち'}: ${pending.agent === 'codex' ? 'Codex' : 'Claude'}` }));
  },
  async linkMenu(anchor) {
    const ctx = this.active; if (!ctx) return;
    try {
      const board = await bridge.callTool('canban_get_board', { days: 0, includeArchived: true, includeHidden: true });
      const candidates = board.lists.flatMap(l => l.cards).flatMap(c => c.kind === 'task' ? c.links.map(s => ({ ...s, title: `${s.title}（${c.title}から移動）` })) : [c]);
      const cards = [...new Map(candidates.filter(c => !c.subagent && !ctx.links.includes(c.id)).map(c => [c.id, c])).values()];
      const rows = cards.map(c => h('button', { class: 'menu-item', 'data-key': c.title, text: c.title, onclick: async () => {
        await act('canban_link_session', { taskId: ctx.id, sessionId: c.id }, { okMsg: 'タスクに紐付けました' }); closePopover();
      } }));
      popover(anchor, '通常のセッションを紐付ける', h('div', {}, rows.length ? [rowFilter(rows), ...rows] : h('p', { class: 'muted', text: '紐付けられるセッションがありません' })), { width: 400 });
    } catch (e) { toast(e.message, true); }
  },
  requestText() {
    const parent = this.active?.cache.get(this.active.id);
    if (!parent) return '';
    return taskRequestText($('.title-input', parent.el)?.value, $('textarea[aria-label="説明"]', parent.el)?.value, $('textarea[aria-label="メモ"]', parent.el)?.value);
  },
  async prepareRequest() {
    const ctx = this.active, id = ctx?.state.activeSessionId;
    if (!id) return toast('先に依頼先のセッションを選んでください', true);
    await this.select(id);
    const p = panes.find(p => p.id === id), input = $('.send-box textarea', p?.el);
    if (!input) return toast('このセッションへの送信は設定でオフになっています', true);
    if (input.value.trim()) return toast('入力途中の依頼文を保持しています。先に内容を確認してください', true);
    input.value = this.requestText(); input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
    toast('説明・メモを取り込みました。内容と実行状態を確認してから送信してください');
  },
  paintStatus() {
    const ctx = this.active, slot = $('.task-save-status', paneLayer); if (!slot || !ctx) return;
    slot.textContent = ctx.blocked ? ctx.status : ctx.inflight ? '保存中…' : ctx.dirty ? ctx.status?.startsWith('保存できません') ? ctx.status : '変更を保存中…' : '保存済み';
    const reload = $('.task-reload', paneLayer); if (reload) reload.hidden = !ctx.blocked;
    const retry = $('.task-save-retry', paneLayer); if (retry) retry.hidden = !ctx.dirty || ctx.blocked || !ctx.status?.startsWith('保存できません');
  },
  paint() {
    this.bar?.remove(); this.bar = null;
    const ctx = this.active; if (!ctx) return;
    const parent = ctx.cache.get(ctx.id);
    const title = parent?.taskCard?.title || findCard(ctx.id)?.card.title || 'タスク';
    const modes = h('div', { class: 'seg task-presets', role: 'group', 'aria-label': 'タスクの表示方式' },
      [['A', 'A 左右'], ['B', 'B 上下'], ['C', 'C 並列'], ['free', '自由配置']].map(([value, label]) => h('button', { text: label, 'aria-pressed': String(ctx.state.preset === value), onclick: () => this.preset(value) })));
    const select = h('select', { class: 'task-session-select text-input', 'aria-label': '関連する通常セッション', onchange: e => this.select(e.target.value) },
      h('option', { value: '', text: '会話を選ぶ', disabled: true }), this.primaryLinks(ctx).map(id => {
        const s = ctx.sessions.find(s => s.id === id), pref = ctx.state.panes.find(p => p.id === id);
        return h('option', { value: id, text: `${s?.title || `未取得: ${id}`}${pref?.hidden ? '（表示から閉じています）' : ''}` });
      }));
    select.value = ctx.state.activeSessionId || '';
    const page = ctx.view?.pages > 1 && ['C', 'free'].includes(ctx.state.preset) ? h('span', { class: 'task-pages row' },
      h('button', { class: 'btn', text: '前へ', disabled: ctx.page === 0, onclick: () => this.run(async () => { ctx.page--; await this.show(); this.changed(); }) }),
      `${ctx.page + 1} / ${ctx.view.pages}`,
      h('button', { class: 'btn', text: '次へ', disabled: ctx.page + 1 >= ctx.view.pages, onclick: () => this.run(async () => { ctx.page++; await this.show(); this.changed(); }) })) : null;
    this.bar = h('div', { class: 'task-dashboard-bar', role: 'region', 'aria-label': 'タスクのダッシュボード' },
      h('strong', { class: 'task-dashboard-title', text: title }), h('span', { class: 'task-parent-label', text: 'タスクの作業画面' }), modes, select, page,
      h('button', { class: 'btn', text: '＋ セッションを紐付ける', onclick: e => this.linkMenu(e.currentTarget) }),
      h('button', { class: 'btn', text: '説明・メモから追加依頼', onclick: () => this.prepareRequest() }),
      h('span', { class: 'task-save-status', role: 'status' }),
      h('button', { class: 'btn task-reload', text: '保存された配置を読み込む', hidden: true, onclick: () => this.run(() => this.reload()) }),
      h('button', { class: 'btn task-save-retry', text: '保存を再試行', hidden: true, onclick: () => this.flush() }),
      h('button', { class: 'btn', text: '一般ダッシュボードへ', onclick: () => this.leave() }));
    paneBar.after(this.bar); this.paintStatus();
  },
  layout(stack) {
    const ctx = this.active;
    for (const p of panes) p.el.style.width = '';
    if (!ctx || ctx.state.preset === 'free' || stack) return false;
    const W = paneStage.clientWidth, H = paneStage.clientHeight, gap = PANE_GAP;
    const ordered = [panes.find(p => p.id === ctx.id), ...panes.filter(p => p.id !== ctx.id)].filter(Boolean);
    const put = (p, x, y, w, height) => {
      setXY(p.el, x, y); p.el.style.width = `${Math.max(0, w)}px`; p.el.style.height = `${p.note ? Math.min(130, height) : height}px`;
      p.el.classList.remove('floating');
    };
    let bottom = H;
    if (stack || ctx.state.preset === 'B') {
      let y = gap;
      for (const p of ordered) { const height = stack ? Math.max(360, H - gap * 2) : p.id === ctx.id && panes.length > 1 ? Math.max(250, Math.floor(H * .4)) : Math.max(320, H - y - gap); put(p, gap, y, W - gap * 2, height); y += (p.note ? Math.min(130, height) : height) + gap; }
      bottom = Math.max(H, y);
    } else if (ctx.state.preset === 'A') {
      const width = panes.length === 1 ? W - gap * 2 : Math.max(320, Math.floor((W - gap * 3) * .38));
      ordered.forEach((p, i) => put(p, i ? width + gap * 2 : gap, gap, i ? W - width - gap * 3 : width, H - gap * 2));
    } else {
      const columns = Math.max(1, Math.min(3, panes.length, Math.floor((W - gap) / 340)));
      const width = (W - gap * (columns + 1)) / columns, height = Math.max(400, H - gap * 2);
      ordered.forEach((p, i) => put(p, gap + (i % columns) * (width + gap), gap + Math.floor(i / columns) * (height + gap), width, height));
      bottom = Math.max(H, Math.ceil(panes.length / columns) * (height + gap) + gap);
    }
    paneCanvas.style.width = `${W}px`; paneCanvas.style.height = `${bottom}px`;
    paneStage.classList.toggle('scrolls', bottom > H); return true;
  },
};

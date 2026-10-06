// Slack stays on the board; the server owns credentials, transport and history.
const slackUi = {
  visible: !!store.get('slackVisible', false), data: { workspaces: [], messages: [], status: {} }, filter: '', query: '', shown: 50,
  async call(name, args = {}) { const response = await bridge.callTool(`canban_slack_${name}`, args); return response.result || response; },
  async refresh() {
    if (this.loading) return;
    this.loading = true;
    try { const [workspaceId, channelId] = this.filter.split(':'); const data = await this.call('view', workspaceId ? { workspaceId, channelId } : {}); const signature = JSON.stringify(data);
      if (signature !== this.signature) { this.signature = signature; this.data = data; this.paint(); }
    } catch (error) { if (this.visible) toast(error.message, true); }
    finally { this.loading = false; }
  },
  toggle(value = !this.visible) {
    this.visible = value; store.set('slackVisible', value); render();
    if (value) { this.refresh(); this.el?.focus(); }
  },
  boardNode() {
    if (!this.visible) return null;
    if (!this.el) { this.el = h('section', { class: 'list slack-timeline', tabindex: -1, 'aria-label': 'Slackタイムライン' }); this.paint(); }
    return this.el;
  },
  paint() {
    if (!this.el) return;
    const scroll = this.feed?.scrollTop || 0, focusedKey = document.activeElement?.closest('.slack-message')?.dataset.slackKey;
    const choices = h('select', { 'aria-label': '表示するSlackの会話', onchange: e => { this.filter = e.target.value; this.shown = 50; this.refresh(); this.paint(); } },
      h('option', { value: '', text: '選択した会話をすべて表示' }), this.data.workspaces.flatMap(w => w.channels.map(c => h('option', { value: `${w.id}:${c.id}`, text: `${w.name} / ${c.name}` })))); choices.value = this.filter;
    const query = h('input', { class: 'text-input', type: 'search', 'aria-label': 'Slackメッセージを絞り込む', placeholder: '本文を絞り込む', value: this.query,
      oninput: e => { this.query = e.target.value; this.shown = 50; this.paintMessages(); } });
    const feed = this.feed = h('div', { class: 'slack-feed', role: 'list', 'aria-label': 'Slackメッセージ' });
    this.el.replaceChildren(h('header', { class: 'slack-head' }, h('span', { html: picon('message', 17) }), h('strong', { text: 'Slack' }), keycap('v'),
      pbtn('close', 'Slackタイムラインを隠す（v）', () => this.toggle(false))), h('div', { class: 'slack-controls' }, choices, query), feed,
      h('p', { class: 'slack-notice', text: '履歴は紐づけたメッセージの観測した変更のみ。未接続中の全変更は復元できません。' }));
    this.paintMessages(); feed.scrollTop = scroll;
    if (focusedKey) [...feed.querySelectorAll('[data-slack-key]')].find(el => el.dataset.slackKey === focusedKey)?.focus({ preventScroll: true });
  },
  paintMessages() {
    if (!this.feed) return;
    const messages = this.data.messages.filter(m => (!this.filter || `${m.team}:${m.channel}` === this.filter) && (!this.query || `${m.text} ${m.author} ${m.channelName}`.toLocaleLowerCase().includes(this.query.toLocaleLowerCase())));
    const nodes = messages.slice(0, this.shown).map((m, i) => this.message(m, i));
    if (!this.data.workspaces.length) nodes.push(h('p', { class: 'slack-notice', text: '管理の「Slack接続」から個人用Slackを接続してください。' }));
    else if (!messages.length) nodes.push(h('p', { class: 'slack-notice', text: '読む会話を選ぶか、本文を取得してください。' }));
    if (messages.length > this.shown) nodes.push(h('button', { class: 'btn', text: 'さらに50件表示', onclick: () => { this.shown += 50; this.paintMessages(); } }));
    for (const w of this.data.workspaces) for (const c of w.channels) if (!this.filter || this.filter === `${w.id}:${c.id}`) {
      nodes.push(h('div', { class: 'slack-actions' },
        h('button', { class: 'link-btn', text: `${c.name}を更新`, onclick: e => this.fetchHistory(e.currentTarget, w.id, c.id) }),
        h('button', { class: 'link-btn', text: '過去を読む', disabled: !this.data.cursors?.[`${w.id}:${c.id}`], title: this.data.cursors?.[`${w.id}:${c.id}`] ? '以前のメッセージを取得' : '取得できる過去のページはありません', onclick: e => this.fetchHistory(e.currentTarget, w.id, c.id, true) })));
    }
    this.feed.replaceChildren(...nodes);
  },
  async fetchHistory(button, workspaceId, channelId, more = false) {
    button.disabled = true; try { this.data = await this.call('history', { workspaceId, channelId, more }); this.filter = `${workspaceId}:${channelId}`; if (more) this.shown = 500; this.signature = null; this.paint(); }
    catch (error) { toast(error.message, true); } finally { button.disabled = false; }
  },
  message(m, index = 0) {
    const card = h('article', { class: `slack-message${index > 8 ? ' deferred' : ''}`, tabindex: 0, 'data-slack-key': m.key,
      role: 'listitem', 'aria-label': `${m.workspace} ${m.channelName} ${m.author}`, onfocus: () => { this.selected = m; } },
      h('div', { class: 'slack-origin', text: `Slack · ${m.workspace} / ${m.channelName}` }),
      h('strong', { text: m.author }), h('span', { class: 'slack-origin', text: ` · ${fmtDate(Number(m.ts)*1000)}${m.deleted ? ' · 削除済み' : ''}` }),
      m.text.length > 600 ? h('details', {}, h('summary', { text: `${m.text.slice(0,120)}…` }), h('p', { class: 'slack-body', text: m.text })) : h('p', { class: 'slack-body', text: m.text }),
      (m.files || []).map(f => h('button', { class: 'link-btn slack-ref', text: f.name, onclick: () => bridge.openLink(f.url) })),
      h('div', { class: 'slack-actions' },
        h('button', { class: 'btn', onclick: () => this.create(m) }, 'タスクにする ', keycap('c')),
        h('button', { class: 'btn', onclick: e => this.link(e.currentTarget, m) }, 'カードに追加 ', keycap('l')),
        h('button', { class: 'link-btn', onclick: () => this.thread(card, m) }, '返信 ', keycap('t')),
        h('button', { class: 'link-btn', text: 'Slackで開く', onclick: () => bridge.openLink(m.url) })),
      (m.refs || []).map(ref => h('button', { class: 'link-btn slack-ref', text: `関連: ${ref.title}`, onclick: () => openCard(ref.id) })));
    card._slackMessage = m;
    const expanded = this.threads?.get(m.key); if (expanded) { const area = h('div', { class: 'slack-thread' }); card.append(area); this.paintThread(area, m, expanded); }
    return card;
  },
  async create(message) {
    await taskQuickAdd.open({ slackMessage: message });
  },
  async link(anchor, message) {
    try {
      const board = await bridge.callTool('canban_get_board', { days: 0, includeHidden: true, includeArchived: true });
      const items = [...new Map(board.lists.flatMap(l => l.cards.flatMap(c => [c, ...(c.links || [])])).map(c => [c.id,c])).values()];
      const article = [...(this.el?.querySelectorAll('[data-slack-key]') || [])].find(n => n.dataset.slackKey === message.key);
      anchor = article?.querySelector('.slack-actions .btn:nth-child(2)') || anchor; anchor.scrollIntoView({ block: 'nearest' });
      picker(anchor, { title: 'Slackメッセージを追加するカード', items: items.map(c => ({ value: c.id, label: c.title })), onPick: async cardId => {
        try { await this.call('link', { cardId, key: message.key }); await load(); await this.refresh(); toast('Slack資料を追加しました'); }
        catch (error) { toast(error.message, true); }
      } });
    } catch (error) { toast(error.message, true); }
  },
  async thread(node, message) {
    this.threads ||= new Map();
    if (this.threads.has(message.key)) { this.threads.delete(message.key); node.querySelector('.slack-thread')?.remove(); return; }
    const area = h('div', { class: 'slack-thread', role: 'list', text: '返信を取得しています…' }); node.append(area);
    await this.readThread(area, message);
  },
  async readThread(area, message, cursor = '') {
    try {
      const data = await this.call('history', { workspaceId: message.team, channelId: message.channel, threadTs: message.threadTs, cursor });
      const previous = cursor ? this.threads.get(message.key)?.messages || [] : [];
      const result = { messages: [...new Map([...previous, ...data.messages].filter(m => m.key !== message.key).map(m => [m.key,m])).values()], cursor: data.cursor };
      this.threads.set(message.key,result); this.paintThread(area,message,result);
    } catch (error) { area.textContent = error.message; }
  },
  paintThread(area, message, result) {
    area.replaceChildren(...result.messages.map(m => this.message(m)));
    if (!result.messages.length) area.append(h('p', { text: '返信はありません。' }));
    if (result.cursor) area.append(h('button', { class: 'btn', text: 'さらに返信を読む', onclick: e => { e.currentTarget.disabled = true; this.readThread(area,message,result.cursor); } }));
  },
  sources(cardId, input) {
    const area = h('div', { class: 'slack-sources', text: 'Slack資料を取得しています…' });
    const refresh = async () => {
      try { const { sources } = await this.call('sources', { cardId });
        area.replaceChildren(...sources.map(source => {
          const versions = h('div'); let before = null;
          const readVersions = async () => {
            try { const data = await this.call('revisions', { key: source.key, ...(before ? { before } : {}) });
              const more = versions.querySelector('button'); more?.remove();
              versions.append(...data.revisions.map(v => h('div', { class: 'slack-source' },
                h('span', { class: 'slack-origin', text: `${fmtDate(v.observedAt)} · ${v.reason}${v.deleted ? ' · 削除済み' : ''}` }), h('p', { class: 'slack-body', text: v.text }))));
              before = data.before;
              if (before) versions.append(h('button', { class: 'link-btn', text: '以前の履歴を読む', onclick: readVersions }));
            } catch (error) { toast(error.message,true); }
          };
          let loaded = false;
          const history = h('details', { ontoggle: e => { if (e.target.open && !loaded) { loaded = true; readVersions(); } } }, h('summary', { text: `履歴 ${source.versions}件` }), versions);
          return h('section', { class: 'slack-source' },
            h('strong', { text: `Slack · ${source.workspace} / ${source.channelName}${source.deleted ? ' · Slackで削除済み' : ''}` }),
            h('p', { class: 'slack-origin', text: `${source.author} · 保存確認 ${fmtDate(source.observedAt)}` }),
            h('p', { class: 'slack-body', text: source.text }),
            (source.files || []).map(f => h('button', { class: 'link-btn slack-ref', text: f.name, onclick: () => bridge.openLink(f.url) })),
            h('div', { class: 'slack-actions' }, h('button', { class: 'link-btn', text: 'Slackで開く', onclick: () => bridge.openLink(source.url) }),
              input ? h('button', { class: 'btn slack-add-prompt', title: 'Alt+sでこのボタンへ移動し、Enterで追加', onclick: () => {
                const text = `Slack資料（外部の会話）\n${source.workspace} / ${source.channelName} / ${source.author}\n保存確認: ${fmtDate(source.observedAt)}\n${source.url}\n${source.deleted ? 'Slackで削除済み。最後に保存した本文:\n' : ''}${source.text}${source.files?.length ? '\n'+source.files.map(f => `${f.name}: ${f.url}`).join('\n') : ''}`;
                if ((input.value + '\n\n' + text).length > 20000) return toast('依頼文は20000文字までです。本文を選んで追加してください', true);
                input.value = [input.value, text].filter(Boolean).join('\n\n'); input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
              } }, '依頼文に追加 ', keycap('Alt+s'), keycap('Enter')) : null,
              h('button', { class: 'link-btn', text: '紐づけを外す', onclick: async () => {
                try { await this.call('unlink', { cardId, key: source.key }); await refresh(); await load(); await this.refresh(); } catch (error) { toast(error.message,true); }
              } })), history);
        }));
        if (!sources.length) area.textContent = 'Slack資料はありません。';
        area.append(h('button', { class: 'link-btn', text: '保存済み資料を更新', onclick: refresh }));
      } catch (error) { area.textContent = error.message; }
    }; refresh(); return area;
  },
  async settings(body) {
    const generation = body._slackGeneration = (body._slackGeneration || 0) + 1;
    body.textContent = 'Slack接続を取得しています…';
    try {
      this.data = await this.call('view'); if (generation !== body._slackGeneration || !body.isConnected) return; body.replaceChildren();
      body.append(h('p', { class: 'page-help', text: '個人用Slackアプリの読み取り権限で接続します。認証情報はこのMacのCanban保存先に保管します。' }),
        h('button', { class: 'link-btn', text: 'Slackアプリの設定を開く', onclick: () => bridge.openLink('https://api.slack.com/apps') }));
      const userToken = h('input', { class: 'text-input', type: 'password', autocomplete: 'off', 'aria-label': 'Slackユーザートークン', placeholder: 'ユーザートークン（xoxp-）' });
      const appToken = h('input', { class: 'text-input', type: 'password', autocomplete: 'off', 'aria-label': 'Slack Appトークン', placeholder: 'Appトークン（xapp-）' });
      const feedback = h('p', { role: 'status', class: 'page-help' });
      const connect = h('button', { class: 'btn-primary', text: '接続を保存', onclick: async () => {
        connect.disabled = true; try { await this.call('connect', { userToken: userToken.value.trim(), appToken: appToken.value.trim() }); userToken.value = appToken.value = ''; await this.settings(body); }
        catch (error) { feedback.textContent = error.message; } finally { connect.disabled = false; }
      } });
      body.append(h('section', { class: 'page-panel slack-setup' }, h('h3', { text: 'ワークスペースを追加・再接続' }),
        h('label', {}, 'ユーザートークン', userToken), h('label', {}, 'Socket Mode用Appトークン', appToken), connect, feedback));
      for (const w of this.data.workspaces) {
        const panel = h('section', { class: 'page-panel' }, h('h3', { text: w.name }), h('p', { class: 'page-help', text: this.data.status[w.id]?.state || '待機' }));
        const editor = h('div');
        panel.append(h('button', { class: 'btn', text: '読む会話とカテゴリを選ぶ', onclick: () => this.channelSettings(editor, w) }), editor, h('button', { class: 'link-btn', text: '接続を解除', onclick: async () => {
          if (!confirmInline(panel, 'このMacの接続と認証情報を削除します。カードに保存した資料は残ります。')) return;
          try { await this.call('disconnect', { workspaceId: w.id }); await this.settings(body); await this.refresh(); } catch (error) { toast(error.message,true); }
        } })); body.append(panel);
      }
      body.append(h('button', { class: 'link-btn', text: '保存した履歴を管理', onclick: async e => {
        const button = e.currentTarget; button.disabled = true;
        try { const { sources } = await this.call('retained'); body.querySelector('.slack-retained')?.remove(); const list = h('div', { class: 'slack-retained' });
          for (const source of sources) {
            const row = h('div', { class: 'slack-source' }, h('span', { text: `${source.workspace} / ${source.channelName}: ${source.text.slice(0,80)}（${source.versions}版）` }));
            row.append(source.refs.length ? h('span', { class: 'muted', text: ` · ${source.refs.length}枚のカードで使用中` }) : h('button', { class: 'link-btn', text: '履歴を削除', onclick: async () => {
              if (!confirmInline(row, 'Canbanに保存した本文と履歴を削除します。Slackのメッセージは変更しません。')) return;
              try { await this.call('forget', { key: source.key }); row.remove(); } catch (error) { toast(error.message,true); }
            } })); list.append(row);
          }
          if (!sources.length) list.textContent = '保存した履歴はありません。'; button.after(list);
        } catch (error) { toast(error.message,true); } finally { button.disabled = false; }
      } }));
      workspace.trackDrafts(body);
    } catch (error) { body.textContent = error.message; }
  },
  async channelSettings(body, workspace) {
    const selected = new Map(workspace.channels.map(c => [c.id,{...c}]));
    const rows = h('div'), query = h('input', { class: 'text-input', type: 'search', 'aria-label': 'Slackの会話を絞り込む', placeholder: '会話名を絞り込む', oninput: e => {
      for (const row of rows.children) row.hidden = !row.dataset.name.toLocaleLowerCase().includes(e.target.value.toLocaleLowerCase());
    } });
    const addRows = channels => { for (const channel of channels) {
      if ([...rows.children].some(r => r.dataset.channel === channel.id)) continue;
      const check = h('input', { type: 'checkbox', checked: selected.has(channel.id), onchange: e => {
        body.dataset.unsavedForm = 'true'; if (e.target.checked) selected.set(channel.id, { ...channel, directory: directory.value }); else selected.delete(channel.id);
      } });
      const directory = h('select', { 'aria-label': `${channel.name}のカテゴリ`, onchange: e => { body.dataset.unsavedForm = 'true'; if (e.target.value !== '__new' && selected.has(channel.id)) selected.get(channel.id).directory = e.target.value; } },
        h('option', { value: '__none', text: '未分類' }), state.board.directories.map(d => h('option', { value: d.id, text: d.name })), h('option', { value: '__new', text: '＋ カテゴリ' }));
      directory.value = selected.get(channel.id)?.directory || '__none';
      directory.addEventListener('change', e => { if (e.target.value === '__new') {
        const form = h('form', {}, h('input', { class: 'text-input', 'aria-label': '新しいカテゴリ名', placeholder: 'カテゴリ名' }), h('button', { class: 'btn', text: '追加' }));
        form.onsubmit = async event => { event.preventDefault(); const name = form.querySelector('input').value.trim(); if (!name) return;
          try { const response = await bridge.callTool('canban_create_directory', { name }); const category = response.result || response; state.board.directories.push(category);
            directory.add(h('option', { value: category.id, text: category.name })); directory.value = category.id; check.checked = true; selected.set(channel.id, { ...channel, directory: category.id }); form.remove();
          } catch (error) { toast(error.message, true); }
        }; directory.after(form); directory.value = selected.get(channel.id)?.directory || '__none'; form.querySelector('input').focus();
      } });
      rows.append(h('div', { class: 'slack-channel-row', 'data-channel': channel.id, 'data-name': channel.name }, h('label', {}, check, ` ${channel.name}`), directory));
    } };
    let cursor = ''; const more = h('button', { class: 'btn', text: '会話を取得', onclick: async () => {
      more.disabled = true; try { const result = await this.call('channels', { workspaceId: workspace.id, cursor }); addRows(result.channels); cursor = result.cursor; more.textContent = cursor ? 'さらに会話を取得' : '取得済み'; more.hidden = !cursor; }
      catch (error) { toast(error.message,true); } finally { more.disabled = false; }
    } });
    addRows(workspace.channels); body.replaceChildren(query, rows, more, h('button', { class: 'btn-primary', text: '読む会話を保存', onclick: async () => {
      try { this.data = await this.call('select', { workspaceId: workspace.id, channels: [...selected.values()] }); this.paint(); body.dataset.unsavedForm = 'false'; workspace.trackDrafts(body); toast('読む会話を保存しました'); }
      catch (error) { toast(error.message,true); }
    } }));
  },
};
setInterval(() => { if (slackUi.visible && document.visibilityState === 'visible') slackUi.refresh(); }, 30000);
document.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.isComposing || document.querySelector('.popover, dialog[open]')) return;
  if (e.altKey && e.code === 'KeyS' && !e.metaKey && !e.ctrlKey) { const button = focusedPane()?.el.querySelector('.slack-add-prompt'); if (button) { e.preventDefault(); button.focus(); } return; }
  if (e.key === 'Escape' && e.target.closest?.('.slack-timeline')) { e.preventDefault(); slackUi.toggle(false); return; }
  if (typingIn(e.target)) return;
  const message = e.target.closest?.('.slack-message'); if (!message || e.metaKey || e.ctrlKey || e.altKey) return;
  const selected = message._slackMessage; if (!selected) return;
  if (e.key === 'c') { e.preventDefault(); slackUi.create(selected); }
  else if (e.key === 'l') { e.preventDefault(); slackUi.link(e.target,selected); }
  else if (e.key === 't') { e.preventDefault(); slackUi.thread(message,selected); }
  else if (e.key === 'Escape') { e.preventDefault(); slackUi.toggle(false); }
}, true);

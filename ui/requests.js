// Part of board.html: included into its script by server/ui.mjs and shares its scope.
// Requests: sending prompts to a session (one headless turn each)
const REQ_ICONS = { queued: '⏳', starting: '▶', running: '▶', succeeded: '✓', failed: '✗', cancelled: '⊘', interrupted:'⏹',blocked:'⏸' };
const REQ_LABELS = { queued: '待機中', starting: '開始中', running: '実行中', succeeded: '完了', failed: '失敗', cancelled: '取り消し', interrupted:'停止',blocked:'競合のため停止' };

function requestPill(r) {
  if (r.running) return h('span', { class: 'pill', title: 'Canban から送った指示を実行中', text: `▶ 実行中${r.queued ? `・待機 ${r.queued}` : ''}` });
  if (r.paused) return h('span', { class: 'pill due-over', title: 'キューが一時停止しています（詳細で再開）', text: `⏸ 待機 ${r.queued}` });
  return h('span', { class: 'pill', title: 'セッションが空いたら順に送ります', text: `📨 ${r.queued}` });
}

function keepDisabledPrompt(box, value) {
  if (!box) return;
  const input = h('textarea', { 'aria-label': '送るプロンプト', readonly: true });
  workspace.draftValues.set(input, ''); input.value = value; box.append(input);
}
function replaceDispatch(old, d) {
  if (old.querySelector('.req-row textarea, .prompt-skill-picker:not([hidden]), .prompt-composer[aria-busy="true"]')) return;
  const draft = old.querySelector('textarea[aria-label="送るプロンプト"]')?.value || '';
  const stored = promptDrafts.get(`dispatch:${d.session.id}`);
  if (stored) stored.text = draft;
  const next = renderDispatch(d), input = next.querySelector('.send-box textarea');
  if (input) { workspace.trackDrafts(next); input.value = draft; }
  // If sending has been disabled, retain the draft next to the reason.
  else if (draft) keepDisabledPrompt(next, draft);
  old.replaceWith(next);
}
function renderDispatch(d) {
  const s = d.session;
  const D = d.dispatch;
  const box = h('div', { class: 'send-section' });
  const title = h('div', { class: 'section-title', text: '指示を送る' });
  if (!D.settings.enabled) {
    box.append(title, h('div', { class: 'muted', text: '指示の送信は設定でオフになっています（⚙ 設定）。' }));
    return box;
  }
  const p = D.permission;
  const permChip = p
    ? h('span', { class: `perm-chip${p.elevated ? ' elevated' : ''}`, title: `このセッションの設定を引き継ぎます（${p.source === 'session' ? 'セッションの記録' : p.source === 'database' ? 'Codex の DB' : '読み取れないため最も制限的な設定'}）`,
      text: `${p.elevated ? '⚠ 制限なし: ' : '🔒 '}${p.label}` })
    : h('span', { class: 'perm-chip', text: s.host ? '🔒 権限は送信時にリモートで確認します' : '🔒 権限を確認できません' });
  const ta = h('textarea', { placeholder: 'このセッションに送るプロンプト（⌘/Ctrl + Enter で今すぐ送信）', 'aria-label': '送るプロンプト' });
  const ack = p?.elevated ? h('input', { type: 'checkbox', 'aria-label': '制限なしで実行されることを確認しました' }) : null;
  const busy = s.status === 'running' || s.status === 'waiting' || !!s.codexFollowUps;
  const composer = promptComposer(ta, { key: `dispatch:${s.id}`, context: () => ({ cardId: s.id }), submit: () => send(busy ? 'queue' : 'now'), chips: true });
  const sendButtons = [];
  const send = async (when) => {
    const prompt = ta.value.trim();
    if (!composer.hasContent()) return ta.focus();
    if (composer.draft.sending) return;
    try {
      const payload = composer.payload();
      composer.setSending(true); sendButtons.forEach(b => { b.disabled = true; });
      await claudeExecutionPending.get(s.id);
      await bridge.callTool('canban_dispatch', { cardId: s.id, prompt, ...payload, when, expectedUpdatedAt: s.updatedAt || null, allowElevated: !!ack?.checked });
      composer.clear();
      toast(when === 'now' ? '送信しました' : 'キューに追加しました');
      openCard(s.id);
      load();
    } catch (e) {
      if (e.code === 'elevated') { toast(e.message, true); ack?.focus(); return; }
      if (e.code === 'conflict') { toast(e.message,true); return; }
      if (e.code === 'busy') return toast(`${e.message}。入力は保持しています。状態を確認してから再操作してください。`,true);
      toast(e.message, true);
    } finally {
      composer.setSending(false); sendButtons.forEach(b => { b.disabled = busy; });
    }
  };
  // One round button sends; while the session is busy it queues instead. Alt+Enter always queues.
  const round = h('button', { class: 'send-round', type: 'button', title: busy ? 'キューに追加（⌘Enter）' : '今すぐ送信（⌘Enter）', 'aria-label': busy ? 'キューに追加' : '今すぐ送信', html: picon(busy ? 'queue' : 'send', 15), onclick: () => send(busy ? 'queue' : 'now') });
  sendButtons.push(round);
  if (!busy) sendButtons.unshift(h('button', { class: 'cx-ico', type: 'button', title: 'キューに追加（⌥Enter）', 'aria-label': 'キューに追加', html: picon('queue', 16), onclick: () => send('queue') }));
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.altKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send('queue'); } });
  const appNote = s.agent === 'codex' || s.desktopSessionId || s.entrypoint === 'claude-desktop'
    ? helpTip(`${s.agent === 'codex' ? 'Codex' : 'Claude'} アプリでこのセッションを開いている場合は、閉じてから送ってください（アプリ側の表示と履歴がずれることがあります）。`) : null;
  composer.toolbar.append(permChip, h('span', { class: 'grow' }), appNote, ...sendButtons);
  box.append(...[
    D.paused ? h('div', { class: 'paused-bar' }, h('span', { class: 'grow', text: `⏸ キュー一時停止: ${D.paused.reason}` }),
      h('button', { class: 'link-btn', text: '再開', onclick: () => act('canban_resume_queue', { cardId: s.id }, { okMsg: 'キューを再開しました' }).then(() => openCard(s.id)) })) : null,
    D.active.length || D.queue.length ? h('div', { class: 'cx-reqs' }, ...D.active.map((r) => requestRow(s, r)), ...D.queue.map((r, i) => requestRow(s, r, { index: i, queue: D.queue }))) : null,
    h('div', { class: 'send-box cx' }, composer.root,
      ack ? h('label', { class: 'send-note row', style: { gap: '6px' } }, ack, 'このセッションはサンドボックス／確認なしで動いています。そのまま実行されることを確認しました') : null,
      busy ? h('div', { class: 'muted cx-busy', text: s.codexFollowUps
        ? `Codex アプリのキューにフォローアップが ${s.codexFollowUps} 件あります。二重に送らないよう、アプリ側で送るか消すまで Canban からは送りません。`
        : `セッションが${s.status === 'running' ? '実行中' : '入力待ち'}です。送ると順番待ちに入ります。` }) : null),
    h('div', { class: 'cx-keys' }, keyHint(['⌘', 'Enter'], busy ? 'キューへ' : '送信'), keyHint(['⌥', 'Enter'], 'キューへ'), keyHint(['$'], 'スキル')),
    D.history.length ? h('details', { class: 'cx-hist' }, h('summary', { text: `依頼の履歴（${D.history.length}）` }),
      ...D.history.map((r) => requestRow(s, r, { review: () => { try { composer.restore(r); toast('実行状況を確認し、内容を確認してから送信してください。'); } catch (e) { toast(e.message, true); } } }))) : null,
  ].filter(Boolean));
  return box;
}

function requestRow(s,r,{index=-1,queue=[],review=null}={}) {
  const who = r.origin === 'model' ? '🤖 ' : '';
  const when = r.endedAt ? `${relTime(r.endedAt)}${r.startedAt ? `・${Math.max(1, Math.round((r.endedAt - r.startedAt) / 1000))} 秒` : ''}` : r.startedAt ? `${relTime(r.startedAt)}から` : relTime(r.createdAt);
  const btns = h('div', { class: 'req-btns' });
  const refresh = () => openCard(s.id);
  if (r.state === 'queued') {
    const move = (dir) => {
      const other = queue[index + dir];
      if (!other) return;
      const order = dir < 0 ? (queue[index - 2] ? (queue[index - 2].order + other.order) / 2 : other.order - 1000) : (queue[index + 2] ? (queue[index + 2].order + other.order) / 2 : other.order + 1000);
      act('canban_update_request', { requestId: r.id, order }, { reload: false }).then(refresh);
    };
    btns.append(...[
      index > 0 ? h('button', { title: '前へ', 'aria-label': '前へ', text: '↑', onclick: () => move(-1) }) : null,
      index < queue.length - 1 ? h('button', { title: '後ろへ', 'aria-label': '後ろへ', text: '↓', onclick: () => move(1) }) : null,
      h('button', { text: '編集', onclick: (e) => editRequest(e.currentTarget.closest('.req-row'), r, refresh) }),
      h('button', { text: '取消', onclick: () => act('canban_cancel_request', { requestId: r.id }, { okMsg: '取り消しました' }).then(refresh) })].filter(Boolean));
  } else if (r.state === 'running' || r.state === 'starting') {
    btns.append(h('button', { text: '⏹ 停止', onclick: () => act('canban_stop_request', { requestId: r.id }, { okMsg: '停止を送りました' }).then(refresh) }));
  }
  if (review && ['blocked','interrupted','failed'].includes(r.state)) btns.append(h('button',{text:'再送内容を確認',onclick:review}));
  if (r.logPath) btns.append(h('button', { title: '実行ログのパスをコピー', text: '⧉ ログ', onclick: () => copyText(r.logPath, 'ログのパス') }));
  const result = r.resultText || r.error;
  return h('div', { class: 'req-row' },
    h('span', { class: `req-state ${r.state}`, title: REQ_LABELS[r.state], text: REQ_ICONS[r.state] || '•' }),
    h('div', { class: 'grow' },
      h('div', { class: 'req-prompt', text: r.prompt }),
      r.images?.length || r.skills?.length ? h('div', { class: 'muted', text: [...(r.images || []).map(i => `画像: ${i.name}`), ...(r.skills || []).map(s => `$${s.name}`)].join(' / ') }) : null,
      h('div', { class: 'muted', text: `${who}${REQ_LABELS[r.state]}・${when}${r.state === 'queued' && r.blockedReason ? `・${r.blockedReason}` : ''}` }),
      result ? h('details', {}, h('summary', { text: r.error ? `エラー: ${r.error.split('\n')[0].slice(0, 80)}` : `結果: ${r.resultText.split('\n')[0].slice(0, 80)}` }), h('div', { class: 'msg', text: result })) : null),
    btns);
}

function editRequest(row, r, done) {
  const ta = h('textarea', { 'aria-label': 'プロンプトを編集' });
  ta.value = r.prompt;
  const save = () => act('canban_update_request', { requestId: r.id, prompt: ta.value }, { reload: false, okMsg: '保存しました' }).then(done);
  row.replaceChildren(h('div', { class: 'send-box grow' }, ta, h('div', { class: 'send-actions' },
    h('button', { class: 'btn-primary', text: '保存', onclick: save }), h('button', { class: 'link-btn', text: 'キャンセル', onclick: done }))));
  ta.focus();
}

// While a request is queued or running, refresh the section every few seconds.
function watchRequests(modal, d) {
  clearInterval(modal._reqTimer);
  if (!d.dispatch.active.length && !d.dispatch.queue.length) return;
  modal._reqTimer = setInterval(async () => {
    if (!document.body.contains(modal) || workspace.hasDrafts(modal) || modal.querySelector('.send-box textarea:focus, .req-row textarea')) {
      if (!document.body.contains(modal)) clearInterval(modal._reqTimer);
      return;
    }
    try {
      const res = await bridge.callTool('canban_list_requests', { cardId: d.session.id, limit: 30 });
      const sig = (list) => list.map((r) => `${r.id}:${r.state}`).join(',');
      const cur = [...d.dispatch.active, ...d.dispatch.queue, ...d.dispatch.history];
      if (sig(res.requests.slice().sort((a, b) => a.id.localeCompare(b.id))) !== sig(cur.slice().sort((a, b) => a.id.localeCompare(b.id)))) {
        clearInterval(modal._reqTimer);
        openCard(d.session.id);
        load();
      }
    } catch {}
  }, 4000);
}

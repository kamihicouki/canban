// Accounts (included into board.html's script by server/ui.mjs; shares its scope).
// Everything the board shows about accounts: the usage rings on the account button, card
// chips, the 👤 menu (filter, header visibility, name / initial / color, config
// folders) and the small hooks board.html calls. Server side: server/accounts*.mjs.

// ---- hooks called from board.html ----
function renderAccountsButton(b) {
  const active = state.filters.account === '__none' ? { label: 'アカウント不明' } : (b.accounts?.accounts || []).find((a) => a.key === state.filters.account);
  $('#accountsBtn .acct-lbl').textContent = active ? active.label : '';
  $('#accountsBtn').setAttribute('aria-pressed', String(!!active));
  renderUsage(b.accounts);
  ensureUsageRefreshTimer();
}
// The live watch sends fresh Codex limits per account.
function applyAccountLimits(list) {
  if (!list || !state.board?.accounts) return;
  for (const l of list) { const a = state.board.accounts.accounts.find((x) => x.key === l.key); if (a) a.limits = l; }
  renderUsage(state.board.accounts);
  workspace.renderLimitChip(state.board.limits);
  if (openViewKind() === 'usage') refreshViews();
}
function accountKv(s) {
  return [...(s.host ? [] : kv('アカウント', s.accountLabel || '不明（記録なし）')), ...(s.homeDir ? kv('設定フォルダ', s.homeDir) : [])];
}
function accountLaneKey(card) {
  if (card.account) return `${card.agent === 'codex' || card.account.startsWith('codex:') ? 'Codex' : 'Claude'} · ${accountLabel(card.account)}`;
  if (card.host) return `⌂ ${card.host.label}`;
  return card.account ? `${card.agent === 'codex' ? 'Codex' : 'Claude'} · ${accountLabel(card.account)}` : 'アカウント不明';
}
function accountsPanel(st, legend, tip) {
  return st.accounts?.length ? h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', { text: 'アカウント別' }), legend.cloneNode(true)), breakdownRows(st.accounts, tip)) : null;
}

// ---- usage ----
function fmtReset(ms) {
  if (!ms) return '';
  const d = ms - Date.now();
  if (d <= 0) return 'リセット済み';
  const totalMinutes = Math.ceil(d / 60e3), hrs = Math.floor(totalMinutes / 60), min = totalMinutes % 60;
  return hrs >= 24 ? `${new Date(ms).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} にリセット` : `あと ${hrs ? `${hrs} 時間 ` : ''}${min} 分でリセット`;
}
function windowName(w) { return !w.windowMinutes ? '' : w.windowMinutes >= 1440 ? (w.windowMinutes === 10080 ? '週' : `${Math.round(w.windowMinutes / 1440)}日`) : `${Math.round(w.windowMinutes / 60)}h`; }
// Usage per account in the header: Codex rate limits (from its logs) and Claude plan
// usage (from the desktop app), one group per account that has a record.
function usageWindows(l) { return l ? [l.primary, l.secondary].filter(Boolean) : []; }
function usageTitle(a) {
  const l = a.limits;
  const ws = usageWindows(l).map(w => usageWindow(w, l.at)).filter(Boolean);
  return [`${a.agent === 'codex' ? 'Codex' : 'Claude'}: ${a.label}${a.plan ? `（${a.plan}）` : ''}`,
    ...ws.map(w => `${w.label}: ${w.stale ? '要更新' : `${w.used}% 使用・残り ${w.remaining}%`}${w.resetsAt ? ` · ${fmtReset(w.resetsAt)}` : ''}`),
    l ? `${fmtDate(l.at)} 時点（${l.source === 'live' ? 'サービスから取得' : l.source === 'desktop' ? 'Claude Desktopの記録' : 'セッションログ'}）` : '未取得',
    a.usage?.status === 'error' ? ACCOUNT_USAGE_ERRORS[a.usage.code] || ACCOUNT_USAGE_ERRORS.unavailable : null].filter(Boolean).join('\n');
}
function usageBars(l, cls = 'lm') {
  return usageWindows(l).map(w => usageWindow(w, l.at)).filter(Boolean).map(w =>
    h('span', { class: cls }, h('span', { text: w.label }),
      w.stale ? h('span', { text: '前回値・要更新' }) : h('span', {}, h('span', { class: 'bar' },
        h('i', { class: heat(w.used), style: { width: `${w.used}%` } })), h('span', { text: `${w.used}% 使用` }))));
}
function shortWho(label) { return String(label || '').replace(/@.*$/, ''); }
function ringFor(a) {
  const l = a.limits || {};
  const windows = usageWindows(l).map(w => usageWindow(w, l.at)).filter(Boolean);
  const five = windows.find(w => w.label === '5時間枠' && !w.stale);
  const week = windows.find(w => w.label === '週間枠' && !w.stale);
  const col = w => w ? `var(--c-${heat(w.used) === 'hot' ? 'red' : heat(w.used) === 'warn' ? 'orange' : 'green'})` : 'transparent';
  const old = windows.some(w => w.stale);
  return h('span', { class: `ring2${five ? '' : ' no-a'}${week ? '' : ' no-b'}${old ? ' stale' : ''}${a.limits ? '' : ' none'}`, title: usageTitle(a),
    style: { '--a': five ? Math.min(100, five.used) : 0, '--b': week ? Math.min(100, week.used) : 0, '--ca': col(five), '--cb': col(week) } },
    h('b', { class: 'ini', style: { background: colorVar(a.color) }, text: a.short }),
    h('i', { class: `agm ${a.agent}` }));
}
// The account button carries one ring per account shown in the header (settings in its menu).
function renderUsage(v) {
  const box = $('#acctRings');
  if (!box) return;
  const list = (v?.accounts || []).filter((a) => a.inHeader && (a.limits || a.count || a.signedIn.length));
  box.replaceChildren(...list.map(ringFor));
  $('#accountsBtn').title = list.length ? `${list.map(usageTitle).join('\n\n')}\n\nクリックでアカウント一覧・表示の設定` : 'アカウント・使用量・設定フォルダ';
  fitHeader();
}
function accountLabel(key) {
  return (state.board?.accounts?.accounts || []).find((a) => a.key === key)?.label || String(key || '').split(':').slice(1).join(':').slice(0, 8);
}
// Only worth a chip when there is more than one account.
function acctChip(card) {
  if (!card.account || (state.board?.accounts?.accounts || []).length < 2) return null;
  const a = state.board.accounts.accounts.find((x) => x.key === card.account);
  const label = accountLabel(card.account);
  return h('span', { class: 'acct-chip', title: `アカウント: ${label}${card.home ? `（設定フォルダ: ${card.home}）` : ''}` },
    a ? h('span', { class: 'acct-dot', style: { background: colorVar(a.color), width: '13px', height: '13px', fontSize: '8px', marginRight: '3px' }, text: a.short }) : null, shortWho(label));
}

const ACCOUNT_USAGE_ERRORS = { login_required: '最新取得にはログインが必要です', unsupported: 'このプランの使用量は取得できません', identity_changed: 'アカウントが変わりました。ログインを確認してください', unavailable: '取得できませんでした。もう一度更新してください', timeout: '取得に時間がかかりました。もう一度更新してください', rate_limited: '時間をおいて更新してください' };
let accountUsageTimer = null;
const accountRefreshBusy = new Set();
function ensureUsageRefreshTimer() {
  if (accountUsageTimer) return;
  accountUsageTimer = setInterval(() => {
    if (!document.hidden && state.board?.accounts?.refresh?.enabled) refreshAccountUsage({ automatic: true });
  }, 30000);
}
// Weekly pacing uses the provider's rolling reset, not calendar weeks.
function weeklyUsagePace(value, at, failed = false, now = Date.now()) {
  if (value?.windowMinutes !== 10080) return null;
  const w = usageWindow(value, at, now);
  const duration = 10080 * 60000;
  if (!w || w.stale || failed || !Number.isFinite(value.resetsAt)
    || value.resetsAt <= now || value.resetsAt > now + duration) return { unavailable: true };
  const elapsed = now - (value.resetsAt - duration);
  const target = elapsed / duration * 100;
  const delta = value.usedPercent - target;
  const kind = delta > 5 ? 'ahead' : delta < -5 ? 'room' : 'steady';
  const status = kind === 'ahead' ? '使いすぎ' : kind === 'room' ? '余裕あり' : '順調';
  const gap = `${Math.abs(delta).toFixed(1)}pt${delta >= 0 ? '多い' : '少ない'}`;
  return { target, kind, status, gap, elapsedDays: elapsed / 86400000, remainingDays: (duration - elapsed) / 86400000 };
}
function accountUsageContent(a) {
  const limits = a.limits;
  const windows = usageWindows(limits).map(value => ({ value, w: usageWindow(value, limits?.at) })).filter(({ w }) => w);
  if (!windows.length) return h('p', { class: 'muted acct-usage-empty', text: '使用量は未取得です' });
  return h('div', { class: `acct-usage-grid${windows.length === 1 ? ' single' : ''}${windows.some(({ value }) => value.windowMinutes === 10080) ? ' has-week' : ''}` }, ...windows.map(({ value, w }) => {
    const old = w?.stale || a.usage?.status === 'error';
    const pace = weeklyUsagePace(value, limits?.at, old);
    const description = pace && !pace.unavailable ? `今の目安 ${pace.target.toFixed(1)}%・${pace.status}・目安より${pace.gap}` : '';
    return h('div', { class: pace ? 'acct-week' : 'acct-short-window' },
      h('div', { class: 'acct-window-label' }, h('span', { text: w.label }),
        h('strong', { text: w ? `${old ? '前回 ' : ''}${Math.round(value.usedPercent)}%` : '未取得' })),
      h('div', { class: `acct-meter${old ? ' stale' : ''}`, ...(w ? { role: 'meter', 'aria-label': `${a.label} ${w.label}の使用率`, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': value.usedPercent, 'aria-valuetext': `${old ? '前回の値 ' : ''}${Math.round(value.usedPercent)}% 使用${old ? '・要更新' : ''}${description ? `・${description}` : ''}` } : {}) }, w ? h('i', { class: pace ? (pace.unavailable ? 'neutral' : `pace-${pace.kind}`) : heat(value.usedPercent), style: { width: `${value.usedPercent}%` } }) : null, pace && !pace.unavailable ? h('span', { class: 'acct-target', 'aria-hidden': 'true', style: { left: `${pace.target}%` } }) : null),
      pace ? h('div', { class: `acct-pace ${pace.kind || 'unavailable'}` },
        h('strong', { text: pace.unavailable ? '判定保留' : `${pace.status}・目安より${pace.gap}` }),
        h('span', { text: pace.unavailable ? 'リセット不明・古いデータは要更新' : `今の目安 ${pace.target.toFixed(1)}%（縦線）` }),
        pace.unavailable ? null : h('span', { class: 'muted', text: `${pace.elapsedDays.toFixed(1)}日経過 / あと${pace.remainingDays.toFixed(1)}日・基準14.3%/日` })) : null,
      h('span', { class: 'acct-reset muted', text: value?.resetsAt ? fmtReset(value.resetsAt) : w ? (old ? '要更新' : 'リセット時刻の記録なし') : '更新すると表示されます' }));
  }));
}
function accountUpdateText(a) {
  if (a.usage?.status === 'error') return `${ACCOUNT_USAGE_ERRORS[a.usage.code] || ACCOUNT_USAGE_ERRORS.unavailable}${a.limits?.at ? ` · 前回取得 ${relTime(a.limits.at)}` : ''}`;
  return a.limits?.at ? `取得 ${relTime(a.limits.at)}${a.limits.source === 'live' ? '' : ' · 記録から表示'}` : '使用量は未取得です';
}
function accountScheduleText(v) {
  if (!v?.refresh?.enabled) return '自動更新は停止中です';
  const due = (v.accounts || []).map(a => (a.usage?.attemptedAt || (a.limits?.source === 'live' ? a.limits.at : 0)) + v.refresh.intervalMinutes * 60000);
  if (!due.length) return `${v.refresh.intervalMinutes} 分ごとに取得します`;
  const seconds = Math.max(0, Math.ceil((Math.min(...due) - Date.now()) / 1000));
  return seconds ? `次の更新まで ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : 'まもなく更新します';
}
function updateAccountMenuUsage() {
  document.querySelectorAll('.acct-schedule').forEach(el => { el.textContent = accountScheduleText(state.board?.accounts); });
  for (const row of document.querySelectorAll('.acct-row[data-account-key]')) {
    const a = state.board?.accounts?.accounts.find((a) => a.key === row.dataset.accountKey);
    if (!a) continue;
    row.querySelector('.acct-usage-block')?.replaceChildren(accountUsageContent(a));
    const status = row.querySelector('.acct-update-status');
    if (status) { const text = accountUpdateText(a); if (status.textContent !== text) status.textContent = text; status.classList.toggle('acct-error', a.usage?.status === 'error'); }
    const refresh = row.querySelector('.acct-row-refresh');
    if (refresh) { refresh.disabled = accountRefreshBusy.has('*') || accountRefreshBusy.has(a.key); refresh.textContent = refresh.disabled ? '更新中…' : '更新'; }
    row.querySelector('.acct-auth-action')?.replaceChildren(...(a.usage?.code === 'login_required' || a.usage?.code === 'identity_changed'
      ? [h('button', { class: 'btn-primary', text: 'ログインして最新の使用量を取得', onclick: row._loginAction }),
        h('button', { class: 'btn', text: 'ターミナルでログイン', onclick: row._terminalLoginAction })] : []));
  }
}
async function refreshAccountUsage({ key, automatic = false } = {}) {
  if (accountRefreshBusy.has('*') || (key && accountRefreshBusy.has(key)) || (!key && accountRefreshBusy.size)) return;
  const busyKey = key || '*'; accountRefreshBusy.add(busyKey); updateAccountMenuUsage();
  document.querySelectorAll('.acct-refresh-all').forEach((b) => { b.disabled = true; b.textContent = '更新中…'; });
  try {
    const r = await bridge.callTool('canban_refresh_account_usage', { ...(key ? { key } : {}), automatic });
    if (r.result?.updated?.length) { await load(); updateAccountMenuUsage(); }
    if (!automatic && r.result?.updated?.some((x) => x.status === 'error')) toast('取得できないアカウントがあります。更新状態をご確認ください', true);
    if (!automatic && r.result?.busy?.length) toast('ほかの画面で更新中のアカウントがあります');
  } catch (e) { if (!automatic) toast(e.message, true); }
  finally {
    accountRefreshBusy.delete(busyKey); updateAccountMenuUsage();
    document.querySelectorAll('.acct-refresh-all').forEach((b) => { b.disabled = !!accountRefreshBusy.size; b.textContent = 'すべて更新'; });
  }
}

// ---- account menu ----
function accountsMenu(anchor) {
  const v = state.board?.accounts;
  if (!v) return;
  const pick = (key) => { workspace.navigate('home', { reload: false }); state.filters.account = state.filters.account === key ? '' : key; saveFilters(); closePopover(); load(); };
  const signedText = (a) => a.signedIn.map((x) => {
    if (x === 'desktop') return 'デスクトップ';
    if (x.startsWith('desktop:')) return `デスクトップ（${x.slice(8)}）`;
    const home = v.homes.find(h => h.agent === a.agent && h.id === x.slice(4));
    return v.profiles.some(p => p.dir === home?.dir) ? 'CLI（専用保存先）' : `CLI${x === 'cli:default' ? '' : `（${x.slice(4)}）`}`;
  }).join('・');
  // Name, initial and color: how the account reads in the header rings and on cards.
  const edit = (a, row) => {
    let color = a.color;
    const name = h('input', { class: 'text-input', value: a.customLabel || '', placeholder: a.email || a.name || a.label, maxlength: 60, 'aria-label': '表示名' });
    const short = h('input', { class: 'text-input', value: a.short, maxlength: 2, style: { width: '44px', textAlign: 'center' }, 'aria-label': 'リングの頭文字（2 文字まで）', title: 'リングの頭文字（2 文字まで）' });
    const sw = h('div', { class: 'acct-swatches', role: 'group', 'aria-label': '色' }, ...v.colors.map((c) => h('button', { 'aria-pressed': String(c === color), 'aria-label': COLOR_NAMES?.[c] || c, title: COLOR_NAMES?.[c] || c, style: { background: colorVar(c) },
      onclick: (e) => { color = c; row.dataset.unsavedForm = 'true'; sw.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); } })));
    const save = async () => {
      try {
        await act('canban_update_accounts', { label: { key: a.key, name: name.value.trim() } }, { reload: false });
        await act('canban_update_accounts', { mark: { key: a.key, short: short.value.trim(), color } }, { okMsg: '保存しました' });
      } catch { return; }
      accountsMenu(anchor);
    };
    for (const i of [name, short]) i.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) save(); if (e.key === 'Escape') accountsMenu(anchor); };
    row.replaceChildren(h('div', { class: 'grow', style: { display: 'grid', gap: '6px', padding: '4px 0' } },
      h('div', { class: 'row' }, name, short),
      h('div', { class: 'row' }, sw, h('span', { class: 'spacer' }), h('button', { class: 'btn', text: '取消', onclick: () => accountsMenu(anchor) }), h('button', { class: 'btn-primary', text: '保存', onclick: save }))));
    const profiles = v.profiles.filter((p) => !p.pending && p.key === a.key);
    for (const p of profiles) {
      const destination = h('input', { class: 'text-input', value: p.dir, 'aria-label': 'アカウントの保存先', spellcheck: false });
      const move = h('button', { class: 'btn', text: '保存先を変更', onclick: async () => {
        move.disabled = true;
        try {
          const res = await act('canban_move_account_home', { id: p.id, dir: destination.value.trim() }, { okMsg: '保存先を変更しました' });
          if (res.result?.busy) toast('別の処理が実行中です。少し待ってから変更してください', true);
          else {
            destination.value = res.result.dir;
            workspace.draftValues?.set(destination, destination.value);
          }
        } catch {} finally { move.disabled = false; }
      } });
      row.append(h('div', { class: 'acct-path-edit' }, h('label', { class: 'field-label', text: '保存先（未使用のフォルダを指定）' }), destination,
        h('div', { class: 'row' }, h('span', { class: 'muted', text: '専用フォルダのデータも移動します。同じディスク内で変更できます。' }), move)));
    }
    if (!profiles.length) row.append(h('p', { class: 'muted', text: '既存の保存先は「詳細設定」で変更できます。専用ログインで追加した保存先はここから移動できます。' }));
    workspace.trackDrafts(row);
    name.focus();
  };
  const toggleHeader = (a, on) => act('canban_update_accounts', { visible: { key: a.key, on } }).then(() => accountsMenu(anchor)).catch(() => {});
  const rows = v.accounts.map((a) => {
    const sel = state.filters.account === a.key;
    const row = h('div', { class: 'acct-row', 'data-key': `${a.label} ${a.email || ''} ${a.agent}`, 'data-account-key': a.key });
    const check = h('input', { type: 'checkbox', checked: a.inHeader, title: 'ヘッダのリングに出す', 'aria-label': `${a.label} をヘッダに出す`, onchange: (e) => toggleHeader(a, e.target.checked) });
    const identity = h('button', { class: `menu-item${sel ? ' active' : ''}`, title: `${usageTitle(a)}\n\nクリックでこのアカウントだけを表示`, onclick: () => pick(a.key) },
      h('div', { class: 'acct-name-line' }, h('strong', { text: a.label }), h('span', { class: `badge ${a.agent}`, text: a.agent === 'codex' ? 'Codex' : 'Claude' }), a.plan ? h('span', { class: 'muted', text: a.plan }) : null),
      a.email && a.email !== a.label ? h('div', { class: 'muted', text: a.email }) : null);
    row.append(h('div', { class: 'acct-identity' }, check, ringFor(a), identity,
      h('button', { class: 'icon-btn', title: '名前・頭文字・色・保存先を変更', 'aria-label': `${a.label} の設定`, text: '⚙', onclick: () => edit(a, row) })),
      h('div', { class: 'acct-detail' },
        h('div', { class: 'muted acct-connection', text: a.signedIn.length ? `ログイン中 · ${signedText(a)} · ${a.count} 件` : `ログインの記録なし · ${a.count} 件` }),
        h('div', { class: 'acct-usage-block' }, accountUsageContent(a)),
        h('div', { class: 'acct-update-line' }, h('span', { class: `muted acct-update-status${a.usage?.status === 'error' ? ' acct-error' : ''}`, role: 'status', text: accountUpdateText(a) }),
          h('button', { class: 'btn acct-row-refresh', text: '更新', 'aria-label': `${a.label} の使用量を更新`, onclick: () => refreshAccountUsage({ key: a.key }) })),
        h('div', { class: 'acct-auth-action' })));
    row._loginAction = (e) => accountLoginDialog(e?.currentTarget || anchor, { agent: a.agent, key: a.key });
    row._terminalLoginAction = () => startLogin(a.agent, a.key);
    return row;
  });
  const unknown = v.unknown.codex + v.unknown.claude;
  if (unknown) {
    const sel = state.filters.account === '__none';
    rows.push(h('div', { class: 'acct-row', 'data-key': '不明 unknown' },
      h('button', { class: `menu-item${sel ? ' active' : ''}`, title: 'どのアカウントで動いたか記録のないセッション（古い Codex スレッド、Claude CLI だけのセッションなど）', onclick: () => pick('__none') },
        h('div', { text: 'アカウント不明' }), h('div', { class: 'muted', text: `Codex ${v.unknown.codex} 件・Claude ${v.unknown.claude} 件` }))));
  }
  const startLogin = async (agent, key, profileId) => {
    if (loginButton.disabled) return;
    loginButton.disabled = true; loginButton.textContent = '開始中…';
    try {
      const r = await act('canban_start_account_login', { agent, method: 'terminal', ...(key ? { key } : {}), ...(profileId ? { profileId } : {}) });
      if (r.result?.busy) toast('別のアカウント操作が実行中です。少し待ってからお試しください', true);
      else { toast(r.result?.error || 'ターミナルでログインを完了してください', r.result?.opened === false); accountsMenu(anchor); }
    } catch {} finally { loginButton.disabled = false; loginButton.textContent = 'ターミナルでログイン'; }
  };
  const agentSel = h('select', { class: 'text-input', 'aria-label': '追加するサービス' }, h('option', { value: 'codex', text: 'Codex' }), h('option', { value: 'claude', text: 'Claude' }));
  const loginButton = h('button', { class: 'btn', text: 'ターミナルでログイン', onclick: () => startLogin(agentSel.value) });
  const browserButton = h('button', { class: 'btn-primary', text: '任意のブラウザで認証', onclick: (e) => accountLoginDialog(e?.currentTarget || anchor, { agent: agentSel.value }) });
  const pending = v.profiles.filter((p) => p.pending).map((p) => {
    const status = h('span', { class: 'muted', role: 'status', text: 'ターミナルでログインを完了してください' });
    let checking = false, timer = null, complete = false;
    const check = async () => {
      if (checking || complete || !status.isConnected) return;
      clearTimeout(timer);
      checking = true;
      try {
        const r = await bridge.callTool('canban_check_account_login', { id: p.id });
        if (r.result?.complete) {
          complete = true; await load(); status.textContent = '追加しました';
          if (!workspace.hasDrafts(body)) accountsMenu(anchor);
          refreshAccountUsage({ key: r.result.key }); return;
        }
        status.textContent = r.result?.wrongAccount ? '選択したアカウントでログインしてください。別のアカウントでは追加されません。' : 'ログイン完了待ち';
      } catch { status.textContent = '確認できませんでした。もう一度お試しください'; }
      finally { checking = false; if (!complete && status.isConnected) timer = setTimeout(check, 5000); }
    };
    timer = setTimeout(check, 2000);
    const command = h('textarea', { class: 'text-input login-url', readonly: true, rows: 3, 'aria-label': 'ターミナルのログインコマンド', hidden: true });
    const copyCommand = h('button', { class: 'btn', text: 'ログインコマンドをコピー', onclick: async () => {
      try {
        const r = await bridge.callTool('canban_account_login_details', { profileId: p.id });
        command.value = r.result?.command || ''; command.hidden = false;
        if (!command.value) { status.textContent = 'CLIが見つかりません。先にインストールしてください'; return; }
        try { await navigator.clipboard.writeText(command.value); status.textContent = 'コマンドをコピーしました。任意のターミナルで実行してください'; }
        catch { command.focus(); command.select(); status.textContent = '選択したコマンドをコピーして実行してください（⌘C / Ctrl+C）'; }
      } catch { status.textContent = 'コマンドを取得できませんでした。もう一度お試しください'; }
    } });
    return h('div', { class: 'acct-pending' }, h('strong', { text: `${p.agent === 'codex' ? 'Codex' : 'Claude'} · ログイン待ち` }), status,
      h('div', { class: 'row' }, h('button', { class: 'btn', text: '完了を確認', onclick: check }),
        h('button', { class: 'btn', text: 'ターミナルでログイン', onclick: () => startLogin(p.agent, p.expectedKey, p.id) }),
        h('button', { class: 'btn', text: '任意のブラウザで認証', onclick: (e) => accountLoginDialog(e?.currentTarget || anchor, { home: p, key: p.expectedKey }) }),
        copyCommand,
        h('button', { class: 'btn', text: '取消', onclick: () => act('canban_cancel_account_login', { id: p.id }).then(() => accountsMenu(anchor)).catch(() => {}) })), command);
  });
  const refresh = v.refresh || { enabled: true, intervalMinutes: 5 };
  const interval = h('input', { class: 'text-input acct-interval', type: 'number', min: 1, max: 1440, value: refresh.intervalMinutes, 'aria-label': '自動更新の間隔（分）' });
  const setRefresh = async (patch) => {
    try { await act('canban_set_usage_refresh', patch); accountsMenu(anchor); } catch {}
  };
  interval.onchange = () => {
    if (!interval.checkValidity() || !Number.isInteger(Number(interval.value))) { interval.reportValidity(); return; }
    setRefresh({ intervalMinutes: Number(interval.value) });
  };
  const auto = h('div', { class: 'acct-refresh-settings' },
    h('div', { class: 'row' }, h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: refresh.enabled, onchange: (e) => setRefresh({ enabled: e.target.checked }) }), '自動更新'), interval, h('span', { class: 'muted', text: '分ごと' }),
      h('span', { class: 'spacer' }), h('button', { class: 'btn acct-refresh-all', text: 'すべて更新', onclick: () => refreshAccountUsage() })),
    h('span', { class: 'muted acct-schedule', text: accountScheduleText(v) }));
  // Existing home registration remains available as an advanced setting.
  const extra = { claude: v.homes.filter((x) => x.agent === 'claude' && x.source === 'settings').map((x) => x.dir), codex: v.homes.filter((x) => x.agent === 'codex' && x.source === 'settings').map((x) => x.dir) };
  const saveHomes = (agent, dirs) => act('canban_update_accounts', { [agent === 'codex' ? 'codexHomes' : 'claudeHomes']: dirs }, { okMsg: '設定フォルダを更新しました' }).then(() => accountsMenu(anchor)).catch(() => {});
  const homeRows = v.homes.map((x) => h('div', { class: 'home-row' },
    h('span', { class: `badge ${x.agent}`, text: x.agent === 'codex' ? 'Codex' : 'Claude' }), h('span', { class: 'path', title: x.dir, text: x.dir }),
    h('span', { class: 'muted', text: `${{ default: '既定', discovered: '自動', settings: '追加' }[x.source]}${x.missing ? '・見つかりません' : ''}` }),
    x.source === 'settings' ? h('button', { class: 'icon-btn', title: '一覧から外す（ファイルは残ります）', 'aria-label': `${x.dir} を外す`, text: '×', onclick: () => saveHomes(x.agent, extra[x.agent].filter((d) => d !== x.dir)) }) : null));
  const homeAgent = h('select', { class: 'text-input', 'aria-label': '既存保存先のサービス' }, h('option', { value: 'codex', text: 'Codex' }), h('option', { value: 'claude', text: 'Claude' }));
  const dirInput = h('input', { class: 'text-input', placeholder: '既存の設定フォルダのパス', 'aria-label': '既存の設定フォルダ' });
  const addHome = () => { const d = dirInput.value.trim(); if (d) saveHomes(homeAgent.value, [...extra[homeAgent.value], d]); };
  dirInput.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) addHome(); };
  const body = h('div', { class: 'acct-menu' }, auto,
    h('p', { class: 'muted acct-pace-legend', text: '週間枠の縦線＝今の目安・差±5pt以内は順調' }),
    rows.length > 5 ? rowFilter(rows) : null,
    rows.length ? rows : h('p', { class: 'muted', text: 'アカウントが見つかりません。ログインして追加できます。' }),
    h('section', { class: 'acct-add' }, h('div', { class: 'field-label', text: 'アカウントを追加' }),
      h('p', { class: 'muted', text: '保存先は自動作成されます。追加後にアカウント設定から変更できます。' }),
      h('div', { class: 'row acct-login-actions' }, agentSel, loginButton, browserButton), ...pending),
    h('details', { class: 'acct-advanced' }, h('summary', { text: '詳細設定・表示について' }),
      h('p', { class: 'muted', text: '名前をクリックするとカードを絞り込みます。チェックを外すとヘッダのリングから隠します。リングの外側は5時間枠、内側は週間枠です。ログイン状態と使用量の更新状態は別に表示します。取得失敗時は前回の値を残します。デスクトップのみのアカウントは、最新取得のためのCLIログインが必要です。' }),
      h('div', { class: 'field-label', text: '既存の設定フォルダを登録' }), ...homeRows,
      h('div', { class: 'row' }, homeAgent, dirInput, h('button', { class: 'btn', text: '登録', onclick: addHome })),
      h('label', { class: 'row muted' }, h('input', { type: 'checkbox', checked: v.discover, onchange: (e) => act('canban_update_accounts', { discover: e.target.checked }).then(() => accountsMenu(anchor)) }), '既存のCLI・デスクトップのプロファイルを自動で探す')));
  popover(anchor, 'アカウントと使用量', body, { width: 440 });
  updateAccountMenuUsage();
  refreshAccountUsage({ automatic: true });
}

async function accountLoginDialog(anchor, { home = null, agent = home?.agent, key = null } = {}) {
  if (document.querySelector('.account-login')) return;
  closePopover();
  let closed = false, busy = false, session = null, timer, epoch = 0, refreshed = false;
  const relogin = !!key;
  const title = relogin ? 'アカウントに再ログイン' : 'アカウントにログイン';
  const call = async (tool, args = {}) => (await bridge.callTool(tool, args)).result;
  const status = h('p', { class: 'login-status', role: 'status', 'aria-live': 'polite', text: 'ブラウザ一覧を読み込んでいます…' });
  const mode = h('select', { class: 'text-input', 'aria-label': '認証URLの開き方' },
    h('option', { value: 'auto', text: '自動起動' }), h('option', { value: 'manual', text: '手動起動（URLをコピー）' }));
  const browser = h('select', { class: 'text-input', 'aria-label': '認証ブラウザ' });
  const profile = h('select', { class: 'text-input', 'aria-label': 'Chromeプロファイル' });
  const browserField = h('label', { class: 'login-field' }, 'ブラウザ', browser);
  const profileField = h('label', { class: 'login-field' }, 'Chromeプロファイル', profile);
  const choices = h('fieldset', { class: 'login-choices', disabled: true },
    h('legend', { text: '認証ページの開き方' }), h('label', { class: 'login-field' }, '起動方法', mode), browserField, profileField);
  const url = h('textarea', { class: 'text-input login-url', readonly: true, rows: 3, spellcheck: false, 'aria-label': '認証URL' });
  const notice = h('p', { class: 'muted', role: 'status', 'aria-live': 'polite' });
  const copy = h('button', { class: 'btn', type: 'button', text: '認証URLをコピー', onclick: async () => {
    if (!url.value) return;
    try { await navigator.clipboard.writeText(url.value); if (!closed) notice.textContent = '認証URLをコピーしました'; }
    catch { if (!closed) { url.focus(); url.select(); notice.textContent = '選択したURLをコピーして、任意のブラウザで開いてください（⌘C / Ctrl+C）'; } }
  } });
  const reopen = h('button', { class: 'btn', type: 'button', text: '選んだブラウザで開く' });
  const urlArea = h('div', { class: 'login-url-area', hidden: true }, url, h('div', { class: 'row' }, copy, reopen), notice);
  const code = h('input', { class: 'text-input', type: 'password', autocomplete: 'off', spellcheck: false, maxlength: 4096, 'aria-label': 'Claude認証コード' });
  const codeSend = h('button', { class: 'btn', type: 'submit', text: 'コードを送信' });
  const codeForm = h('form', { class: 'login-code-form' }, h('label', { class: 'login-field' }, 'ブラウザに表示された認証コード', code), codeSend);
  const codeArea = h('details', { hidden: true }, h('summary', { text: '認証が戻らない場合（Claudeのコード入力）' }), codeForm);
  const start = h('button', { class: 'btn-primary', type: 'button', text: home || relogin ? 'ログインを開始' : '追加してログイン', disabled: true });
  const cancel = h('button', { class: 'btn', type: 'button', text: '認証をキャンセル', hidden: true });
  const dialog = h('dialog', { class: 'account-login', 'aria-label': title, onclose: () => {
    closed = true; epoch++; clearTimeout(timer); url.value = ''; code.value = ''; session = null; dialog.remove();
    (anchor?.isConnected ? anchor : $('#accountsBtn')).focus();
  } }, h('h2', { text: title }),
    h('p', { class: 'muted', text: `${agent === 'codex' ? 'Codex' : 'Claude'} · ${relogin ? 'アカウントに再ログイン' : 'アカウントを追加'}` }), choices, status, urlArea, codeArea,
    h('div', { class: 'row login-actions' }, start, cancel, h('button', { class: 'btn', type: 'button', text: '閉じる', onclick: () => dialog.close() })),
    h('p', { class: 'muted', text: '閉じても認証はバックグラウンドで続きます。ログインから認証状態を開き直せます。' }));
  // Native dialog owns focus and Escape; board shortcuts must not handle its keys.
  dialog.addEventListener('keydown', (e) => e.stopPropagation());
  document.body.append(dialog); dialog.showModal();
  let browsers = [];
  const active = () => session && !['succeeded', 'failed', 'cancelled'].includes(session.state);
  const options = () => ({ mode: mode.value, ...(browser.value ? { browserId: browser.value } : {}),
    ...(browser.value === 'chrome' && profile.value ? { profileId: profile.value } : {}) });
  const controls = () => {
    browserField.hidden = mode.value !== 'auto'; profileField.hidden = mode.value !== 'auto' || browser.value !== 'chrome';
    const selected = browsers.find((b) => b.id === browser.value);
    const valid = mode.value === 'manual' || (selected && (selected.id !== 'chrome' || selected.profiles.some((p) => p.id === profile.value)));
    choices.disabled = busy; start.disabled = busy || !!active() || session?.state === 'succeeded' || !valid;
    cancel.hidden = !active(); cancel.disabled = busy;
    copy.disabled = busy; reopen.hidden = mode.value !== 'auto'; reopen.disabled = busy || !valid;
    codeSend.disabled = busy;
  };
  const fillProfiles = (id = '') => {
    const list = browsers.find((b) => b.id === browser.value)?.profiles || [];
    profile.replaceChildren(h('option', { value: '', text: 'プロファイルを選んでください' }), ...list.map((p) => h('option', { value: p.id, text: p.label })));
    if (id && !list.some((p) => p.id === id)) profile.append(h('option', { value: id, disabled: true, text: `${id}（見つかりません・再選択してください）` }));
    profile.value = id;
  };
  browser.onchange = () => { fillProfiles(); controls(); }; mode.onchange = profile.onchange = controls;
  const show = (value) => {
    if (closed) return;
    if (value.state === 'succeeded' && key && value.account?.key !== key) {
      value = { ...value, state: 'failed', authUrl: null, error: '選択したアカウントでログインしてください。別のアカウントでは更新されません。' };
    }
    session = value;
    const message = { starting: '認証を開始しています…', waiting: value.browserOpened ? '選んだブラウザで認証を完了してください' : '認証URLをブラウザで開いてください',
      verifying: 'ログインしたアカウントを確認しています…', succeeded: `ログインしました: ${value.account?.email || value.account?.label || ''}`, failed: value.error || '認証に失敗しました', cancelled: '認証をキャンセルしました' }[value.state];
    status.textContent = [message, value.browserError].filter(Boolean).join('\n');
    if (url.value !== (value.authUrl || '')) url.value = value.authUrl || '';
    urlArea.hidden = !value.authUrl;
    codeArea.hidden = agent !== 'claude' || value.state !== 'waiting';
    if (value.manualCodeRequired) codeArea.open = true;
    if (!active()) { code.value = ''; codeArea.open = false; }
    start.textContent = value.state === 'succeeded' ? (relogin ? 'ログインしました' : '追加しました') : 'ログインを開始';
    controls();
    if (value.state === 'succeeded' && !refreshed) {
      refreshed = true;
      load().then(() => value.account?.key && refreshAccountUsage({ key: value.account.key })).catch(() => {
        if (!closed) notice.textContent = 'ログインしましたが、使用量の更新を確認できませんでした。アカウント一覧から更新してください。';
      });
    }
  };
  const poll = async () => {
    if (closed || !session?.sessionId || !active()) return;
    const id = session.sessionId, current = epoch;
    try { const next = await call('canban_account_login_status', { sessionId: id }); if (!closed && current === epoch) show(next); }
    catch { if (!closed && current === epoch) status.textContent = '認証状態を取得できませんでした。再確認しています…'; }
    if (!closed && active()) timer = setTimeout(poll, 1000);
  };
  const perform = async (fn) => {
    if (closed || busy) return;
    busy = true; epoch++; clearTimeout(timer); controls(); notice.textContent = '';
    try { await fn(); } catch (e) { if (!closed) status.textContent = e.message; }
    finally { busy = false; if (!closed) { controls(); if (active()) timer = setTimeout(poll, 1000); } }
  };
  start.onclick = () => perform(async () => {
    refreshed = false; status.textContent = '認証を開始しています…';
    let result;
    const created = await call('canban_start_account_login', { agent, method: 'browser', ...(home ? { profileId: home.id } : {}), ...(key ? { key } : {}), loginOptions: options() });
    if (created.busy) throw new Error('別のアカウント操作が実行中です。少し待ってからお試しください');
    home = created.profile; result = created.login; await load();
    show(result);
  });
  reopen.onclick = () => perform(async () => show(await call('canban_account_login_open', { sessionId: session.sessionId, loginOptions: options() })));
  cancel.onclick = () => perform(async () => show(await call('canban_account_login_cancel', { sessionId: session.sessionId })));
  codeForm.onsubmit = (e) => {
    e.preventDefault(); if (!code.value.trim()) return code.focus();
    const value = code.value; code.value = '';
    perform(async () => { show(await call('canban_account_login_code', { sessionId: session.sessionId, code: value })); if (!closed) notice.textContent = 'コードを送信しました'; });
  };
  try {
    const catalog = await call('canban_login_browsers', home ? { profileId: home.id } : {});
    if (closed) return;
    browsers = catalog.browsers;
    const target = catalog.active?.target || catalog.preference || { mode: 'manual', browserId: browsers[0]?.id };
    browser.replaceChildren(...browsers.map((b) => h('option', { value: b.id, text: b.label })));
    if (target.browserId && !browsers.some((b) => b.id === target.browserId)) browser.append(h('option', { value: target.browserId, disabled: true, text: '保存したブラウザが見つかりません' }));
    mode.value = target.mode; browser.value = target.browserId || browsers[0]?.id || ''; fillProfiles(target.profileId);
    status.textContent = 'ブラウザとプロファイルを選ぶか、手動起動でURLをコピーしてください'; controls();
    if (catalog.active) { show(catalog.active); timer = setTimeout(poll, 1000); }
  } catch (e) { if (!closed) status.textContent = e.message; }
}

$('#accountsBtn').addEventListener('click', (e) => accountsMenu(e.currentTarget));

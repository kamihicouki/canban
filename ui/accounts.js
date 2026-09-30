// Accounts (included into board.html's script by server/ui.mjs; shares its scope).
// Everything the board shows about accounts: the usage rings on the 👤 button, card
// chips, the 👤 menu (filter, header visibility, name / initial / color, config
// folders) and the small hooks board.html calls. Server side: server/accounts*.mjs.

// ---- hooks called from board.html ----
function renderAccountsButton(b) {
  const active = state.filters.account === '__none' ? { label: 'アカウント不明' } : (b.accounts?.accounts || []).find((a) => a.key === state.filters.account);
  $('#accountsBtn .acct-lbl').textContent = active ? active.label : '';
  $('#accountsBtn').setAttribute('aria-pressed', String(!!active));
  renderUsage(b.accounts);
}
// The live watch sends fresh Codex limits per account.
function applyAccountLimits(list) {
  if (!list || !state.board?.accounts) return;
  for (const l of list) { const a = state.board.accounts.accounts.find((x) => x.key === l.key); if (a) a.limits = l; }
  renderUsage(state.board.accounts);
}
function accountKv(s) {
  return [...(s.host ? [] : kv('アカウント', s.accountLabel || '不明（記録なし）')), ...(s.homeDir ? kv('設定フォルダ', s.homeDir) : [])];
}
function accountLaneKey(card) {
  if (card.kind === 'task') return `${T.taskCard}`;
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
  const hrs = Math.floor(d / 3600e3), min = Math.round((d % 3600e3) / 60e3);
  return hrs >= 24 ? `${new Date(ms).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} にリセット` : `あと ${hrs ? `${hrs} 時間 ` : ''}${min} 分でリセット`;
}
function windowName(w) { return !w.windowMinutes ? '' : w.windowMinutes >= 1440 ? (w.windowMinutes === 10080 ? '週' : `${Math.round(w.windowMinutes / 1440)}日`) : `${Math.round(w.windowMinutes / 60)}h`; }
// Usage per account in the header: Codex rate limits (from its logs) and Claude plan
// usage (from the desktop app), one group per account that has a record.
function usageWindows(l) { return l ? [l.primary, l.secondary].filter(Boolean) : []; }
function usageTitle(a) {
  const l = a.limits;
  const ws = usageWindows(l);
  return [`${a.agent === 'codex' ? 'Codex' : 'Claude'}: ${a.label}${a.plan ? `（${a.plan}）` : ''}`,
    ...ws.map((w) => `${windowName(w)}: ${Math.round(w.usedPercent)}% 使用${w.resetsAt ? ` · ${fmtReset(w.resetsAt)}` : ''}`),
    l ? `${fmtDate(l.at)} 時点（${l.source === 'desktop' ? 'Claude デスクトップの記録' : 'セッションのログ'}）` : '使用量の記録はまだありません'].join('\n');
}
function usageBars(l, cls = 'lm') {
  return usageWindows(l).map((w) => h('span', { class: cls }, h('span', { text: windowName(w) }),
    h('span', { class: 'bar' }, h('i', { class: heat(w.usedPercent), style: { width: `${Math.min(100, w.usedPercent)}%` } })),
    h('span', { text: `${Math.round(w.usedPercent)}%` })));
}
function shortWho(label) { return String(label || '').replace(/@.*$/, ''); }
function ringFor(a) {
  const l = a.limits || {};
  const five = [l.primary, l.secondary].find((w) => w && w.windowMinutes && w.windowMinutes < 1440) || null;
  const week = [l.primary, l.secondary].find((w) => w && w.windowMinutes >= 1440) || null;
  const col = (w) => (w ? `var(--c-${heat(w.usedPercent) === 'hot' ? 'red' : heat(w.usedPercent) === 'warn' ? 'orange' : 'green'})` : 'transparent');
  const old = a.limits && a.limits.source === 'desktop' && Date.now() - (a.limits.at || 0) > OLD_USAGE_MS;
  return h('span', { class: `ring2${five ? '' : ' no-a'}${week ? '' : ' no-b'}${old ? ' stale' : ''}${a.limits ? '' : ' none'}`, title: usageTitle(a),
    style: { '--a': five ? Math.min(100, five.usedPercent) : 0, '--b': week ? Math.min(100, week.usedPercent) : 0, '--ca': col(five), '--cb': col(week) } },
    h('b', { class: 'ini', style: { background: colorVar(a.color) }, text: a.short }),
    h('i', { class: `agm ${a.agent}` }));
}
// The 👤 button carries one ring per account shown in the header (settings in its menu).
function renderUsage(v) {
  const box = $('#acctRings');
  if (!box) return;
  const list = (v?.accounts || []).filter((a) => a.inHeader && (a.limits || a.count));
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

// ---- 👤 menu ----
function accountsMenu(anchor) {
  const v = state.board?.accounts;
  if (!v) return;
  const pick = (key) => { state.filters.account = state.filters.account === key ? '' : key; saveFilters(); closePopover(); load(); };
  const signedText = (a) => a.signedIn.map((x) => (x === 'desktop' ? 'デスクトップ' : x.startsWith('desktop:') ? `デスクトップ（${x.slice(8)}）` : `CLI${x === 'cli:default' ? '' : `（${x.slice(4)}）`}`)).join('・');
  // Name, initial and color: how the account reads in the header rings and on cards.
  const edit = (a, row) => {
    let color = a.color;
    const name = h('input', { class: 'text-input', value: a.customLabel || '', placeholder: a.email || a.name || a.label, maxlength: 60, 'aria-label': '表示名' });
    const short = h('input', { class: 'text-input', value: a.short, maxlength: 2, style: { width: '44px', textAlign: 'center' }, 'aria-label': 'リングの頭文字（2 文字まで）', title: 'リングの頭文字（2 文字まで）' });
    const sw = h('div', { class: 'acct-swatches', role: 'group', 'aria-label': '色' }, ...v.colors.map((c) => h('button', { 'aria-pressed': String(c === color), 'aria-label': COLOR_NAMES?.[c] || c, title: COLOR_NAMES?.[c] || c, style: { background: colorVar(c) },
      onclick: (e) => { color = c; sw.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); } })));
    const save = async () => {
      try {
        await act('canban_update_accounts', { label: { key: a.key, name: name.value.trim() } }, { reload: false });
        await act('canban_update_accounts', { mark: { key: a.key, short: short.value.trim(), color } }, { okMsg: '保存しました' });
      } catch {}
      accountsMenu(anchor);
    };
    for (const i of [name, short]) i.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) save(); if (e.key === 'Escape') accountsMenu(anchor); };
    row.replaceChildren(h('div', { class: 'grow', style: { display: 'grid', gap: '6px', padding: '4px 0' } },
      h('div', { class: 'row' }, name, short),
      h('div', { class: 'row' }, sw, h('span', { class: 'spacer' }), h('button', { class: 'btn', text: '取消', onclick: () => accountsMenu(anchor) }), h('button', { class: 'btn-primary', text: '保存', onclick: save }))));
    name.focus();
  };
  const toggleHeader = (a, on) => act('canban_update_accounts', { visible: { key: a.key, on } }).then(() => accountsMenu(anchor)).catch(() => {});
  const rows = v.accounts.map((a) => {
    const sel = state.filters.account === a.key;
    const sub = [a.label !== a.email && a.email ? a.email : null, a.plan, `${a.count} 件`, a.signedIn.length ? `サインイン中: ${signedText(a)}` : null].filter(Boolean).join('・');
    const row = h('div', { class: 'acct-row', 'data-key': `${a.label} ${a.email || ''} ${a.agent}` });
    row.append(
      h('input', { type: 'checkbox', checked: a.inHeader, title: 'ヘッダのリングに出す', 'aria-label': `${a.label} をヘッダに出す`, onchange: (e) => toggleHeader(a, e.target.checked) }),
      ringFor(a),
      h('button', { class: `menu-item${sel ? ' active' : ''}`, title: `${usageTitle(a)}\n\nクリックでこのアカウントだけを表示`, onclick: () => pick(a.key) },
        h('div', {}, h('span', { class: `badge ${a.agent}`, text: a.agent === 'codex' ? 'Codex' : 'Claude' }), ' ', a.label),
        h('div', { class: 'muted', text: sub }),
        usageWindows(a.limits).length ? h('div', { class: 'acct-usage' }, ...usageBars(a.limits), h('span', { text: relTime(a.limits.at) })) : null),
      h('button', { class: 'icon-btn', title: '名前・頭文字・色を変更', 'aria-label': `${a.label} の名前・頭文字・色を変更`, text: '✎', onclick: () => edit(a, row) }));
    return row;
  });
  const unknown = v.unknown.codex + v.unknown.claude;
  if (unknown) {
    const sel = state.filters.account === '__none';
    rows.push(h('div', { class: 'acct-row', 'data-key': '不明 unknown' },
      h('button', { class: `menu-item${sel ? ' active' : ''}`, title: 'どのアカウントで動いたか記録のないセッション（古い Codex スレッド、Claude CLI だけのセッションなど）', onclick: () => pick('__none') },
        h('div', { text: 'アカウント不明' }), h('div', { class: 'muted', text: `Codex ${v.unknown.codex} 件・Claude ${v.unknown.claude} 件` }))));
  }
  // Config folders (CLAUDE_CONFIG_DIR / CODEX_HOME profiles)
  const extra = { claude: v.homes.filter((x) => x.agent === 'claude' && x.source === 'settings').map((x) => x.dir), codex: v.homes.filter((x) => x.agent === 'codex' && x.source === 'settings').map((x) => x.dir) };
  const saveHomes = (agent, dirs) => act('canban_update_accounts', { [agent === 'codex' ? 'codexHomes' : 'claudeHomes']: dirs }, { okMsg: '設定フォルダを更新しました' }).then(() => accountsMenu(anchor)).catch(() => {});
  const homeRows = v.homes.map((x) => h('div', { class: 'home-row' },
    h('span', { class: `badge ${x.agent}`, text: x.agent === 'codex' ? 'Codex' : 'Claude' }),
    h('span', { class: 'path', title: x.dir, text: x.dir }),
    h('span', { class: 'muted', text: `${{ default: '既定', discovered: '自動', settings: '追加' }[x.source]}${x.missing ? '・見つかりません' : ''}${x.account ? `・${accountLabel(x.account)}` : ''}` }),
    x.source === 'settings' ? h('button', { class: 'icon-btn', title: '外す', 'aria-label': `${x.dir} を外す`, text: '×', onclick: () => saveHomes(x.agent, extra[x.agent].filter((d) => d !== x.dir)) }) : null));
  const agentSel = h('select', { class: 'text-input', style: { width: 'auto' } }, h('option', { value: 'claude', text: 'Claude' }), h('option', { value: 'codex', text: 'Codex' }));
  const dirInput = h('input', { class: 'text-input', placeholder: '~/.claude-work（CLAUDE_CONFIG_DIR / CODEX_HOME のフォルダ）' });
  const addHome = () => { const d = dirInput.value.trim(); if (d) saveHomes(agentSel.value, [...extra[agentSel.value], d]); };
  dirInput.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) addHome(); };
  const body = h('div', {},
    rows.length > 5 ? rowFilter(rows) : null,
    rows.length ? rows : h('p', { class: 'muted', text: 'アカウントが見つかりません。' }),
    h('div', { class: 'sep' }),
    h('div', { class: 'field-label', text: '設定フォルダ' }),
    ...homeRows,
    h('div', { class: 'row' }, agentSel, dirInput, h('button', { class: 'btn-primary', text: '追加', onclick: addHome })),
    h('label', { class: 'row muted' }, h('input', { type: 'checkbox', checked: v.discover, onchange: (e) => act('canban_update_accounts', { discover: e.target.checked }).then(() => accountsMenu(anchor)) }),
      '~/.claude-*・~/.codex-*・Claude デスクトップのプロファイルを自動で探す'),
    h('p', { class: 'muted', text: 'すべてのアカウントのセッションを 1 つのボードに表示します。アプリでアカウントを切り替えても消えません。名前をクリックするとそのアカウントだけを表示します。チェックを外したアカウントはヘッダのリングに出しません（リングは外側が 5 時間枠、内側が週枠、中央が頭文字、角の印が Codex／Claude）。別のフォルダのセッションは、再開・送信のときにそのフォルダ（CLAUDE_CONFIG_DIR / CODEX_HOME）で動かします。使用量は Codex はセッションのログ、Claude は Claude デスクトップの記録から読みます。' }));
  popover(anchor, 'アカウント', body, { width: 440 });
}

$('#accountsBtn').addEventListener('click', (e) => accountsMenu(e.currentTarget));

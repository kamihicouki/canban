// Part of board.html: included into its script by server/ui.mjs and shares its scope.
// Settings & machines popovers
function settingsMenu(anchor) {
  const b = state.board;
  const L = launchPrefs();
  const terms = b.terminals || [];
  const radio = (name, value, label, checked, onchange, disabled = false) =>
    h('label', { class: 'menu-item row' }, h('input', { type: 'radio', name, value, checked, disabled, onchange }), label);
  const save = (patch) => act('canban_update_settings', patch, { okMsg: '既定を変更しました' }).then(() => settingsMenu(anchor));
  const term = currentTerminal();
  const body = h('div', {},
    h('div', { class: 'field-label', text: '再開の既定' }),
    radio('route', 'desktop', 'デスクトップアプリ（Codex / Claude）', L.route === 'desktop', () => save({ route: 'desktop' })),
    radio('route', 'terminal', 'ターミナル', L.route === 'terminal', () => save({ route: 'terminal' })),
    h('div', { class: 'field-label', text: 'ターミナル' }),
    terms.length ? terms.map((t) => radio('term', t.id, t.label, (term && term.id) === t.id, () => save({ terminal: t.id }))) : h('div', { class: 'muted', text: '対応ターミナルが見つかりません（Ghostty / ターミナル / iTerm2）' }),
    h('div', { class: 'field-label', text: '開き方' }),
    Object.entries(TARGET_LABELS).map(([id, label]) => radio('target', id, label, L.target === id, () => save({ target: id }), !!term && !term.targets.includes(id))),
    h('div', { class: 'sep' }),
    h('div', { class: 'field-label', text: 'ショートカット' }),
    h('div', { class: 'muted', style: { whiteSpace: 'pre-line' }, text:
      '再開ボタン: クリック=既定 / ⌥=もう一方の経路 / ⇧=新規ウィンドウ / ⌘=新規タブ / ⌃=既存ウィンドウ\nキーボード操作の一覧は ? キーで表示します。\nリモートのセッションは ssh 経由でターミナルに開きます。\n※ ターミナルの「新規タブ」はアクセシビリティ許可が必要な場合があります。' }),
    h('button', { class: 'menu-item', text: '⌨ キーボードショートカット一覧（?）', onclick: showShortcuts }),
    h('div', { class: 'sep' }),
    dispatchSettings(anchor),
  );
  popover(anchor, '設定', body, { width: 360 });
}

function dispatchSettings(anchor) {
  const D = state.board.settings.dispatch;
  const save = (patch) => act('canban_update_dispatch_settings', patch, { okMsg: '指示の送信の設定を変更しました' }).then(() => settingsMenu(anchor));
  const check = (key, label, disabled = false) => h('label', { class: 'menu-item row' },
    h('input', { type: 'checkbox', checked: D[key], disabled, onchange: (e) => save({ [key]: e.target.checked }) }), label);
  const num = (key, label, min, max) => h('label', { class: 'menu-item row' }, label,
    h('input', { class: 'text-input', type: 'number', min, max, value: D[key], style: { width: '60px', marginLeft: 'auto' }, onchange: (e) => save({ [key]: Number(e.target.value) }) }));
  return h('div', {},
    h('div', { class: 'field-label', text: '指示の送信' }),
    check('enabled', 'セッションへの指示の送信を有効にする'),
    num('maxLocal', 'このマシンの同時実行数', 1, 8),
    num('maxPerHost', 'リモート 1 台あたりの同時実行数', 1, 4),
    check('allowModel', 'エージェント（モデル）からの送信を許可', !D.enabled),
    num('modelPerHour', 'モデルからの送信（1 セッション・1 時間あたり）', 0, 100),
    check('allowModelElevated', 'モデルが制限なしのセッションに送ることを許可（非推奨）', !D.enabled || !D.allowModel),
    h('div', { class: 'muted', style: { whiteSpace: 'pre-line', padding: '4px 8px' }, text:
      '権限（サンドボックス / permission-mode）は各セッションの設定を引き継ぎ、Canban が引き上げることはありません。\n実行中・入力待ちのセッションには送らず、失敗したらそのセッションのキューを止めます。' }),
  );
}

// Canban's own timings (budgets in docs/performance.md).
async function perfPanel(anchor) {
  let p;
  try {
    p = await bridge.callTool('canban_get_perf', {});
  } catch (e) {
    return toast(e.message, true);
  }
  const rows = Object.entries(p.ops).sort((a, b) => b[1].p95 - a[1].p95).map(([name, o]) =>
    h('tr', {}, h('td', { text: name }), h('td', { text: o.count }), h('td', { text: o.p50 }), h('td', { class: o.budget != null && o.p95 > o.budget ? 'over' : '', text: o.p95 }), h('td', { text: o.max }), h('td', { text: o.budget ?? '-' })));
  popover(anchor, '動作の重さ（ms）', h('div', {},
    h('div', { class: 'muted', text: `メモリ ${p.rssMB}MB・イベントループ遅延 p99 ${p.loop?.p99 ?? '-'}ms / 最大 ${p.loop?.max ?? '-'}ms・${p.leader ? 'このプロセスが背景処理を担当' : `背景処理は別プロセス（pid ${p.leaderPid ?? '-'}）`}` }),
    h('table', { class: 'perf-table' }, h('tr', {}, ...['処理', '回数', 'p50', 'p95', '最大', '予算'].map((t) => h('th', { text: t }))), ...rows),
    p.slow.length ? h('div', { class: 'field-label', text: '直近の予算超過' }) : null,
    ...p.slow.slice(-8).reverse().map((x) => h('div', { class: 'muted', text: `${relTime(x.at)}  ${x.name} ${x.ms}ms（予算 ${x.budget}ms）` })),
  ), { width: 420 });
}

function hostsMenu(anchor) {
  const b = state.board;
  const statusText = (st) => ({ ok: '取得済み', connecting: '接続中…', error: 'エラー', idle: '未取得' })[st?.state] || '';
  const rows = b.hosts.map((host) => {
    const sel = (state.filters.host || '') === (host.local ? 'local' : host.id);
    const toggle = host.local ? h('span', { class: 'muted', text: '常に有効' }) : h('label', { class: 'row' },
      h('input', { type: 'checkbox', checked: host.enabled, 'aria-label': `${host.label} を読む`,
        onchange: (e) => { toast(e.target.checked ? `${host.label} に接続しています…` : `${host.label} を無効にしました`); act('canban_set_remote_host', { hostId: host.id, enabled: e.target.checked }).then(() => hostsMenu(anchor)); } }), '読む');
    return h('div', { class: 'host-row', 'data-key': `${host.label} ${host.alias || ''}` },
      h('button', { class: `menu-item${sel ? ' active' : ''}`, title: 'このマシンだけを表示', onclick: () => { state.filters.host = sel ? '' : (host.local ? 'local' : host.id); saveFilters(); closePopover(); load(); } },
        h('div', { text: `${host.local ? '💻' : '⌂'} ${host.label}` }),
        h('div', { class: 'muted', text: host.local ? `${host.count} 件` : host.enabled
          ? `${statusText(host.status)}${host.status.fetchedAt ? `・${relTime(host.status.fetchedAt)}` : ''}・${host.count} 件${host.status.error ? `・${host.status.error}` : ''}`
          : `SSH: ${host.alias}` })),
      toggle);
  });
  const body = h('div', {},
    rows.length > 5 ? rowFilter(rows) : null,
    rows.length > 1 ? rows : [rows, h('p', { class: 'muted', text: 'Codex アプリにリモート接続が登録されていません。' })],
    h('div', { class: 'sep' }),
    h('p', { class: 'muted', text: 'リモート接続は Codex アプリに登録済みのものです。有効にすると ssh（鍵認証）で python3 を使い、セッションを読み取り専用で取得します。名前をクリックするとそのマシンだけを表示します。' }));
  popover(anchor, 'マシン', body, { width: 360 });
}

function labelPicker(anchor, cardId, card, repaint) {
  const labels = state.board.labels;
  const save = (ids) => { card.labels = ids; repaint(); return act('canban_update_card', { cardId, labels: ids }, { reload: false }).then(() => load()).catch(() => {}); };
  picker(anchor, {
    title: 'ラベル', multi: true, selected: card.labels, createText: 'をラベルとして作成して付ける',
    items: labels.map((l) => ({ value: l.id, label: l.name, color: l.color, keywords: COLOR_NAMES[l.color] })),
    onPick: (_id, _on, ids) => save(ids),
    onCreate: async (name) => {
      const r = await act('canban_create_label', { name, color: COLORS[(labels.length + 1) % COLORS.length] }, { reload: false }).catch(() => null);
      if (r?.result) { state.board.labels.push(r.result); await save([...card.labels, r.result.id]); }
    },
    footer: h('button', { class: 'menu-item', text: 'ラベルを管理…', onclick: () => labelsManager(anchor) }),
  });
}

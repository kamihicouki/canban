// Part of board.html: included into its script by server/ui.mjs and shares its scope.
// Sidebar: lanes (jump), directories and projects (one-click filters)
// ---- filters in effect, as chips in the app bar (each ✕ takes one off) ----
const FILTER_KEYS = ['agent', 'days', 'status', 'directory', 'project', 'folder', 'section', 'label', 'host', 'account', 'includeArchived', 'includeSubagents', 'pinnedOnly'];
const sameFilters = (a, b) => FILTER_KEYS.every((k) => (a[k] ?? DEFAULT_FILTERS[k]) === (b[k] ?? DEFAULT_FILTERS[k]));
function activeView(b) { return (b?.settings?.views || []).find((v) => sameFilters({ ...DEFAULT_FILTERS, ...v.filters }, state.filters)); }
// The lane axis is not also a filter: lanes by category already show every category.
const LANE_FILTER = { directory: 'directory', agent: 'agent', host: 'host', label: 'label', project: 'project', section: 'section', account: 'account' };
const laneHides = (key) => LANE_FILTER[state.filters.swimlane] === key;
function filterChips(b) {
  const f = state.filters, out = [];
  const add = (text, patch) => out.push({ text, patch });
  if (f.agent !== 'all' && !laneHides('agent')) add(f.agent === 'codex' ? 'Codex' : 'Claude', { agent: 'all' });
  if (f.status) add(STATUS_LABELS[f.status] || f.status, { status: '' });
  if (f.directory && !laneHides('directory')) add(f.directory === '__none' ? 'カテゴリ無し' : b?.directories.find((d) => d.id === f.directory)?.name || f.directory, { directory: '' });
  if (f.project && !laneHides('project')) add(f.project, { project: '' });
  if (f.folder) add(`フォルダ ${f.folder}`, { folder: '' });
  if (f.section && !laneHides('section')) add(`§ ${f.section === '__none' ? 'セクションなし' : b?.codexSections?.find((x) => x.id === f.section)?.name || f.section}`, { section: '' });
  if (f.label && !laneHides('label')) add(`ラベル: ${f.label === '__none' ? 'なし' : b?.labels.find((l) => l.id === f.label)?.name || f.label}`, { label: '' });
  if (f.host && !laneHides('host')) { const x = b?.hosts.find((y) => (y.local ? 'local' : y.id) === f.host); add(x?.local ? 'このマシン' : x?.label || f.host, { host: '' }); }
  if (f.account && !laneHides('account')) add(`アカウント: ${b?.accounts?.accounts?.find((a) => a.key === f.account)?.label || f.account}`, { account: '' });
  if (f.includeArchived) add('アーカイブ済みも表示', { includeArchived: false });
  if (f.includeSubagents) add('サブエージェントも表示', { includeSubagents: false });
  if (f.pinnedOnly) add('ピン留めだけ', { pinnedOnly: false });
  return out;
}
function clearFilters() {
  const keep = { swimlane: state.filters.swimlane, laneHeight: state.filters.laneHeight, groupBranch: state.filters.groupBranch, fulltext: state.filters.fulltext, q: state.filters.q };
  setScope({ ...Object.fromEntries(FILTER_KEYS.map((k) => [k, DEFAULT_FILTERS[k]])), days: 0, ...keep });
}
function renderFilterChips(b) {
  const chips = filterChips(b);
  $('#filterChips').replaceChildren(...chips.map(({ text, patch }) => h('button', { class: 'filter-chip', type: 'button', title: `${text} を外す`, 'aria-label': `${text} を外す`, onclick: () => setScope(patch) }, text, h('span', { class: 'x', text: '✕' }))),
    ...(chips.length > 1 ? [h('button', { class: 'filter-chip chip-clear', type: 'button', text: 'すべて解除', onclick: clearFilters })] : []));
}
function scopeLabel(b) {
  const f = state.filters;
  const dir = f.directory === '__none' ? 'カテゴリ無し' : b?.directories.find((d) => d.id === f.directory)?.name;
  const sec = f.section === '__none' ? 'セクションなし' : b?.codexSections?.find((x) => x.id === f.section)?.name;
  const host = f.host ? b?.hosts.find((x) => (x.local ? 'local' : x.id) === f.host) : null;
  const parts = [dir, f.project, f.folder && `フォルダ ${f.folder}`, sec && `§ ${sec}`, f.label && `ラベル: ${f.label === '__none' ? 'なし' : b?.labels.find(l => l.id === f.label)?.name || f.label}`,
    host && `マシン: ${host.local ? 'このマシン' : host.label}`].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'すべて';
}
function setScope(patch) {
  if (workspace.utilityPage()) workspace.navigate('home', { reload: false });
  Object.assign(state.filters, patch);
  saveFilters();
  state.shown = {};
  state.soloLane = null;
  load();
}
function scopePicker(anchor) {
  const b = state.board;
  const f = state.filters;
  picker(anchor, {
    title: `${T.category}・プロジェクトで絞り込み`, width: 340,
    selected: [f.directory ? `d:${f.directory}` : null, f.project ? `p:${f.project}` : null, f.folder ? `f:${f.folder}` : null, f.section ? `s:${f.section}` : null, f.label ? `l:${f.label}` : null, !f.label && !f.directory && !f.project && !f.folder && !f.section ? '' : null].filter((x) => x != null),
    items: [
      { value: '', label: 'すべて（絞り込みを解除）' },
      ...directoryItems(false).map((it) => ({ ...it, value: `d:${it.value}`, group: `${T.category}` })),
      ...b.projects.map((p) => ({ value: `p:${p.name}`, label: p.name, hint: p.count, group: 'プロジェクト（Codex のプロジェクト、なければフォルダ名）' })),
      ...(b.folders || []).map((x) => ({ value: `f:${x.name}`, label: x.name, hint: x.count, group: `${T.folder}（Codex のプロジェクトに入っているもの）` })),
      { value: 'l:__none', label: 'ラベルなし', group: 'ラベル' },
      ...b.labels.map(l => ({ value: `l:${l.id}`, label: l.name, color: l.color, group: 'ラベル' })),
      ...(b.codexSections || []).map((x) => ({ value: `s:${x.id}`, label: `§ ${x.name}`, hint: x.count, group: 'Codex セクション' })),
    ],
    onPick: (v) => {
      if (!v) return setScope({ directory: '', project: '', folder: '', section: '', label: '' });
      if (v.startsWith('l:')) return setScope({ label: f.label === v.slice(2) ? '' : v.slice(2) });
      if (v.startsWith('s:')) return setScope({ section: f.section === v.slice(2) ? '' : v.slice(2) });
      if (v.startsWith('d:')) setScope({ directory: f.directory === v.slice(2) ? '' : v.slice(2), project: '', folder: '' });
      else if (v.startsWith('f:')) setScope({ folder: f.folder === v.slice(2) ? '' : v.slice(2) });
      else setScope({ project: f.project === v.slice(2) ? '' : v.slice(2) });
    },
  });
}
// Make a category from a Codex project: same name, and its folders so that the
// project's sessions join automatically.
function toggleSidebar(open = !state.sideOpen) {
  state.sideOpen = open;
  store.set('sidebar', open);
  if (state.board) renderSidebar(state.board);
  if (open) state.sideInput?.focus();
}
// Sidebar entries that open something other than a filter: [page, icon, label, key hint].
// 見る opens a sheet on the overlay; 管理 opens the management panel next to the sidebar. Pressing the open one again closes it.
// カテゴリ is managed from the ⚙ beside the category list, so it has no entry of its own here.
const SIDE_LOOK = [['analytics', 'chart', '分析', 'a'], ['usage', 'gauge', 'Agent Usage', '']];
const SIDE_MANAGE = [['rules', 'zap', T.automation], ['labels', 'tag', 'ラベル'], ['views', 'bookmark', '保存ビュー'], ['hosts', 'server', 'マシン'], ['slack', 'message', 'Slack接続'], ['settings', 'gear', '設定']];
// The axes a lane can follow, in the order the sidebar offers them; the rest sit behind ⋯.
const LANE_AXES = [['', 'なし'], ['directory', T.category], ['agent', 'AI Apps'], ['host', 'マシン'], ['label', 'ラベル']];
const LANE_MORE = [['project', 'プロジェクト'], ['section', 'Codex セクション'], ['account', 'アカウント']];
function sideCount(b, page) {
  return { rules: b.settings?.rules?.length, views: b.settings?.views?.length, labels: b.labels?.length, directories: b.directories?.length,
    hosts: (b.hosts || []).filter((x) => !x.local && x.enabled).length || null }[page] ?? null;
}
function sideEntry(b, [page, icon, label, key]) {
  const n = sideCount(b, page);
  return h('button', { class: 'side-row side-entry', 'data-page': page, title: `${label}${key ? `（${key}）` : ''}`,
    'aria-current': workspace.current() === page ? 'page' : 'false', onclick: () => (VIEW_SHEETS[page] ? toggleView(page) : workspace.toggle(page)) },
    h('span', { class: 'side-ic', html: picon(icon, 18) }), h('span', { class: 'grow ellipsis', text: label }),
    n == null ? null : h('span', { class: 'count', text: String(n) }));
}
const sideHead = (title, ...extra) => h('div', { class: 'side-head' }, h('span', { class: 'grow', text: title }), ...extra);
const sideCountEl = (n) => h('span', { class: 'count', text: String(n ?? '') });
function setLaneAxis(mode) {
  state.filters.swimlane = mode; state.soloLane = null;
  // The axis now shown as lanes stops filtering, so every lane has its cards.
  const key = LANE_FILTER[mode];
  if (key && (key === 'agent' ? state.filters.agent !== 'all' : state.filters[key])) return setScope({ [key]: key === 'agent' ? 'all' : '' });
  saveFilters(); render();
}
// Running / waiting sessions per category, shown beside the name.
function liveByDirectory(b) {
  const by = new Map();
  for (const c of b.lists.flatMap((l) => l.cards)) {
    if (c.status !== 'running' && c.status !== 'waiting') continue;
    const key = c.directory?.id || '__none', v = by.get(key) || { running: 0, waiting: 0 };
    v[c.status]++; by.set(key, v);
  }
  return by;
}
function liveBadges(v) {
  return [v?.running ? h('span', { class: 'dir-live s-run', title: `実行中 ${v.running}`, text: String(v.running) }) : null,
    v?.waiting ? h('span', { class: 'dir-live s-wait', title: `入力待ち ${v.waiting}`, text: String(v.waiting) }) : null];
}
// レーン: the axis, then one row per lane. A row jumps to its lane; ▾ folds it; ⌥ shows it alone.
function laneSection(b, hit) {
  const f = state.filters, mode = f.swimlane || '';
  const more = LANE_MORE.find(([k]) => k === mode);
  const axes = h('div', { class: 'side-seg side-seg-wrap', role: 'group', 'aria-label': 'レーンの軸' },
    ...LANE_AXES.map(([k, label]) => h('button', { type: 'button', 'aria-pressed': String(mode === k), text: label, onclick: () => setLaneAxis(k) })),
    h('button', { type: 'button', 'aria-pressed': String(!!more), title: 'ほかの軸（プロジェクト・Codex セクション・アカウント）', text: more ? more[1] : '⋯',
      onclick: (e) => popover(e.currentTarget, 'レーンの軸', h('div', {}, LANE_MORE.map(([k, label]) => h('button', { class: 'menu-item', text: label, onclick: () => { closePopover(); setLaneAxis(k); } }))), { width: 240 }) }));
  const tools = mode ? [h('button', { class: 'side-mini', title: 'すべて展開', text: '⊞', onclick: () => setAllLanes(false) }),
    h('button', { class: 'side-mini', title: 'すべてたたむ', text: '⊟', onclick: () => setAllLanes(true) })] : [];
  const nodes = [sideHead('レーン', ...tools), axes];
  if (!mode) nodes.push(h('label', { class: 'side-check' }, h('input', { type: 'checkbox', checked: !!f.groupBranch, onchange: (e) => { f.groupBranch = e.target.checked; saveFilters(); load(); } }), '同じリポジトリ＋ブランチをまとめる'));
  // The height of a lane's lists belongs to the lanes, so it sits with them (and only while there are lanes).
  else nodes.push(h('div', { class: 'side-seg', role: 'group', 'aria-label': 'レーン内のリストの高さ' }, Object.entries(LANE_HEIGHTS).map(([k, [label]]) =>
    h('button', { type: 'button', 'aria-pressed': String((f.laneHeight || 'normal') === k), title: `レーン内のリストの高さ: ${label}`, text: label, onclick: () => { f.laneHeight = k; saveFilters(); render(); } }))));
  const live = mode === 'directory' ? liveByDirectory(b) : null;
  for (const lane of state.lanes.filter((l) => hit(l.name))) {
    const collapsed = collapsedLanes.has(lane.key) || collapsedLanes.has(lane.name);
    const status = lane.running ? 'running' : lane.waiting ? 'waiting' : null;
    const row = h('button', { class: `side-row${state.soloLane === lane.key ? ' active' : ''}`, 'data-lane': lane.key, title: 'クリック: そのレーンへ移動 / ⌥クリック: このレーンだけ表示',
      onclick: (e) => (e.target.closest('.lane-fold') ? (collapsed ? collapsedLanes.delete(lane.key) : collapsedLanes.add(lane.key), collapsedLanes.delete(lane.name), store.set('collapsedLanes', [...collapsedLanes]), render())
        : e.altKey ? setSolo(state.soloLane === lane.key ? null : lane.key) : jumpToLane(lane.key)) },
      h('span', { class: 'lane-fold', title: collapsed ? '開く' : 'たたむ', text: collapsed ? '▸' : '▾' }),
      lane.color ? h('span', { class: 'dot', style: { background: colorVar(lane.color) } }) : null,
      h('span', { class: 'grow ellipsis', text: lane.name }),
      ...(live ? liveBadges(live.get(lane.dirId)) : [status ? h('span', { class: `sdot s-${status}`, title: STATUS_LABELS[status] }) : null]),
      lane.unread ? h('span', { class: 'side-new', title: '新着', text: lane.unread }) : null,
      sideCountEl(lane.count));
    // Lanes by category stay drop targets: dropping a card on one moves it to that category.
    nodes.push(lane.dirId ? h('div', { class: 'side-item side-dir', 'data-dir-id': lane.dirId }, row,
      lane.dirId === '__none' ? null : h('button', { class: 'icon-btn', 'aria-label': `${lane.name} の設定`, text: '⋯', onclick: (e) => directoryMenu(e.currentTarget, lane.dirId) })) : row);
  }
  if (mode === 'directory') nodes.push(newCategoryInput(b));
  return h('section', { class: 'side-sec-lanes' }, nodes);
}
function newCategoryInput(b) {
  return h('input', { class: 'side-filter', placeholder: `＋ 新しい${T.category}（Enter）`, 'aria-label': `新しい${T.category}`,
    onkeydown: (e) => {
      if (e.key !== 'Enter' || e.isComposing || !e.target.value.trim()) return;
      act('canban_create_directory', { name: e.target.value.trim(), color: COLORS[(b.directories.length + 1) % COLORS.length] }, { okMsg: `${T.category}を作成しました` }).catch(() => {});
    } });
}
// 絞り込み: nothing chosen shows every card; pressing a value shows only those, pressing it again lifts it.
function filterSection(b, hit = () => true) {
  const f = state.filters, nodes = [sideHead('絞り込み', filterChips(b).length ? h('button', { class: 'side-mini', title: '絞り込みをすべて解除', text: '解除', onclick: clearFilters }) : null)];
  const seg = (label, items, on, pick) => h('div', { class: 'side-seg', role: 'group', 'aria-label': label }, items.map(([k, t]) => h('button', { type: 'button', 'aria-pressed': String(on(k)), text: t, onclick: () => pick(k) })));
  if (!laneHides('agent')) nodes.push(seg(T.aiApps, [['all', 'すべて'], ['codex', 'Codex'], ['claude', 'Claude']], (k) => f.agent === k, (k) => setScope({ agent: k })));
  const group = (title, rows, extra) => { const shown = rows.filter((r) => r && hit(r.label)); if (shown.length) nodes.push(sideHead(title, extra), ...shown.map((r) => r.el)); };
  const choice = (label, on, pick, lead, ...tail) => ({ label, el: h('button', { class: `side-row${on ? ' active' : ''}`, 'aria-pressed': String(on), onclick: pick }, lead, h('span', { class: 'grow ellipsis', text: label }), ...tail) });
  group('状態', ['running', 'waiting', 'completed', 'aborted', 'idle'].filter((k) => b.statusCounts?.[k] || f.status === k).map((k) =>
    choice(STATUS_LABELS[k], f.status === k, () => setScope({ status: f.status === k ? '' : k }), h('span', { class: `sdot s-${k}` }), sideCountEl(b.statusCounts?.[k] || 0))));
  if (!laneHides('directory')) {
    const live = liveByDirectory(b);
    const dirs = [...b.directories, { id: '__none', name: 'カテゴリ無し', color: null, count: b.uncategorizedCount || 0 }];
    group(T.category, dirs.map((d) => ({ label: d.name, el: h('div', { class: 'side-item side-dir', 'data-dir-id': d.id },
      h('button', { class: `side-row${f.directory === d.id ? ' active' : ''}`, 'aria-pressed': String(f.directory === d.id), title: 'クリックで絞り込み（もう一度で解除）。カードをここへドラッグすると所属を変えられます',
        onclick: () => setScope({ directory: f.directory === d.id ? '' : d.id }) },
        h('span', { class: 'dot', style: { background: d.color ? colorVar(d.color) : 'var(--header-btn-hover)' } }),
        h('span', { class: 'grow ellipsis', text: d.name }), ...liveBadges(live.get(d.id)), sideCountEl(d.count)),
      d.id === '__none' ? null : h('button', { class: 'icon-btn', 'aria-label': `${d.name} の設定`, text: '⋯', onclick: (e) => directoryMenu(e.currentTarget, d.id) })) })),
      h('button', { class: 'side-mini', title: `${T.category}を管理`, 'aria-label': `${T.category}を管理`, html: picon('gear', 14), onclick: () => workspace.toggle('directories') }));
  }
  const hosts = (b.hosts || []).filter((x) => x.local || x.enabled);
  if (!laneHides('host') && hosts.length > 1) group('マシン', hosts.map((x) => { const id = x.local ? 'local' : x.id;
    return choice(x.local ? 'このマシン' : x.label, f.host === id, () => setScope({ host: f.host === id ? '' : id }), h('span', { class: 'side-ic', html: picon('server', 15) })); }));
  if (!laneHides('label') && b.labels.length) group('ラベル', [...b.labels.map((l) => ({ id: l.id, name: l.name, color: l.color })), { id: '__none', name: 'ラベルなし', color: null }].map((l) =>
    choice(l.name, f.label === l.id, () => setScope({ label: f.label === l.id ? '' : l.id }), h('span', { class: 'dot', style: { background: l.color ? colorVar(l.color) : 'var(--header-btn-hover)' } }))));
  const scope = (key, label) => h('label', { class: 'side-check' }, h('input', { type: 'checkbox', checked: !!f[key], onchange: (e) => setScope({ [key]: e.target.checked }) }), label);
  nodes.push(h('label', { class: 'side-check' }, h('input', { type: 'checkbox', checked: slackUi.visible, onchange: e => slackUi.toggle(e.target.checked) }), 'Slackタイムライン ', keycap('v')));
  nodes.push(sideHead('表示する対象'), scope('includeArchived', 'アーカイブ済みも表示'), scope('includeSubagents', 'サブエージェントも表示'), scope('pinnedOnly', 'Codex でピン留めしたものだけ'));
  return h('section', { class: 'side-sec-filters' }, nodes);
}
// The foot of the sidebar: the sheets, the management pages and the color theme.
function sideFoot(b) {
  return h('div', { class: 'side-foot' },
    h('div', { class: 'side-foot-look side-sec-look' }, SIDE_LOOK.map((x) => sideEntry(b, x))),
    h('div', { class: 'side-head side-sec-manage' }, h('span', { class: 'grow', text: '管理' })),
    h('div', { class: 'side-foot-grid side-sec-manage' }, SIDE_MANAGE.map((x) => sideEntry(b, x))),
    h('button', { class: 'side-row side-entry', type: 'button', 'data-look': '', title: 'ライト・ダーク・システム', onclick: (e) => themeMenu(e.currentTarget) },
      h('span', { class: 'side-ic', html: picon(THEME_CHOICES.find(([k]) => k === (state.themePref || 'system'))[1], 18) }), h('span', { class: 'grow ellipsis', text: '色' }),
      h('span', { class: 'count', text: THEME_CHOICES.find(([k]) => k === (state.themePref || 'system'))[2] })));
}
function renderSidebar(b) {
  const el = $('#sidebar');
  $('#sideBtn').setAttribute('aria-pressed', String(state.sideOpen));
  el.hidden = !state.sideOpen;
  document.body.classList.toggle('side-closed', el.hidden);
  if (el.hidden) return;
  if (!state.sideInput) {
    state.sideInput = h('input', { class: 'side-filter', type: 'search', placeholder: 'サイドバーを絞り込み…', 'aria-label': 'サイドバーを絞り込み',
      oninput: (e) => { state.sideQ = e.target.value; renderSidebar(state.board); },
      onkeydown: (e) => {
        if (e.key === 'Escape') { e.target.value = ''; state.sideQ = ''; renderSidebar(state.board); $('#board .card')?.focus(); }
        if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); const r = $('#sidebar .side-row'); e.key === 'Enter' ? r?.click() : r?.focus(); }
      } });
  }
  const hit = matcher(state.sideQ.trim());
  const scroll = $('.side-scroll', el)?.scrollTop || 0;
  const secs = [h('div', { class: 'side-top' }, h('span', { class: 'grow', text: 'ワークスペース' }),
      h('button', { class: 'side-fold', type: 'button', title: 'サイドバーを畳む（b）', 'aria-label': 'サイドバーを畳む', html: picon('chev', 18), onclick: () => toggleSidebar(false) })),
    state.sideInput];
  const views = (b.settings?.views || []).map((v, i) => ({ v, i })).filter(({ v }) => hit(v.name)), current = activeView(b);
  secs.push(h('section', { class: 'side-sec-views' }, sideHead('ビュー', h('button', { class: 'side-mini', title: '今の絞り込みをビューとして保存', text: '＋ 保存', onclick: () => workspace.toggle('views') })),
    h('button', { class: `side-row${!current && !filterChips(b).length ? ' active' : ''}`, onclick: clearFilters }, h('span', { class: 'side-ic side-key', text: '0' }), h('span', { class: 'grow ellipsis', text: 'すべてのセッション' })),
    views.map(({ v, i }) => h('button', { class: `side-row${current === v ? ' active' : ''}`, title: i < 9 ? `${v.name}（${i + 1}）` : v.name, onclick: () => applyView(v) },
      h('span', { class: 'side-ic side-key', text: i < 9 ? String(i + 1) : '' }), h('span', { class: 'grow ellipsis', text: v.name })))));
  secs.push(laneSection(b, hit), filterSection(b, hit));
  const had = document.activeElement === state.sideInput;
  el.replaceChildren(h('div', { class: 'side-scroll' }, ...secs), sideFoot(b));
  $('.side-scroll', el).scrollTop = scroll;
  if (had) state.sideInput.focus();
}

function directoryMenu(anchor, dirId) {
  const d = state.board.directories.find((x) => x.id === dirId);
  if (!d) return;
  const again = () => directoryMenu(anchor.isConnected ? anchor : $('#logo'), dirId);
  const name = h('input', { class: 'text-input', value: d.name, 'aria-label': `${T.category}名` });
  name.onchange = () => name.value.trim() && act('canban_update_directory', { directoryId: d.id, name: name.value }).then(again);
  const folders = h('datalist', { id: `dirf-${d.id}` }, state.board.folders.filter((x) => x.hostId === 'local').map((x) => h('option', { value: x.cwd, label: x.project || '' })));
  const path = h('input', { class: 'text-input', list: folders.id, placeholder: '/path/to/folder（Enter で追加）', 'aria-label': 'タスクの自動分類に使うフォルダ' });
  path.onkeydown = (e) => {
    if (e.key !== 'Enter' || e.isComposing || !path.value.trim().startsWith('/')) return;
    act('canban_update_directory', { directoryId: d.id, paths: [...d.paths, path.value.trim()] }, { okMsg: 'フォルダを追加しました' }).then(again);
  };
  const del = h('button', { class: 'menu-item danger', text: `この${T.category}を削除…`,
    onclick: () => { if (confirmInline(del, `「${d.name}」を削除します（カードやセッションは消えず、このカテゴリの自動分類も解除されます）。`)) act('canban_delete_directory', { directoryId: d.id }, { okMsg: '削除しました' }).then(() => closePopover()); } });
  popover(anchor, `${T.category}の設定`, h('div', {},
    name,
    h('div', { class: 'field-label', text: '色' }),
    h('div', { class: 'swatches' }, [null, ...COLORS].map((c) => h('button', { class: 'swatch', title: c ? COLOR_NAMES[c] : '色なし', 'aria-label': c ? COLOR_NAMES[c] : '色なし', 'aria-pressed': String((d.color || null) === c),
      style: { background: c ? colorVar(c) : 'var(--btn-subtle-hover)' }, text: c ? '' : '✕', onclick: () => act('canban_update_directory', { directoryId: d.id, color: c }).then(again) }))),
    h('div', { class: 'field-label' }, 'タスクの自動分類に使うフォルダ ', helpTip('セッションの自動分類には Codex の project、Claude の group（なければ作業フォルダ）を使います。カードのカテゴリは個別に変更できます。')),
    ...d.paths.map((pth) => h('div', { class: 'rule-row' }, h('span', { class: 'ellipsis grow', title: pth, text: pth }),
      h('button', { class: 'icon-btn', 'aria-label': `${pth} を外す`, text: '✕', onclick: () => act('canban_update_directory', { directoryId: d.id, paths: d.paths.filter((x) => x !== pth) }).then(again) }))),
    path, folders,
    h('div', { class: 'sep' }),
    h('button', { class: 'menu-item', text: `この${T.category}だけを表示`, onclick: () => { closePopover(); setScope({ directory: d.id }); } }),
    del), { width: 340 });
}


function syncHeaderInputs() {
  $('#q').value = state.filters.q || '';
  $('#fulltext').checked = !!state.filters.fulltext;
}
function applyView(v) {
  workspace.navigate('home', { reload: false });
  state.filters = { ...DEFAULT_FILTERS, ...v.filters };
  state.soloLane = null;
  saveFilters();
  syncHeaderInputs();
  state.shown = {};
  toast(`ビュー「${v.name}」`);
  load();
}
function viewsMenu(anchor) {
  const views = state.board?.settings?.views || [];
  const name = h('input', { class: 'text-input', placeholder: '今の表示に名前を付けて保存', maxlength: 60 });
  const save = () => name.value.trim() && act('canban_save_view', { name: name.value, filters: state.filters }, { okMsg: 'ビューを保存しました' }).then(() => viewsMenu(anchor));
  name.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) save(); };
  const rows = views.map((v, i) => h('div', { class: 'rule-row', 'data-key': v.name },
      h('button', { class: 'menu-item', onclick: () => { closePopover(); applyView(v); } }, h('span', { class: 'kbd', text: i < 9 ? String(i + 1) : '' }), ` ${v.name}`),
      h('button', { class: 'icon-btn', 'aria-label': `${v.name} を削除`, text: '🗑', onclick: () => act('canban_delete_view', { viewId: v.id }).then(() => viewsMenu(anchor)) })));
  popover(anchor, 'ビュー', h('div', {},
    views.length > 5 ? rowFilter(rows) : null,
    rows.length ? rows : h('p', { class: 'muted', text: '保存したビューはまだありません' }),
    h('div', { class: 'sep' }), name,
    h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn-primary', text: '保存', onclick: save })),
    h('p', { class: 'muted', text: '絞り込み・検索・スイムレーン・表示オプションを保存します。数字キー 1〜9 で切り替えられます。' })), { width: 320 });
}

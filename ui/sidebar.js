// Part of board.html: included into its script by server/ui.mjs and shares its scope.
// Sidebar: lanes (jump), directories and projects (one-click filters)
// ---- filters in effect, as chips in the app bar (each ✕ takes one off) ----
const FILTER_KEYS = ['sourceFilters', 'cardKind', 'workingFolder', 'agent', 'days', 'status', 'directory', 'repo', 'worktree', 'dirName', 'project', 'folder', 'section', 'label', 'host', 'account', 'includeArchived', 'includeSubagents', 'dotScope', 'pinnedOnly'];
const sameFilters = (a, b) => FILTER_KEYS.every((k) => JSON.stringify(a[k] ?? DEFAULT_FILTERS[k]) === JSON.stringify(b[k] ?? DEFAULT_FILTERS[k]));
function activeView(b) { return (b?.settings?.views || []).find((v) => sameFilters({ ...DEFAULT_FILTERS, ...v.filters }, state.filters)); }
// The lane axis is not also a filter: lanes by category already show every category.
const LANE_FILTER = { directory: 'directory', repo: 'repo', worktree: 'worktree', dirName: 'dirName', status: 'status', agent: 'agent', host: 'host', label: 'label', project: 'project', section: 'section', account: 'account' };
const laneHides = (key) => state.filters.swimlane === key || LANE_FILTER[state.filters.swimlane] === key;
function filterChips(b) {
  const f = state.filters, out = [];
  const add = (text, patch) => out.push({ text, patch });
  const agLbl = typeof agentLabel === 'function' ? agentLabel(f.agent) : ({ codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity', gemini: 'Gemini CLI', cursor: 'Cursor', chatgpt: 'ChatGPT', grok: 'Grok' }[f.agent] || f.agent);
  if (f.agent !== 'all' && !laneHides('agent')) add(agLbl, { agent: 'all' });
  if (f.status && !laneHides('status')) add(STATUS_LABELS[f.status] || f.status, { status: '' });
  if (f.directory && !laneHides('directory')) add(f.directory === '__none' ? 'カテゴリ無し' : b?.directories.find((d) => d.id === f.directory)?.name || f.directory, { directory: '' });
  if (f.repo && !laneHides('repo')) add(`リポジトリ: ${f.repo === '__none' ? '不明' : f.repo}`, { repo: '' });
  if (f.worktree && !laneHides('worktree')) add(`ワークツリー: ${f.worktree === '__only' ? 'すべて' : f.worktree === '__none' ? 'なし' : f.worktree}`, { worktree: '' });
  if (f.dirName && !laneHides('dirName')) add(`ディレクトリ: ${f.dirName === '__none' ? 'なし' : f.dirName}`, { dirName: '' });
  if (f.project && !laneHides('project')) add(f.project, { project: '' });
  for (const selection of f.sourceFilters || []) {
    const facet = b?.sourceFacets?.find(x => x.key === sourceRefKey(selection.ref)) || selection;
    add(sourceFacetLabel(facet), { sourceFilters: f.sourceFilters.filter(x => x !== selection) });
  }
  if (f.folder) add(`旧フォルダ条件 ${f.folder}`, { folder: '' });
  if (f.workingFolder) add(`作業フォルダ ${f.workingFolder}`, { workingFolder: '' });
  if (f.cardKind && f.cardKind !== 'all') add(f.cardKind === 'task' ? 'タスクカードのみ' : 'セッションカードのみ', { cardKind: 'all' });
  if (f.section && !laneHides('section')) add(`§ ${f.section === '__none' ? 'セクションなし' : b?.codexSections?.find((x) => x.id === f.section)?.name || f.section}`, { section: '' });
  if (f.label && !laneHides('label')) add(`ラベル: ${f.label === '__none' ? 'なし' : b?.labels.find((l) => l.id === f.label)?.name || f.label}`, { label: '' });
  if (f.host && !laneHides('host')) {
    if (f.host === 'cloud') add('環境: クラウド', { host: '' });
    else { const x = b?.hosts.find((y) => (y.local ? 'local' : y.id) === f.host); add(x?.local ? '環境: このマシン' : `環境: ${x?.label || f.host}`, { host: '' }); }
  }
  if (f.account && !laneHides('account')) add(`アカウント: ${f.account === '__none' ? 'アカウント不明' : accountName(f.account)}`, { account: '' });
  if (f.dotScope !== 'all') add(f.dotScope === 'only' ? 'dotだけ' : 'dotを除く', { dotScope: 'all' });
  if (f.includeArchived) add('アーカイブ済みも表示', { includeArchived: false });
  if (f.includeSubagents) add('サブエージェントも表示', { includeSubagents: false });
  if (f.pinnedOnly) add('ピン留めだけ', { pinnedOnly: false });
  return out;
}
function clearFilters() {
  const keep = { swimlane: state.filters.swimlane, laneHeight: state.filters.laneHeight, groupBranch: state.filters.groupBranch, fulltext: state.filters.fulltext, q: state.filters.q };
  setScope({ ...Object.fromEntries(FILTER_KEYS.map((k) => [k, DEFAULT_FILTERS[k]])), days: 0, dotScope: 'all', ...keep });
}
function renderFilterChips(b) {
  const chips = filterChips(b);
  const fam = state.lens?.family ? [h('button', { class: 'filter-chip', type: 'button', title: '親子の照らしを解除（Esc）', 'aria-label': '親子の照らしを解除', onclick: () => pinLens(null) }, `親子: ${state.lens.title || '照らし中'}`, h('span', { class: 'x', text: '✕' }))] : [];
  $('#filterChips').replaceChildren(...fam, ...chips.map(({ text, patch }) => h('button', { class: 'filter-chip', type: 'button', title: `${text} を外す`, 'aria-label': `${text} を外す`, onclick: () => setScope(patch) }, text, h('span', { class: 'x', text: '✕' }))),
    ...(chips.length > 1 ? [h('button', { class: 'filter-chip chip-clear', type: 'button', text: 'すべて解除', onclick: clearFilters })] : []));
}
function scopeLabel(b) {
  const f = state.filters;
  const dir = f.directory === '__none' ? 'カテゴリ無し' : b?.directories.find((d) => d.id === f.directory)?.name;
  const sec = f.section === '__none' ? 'セクションなし' : b?.codexSections?.find((x) => x.id === f.section)?.name;
  const host = f.host === 'cloud' ? 'クラウド' : (f.host ? ((b?.hosts || []).find((x) => (x.local ? 'local' : x.id) === f.host)?.local ? 'このマシン' : (b?.hosts || []).find((x) => x.id === f.host)?.label || f.host) : null);
  const parts = [dir, f.repo && `リポジトリ: ${f.repo}`, f.worktree && `ワークツリー: ${f.worktree}`, f.dirName && `ディレクトリ: ${f.dirName}`, f.project, f.folder && `旧フォルダ条件 ${f.folder}`, f.workingFolder && `作業フォルダ ${f.workingFolder}`, sec && `§ ${sec}`, f.label && `ラベル: ${f.label === '__none' ? 'なし' : b?.labels.find(l => l.id === f.label)?.name || f.label}`,
    host && `環境: ${host}`].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'すべて';
}
function toggleDotScope() { setScope({ dotScope: state.filters.dotScope === 'exclude' ? 'all' : 'exclude' }); }
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
  if (!b) { toast(state.boardError ? 'ボードを読み込めませんでした。更新で再試行してください' : 'ボードを読み込んでいます。取得後に絞り込めます', !!state.boardError); return; }
  const f = state.filters;
  const agentCounts = b?.totals?.byAgent || {};
  picker(anchor, {
    title: `${T.category}・横断軸・元アプリで絞り込み`, width: 340,
    selected: [...(f.sourceFilters || []).map(x => `source:${sourceRefKey(x.ref)}`), f.agent && f.agent !== 'all' ? `ag:${f.agent}` : null, f.directory ? `d:${f.directory}` : null, f.repo ? `repo:${f.repo}` : null, f.worktree ? `wt:${f.worktree}` : null, f.dirName ? `dn:${f.dirName}` : null, f.host ? `host:${f.host}` : null, f.project ? `p:${f.project}` : null, f.workingFolder ? `wf:${f.workingFolder}` : null, f.folder ? `f:${f.folder}` : null, f.section ? `s:${f.section}` : null, f.label ? `l:${f.label}` : null, (!f.agent || f.agent === 'all') && !f.label && !f.directory && !f.repo && !f.worktree && !f.dirName && !f.host && !f.project && !f.folder && !f.workingFolder && !f.section ? '' : null].filter((x) => x != null),
    items: [
      { value: '', label: 'すべて（絞り込みを解除）' },
      ...(!laneHides('agent') ? Object.entries(AGENT_META).map(([ag, meta]) => ({
        value: `ag:${ag}`,
        label: meta.app,
        keywords: `${ag} ${meta.label} ${meta.app}`,
        hint: agentCounts[ag]?.total ? `${agentCounts[ag].total}件` : '',
        group: T.aiApps,
      })) : []),
      ...directoryItems(false).map((it) => ({ ...it, value: `d:${it.value}`, group: `${T.category}` })),
      ...(!laneHides('repo') ? (b.repos || []).map(r => ({ value: `repo:${r.name}`, label: r.name, hint: `${r.count}件`, group: 'リポジトリ' })) : []),
      ...(!laneHides('worktree') ? [
        ...(b.worktrees?.length || f.worktree ? [{ value: 'wt:__only', label: 'ワークツリーのみ（全件）', group: 'ワークツリー' }] : []),
        ...(b.worktrees || []).map(w => ({ value: `wt:${w.key}`, label: w.name, hint: `${w.count}件`, group: 'ワークツリー' })),
      ] : []),
      ...(!laneHides('dirName') ? (b.dirNames || []).map(dn => ({ value: `dn:${dn.name}`, label: dn.name, hint: `${dn.count}件`, group: 'ディレクトリ名' })) : []),
      ...(!laneHides('host') ? [
        ...(b.hosts || []).filter(x => !x.cloud).map(x => { const id = x.local ? 'local' : x.id; return { value: `host:${id}`, label: x.local ? 'このマシン' : x.label, hint: x.count ? `${x.count}件` : '', group: '環境（マシン）' }; }),
        ...(b.cloudCount > 0 || f.host === 'cloud' ? [{ value: 'host:cloud', label: 'クラウド', hint: `${b.cloudCount || 0}件`, group: '環境（マシン）' }] : []),
      ] : []),
      ...(b.sourceFacets || []).filter(x => (isPrimarySourceRef(x.ref) || sourceFilterSelected(x.ref)) && !laneHides(sourceAxis(x.ref))).map(x => ({ value: `source:${x.key}`, label: sourceFacetLabel(x, b.sourceFacets), description: sourceFacetHint(x), keywords: sourceFacetTitle(x), hint: `${x.count}カード`, group: '元アプリ' })),
      ...(!laneHides('workingFolder') ? workingFolderFacets(b) : []).map((x) => ({ value: `wf:${x.cwd}`, label: x.name, description: (x.origins || []).map(o => o === 'planned' ? '開始予定' : '観測').join('・'), keywords: x.cwd, hint: x.count, group: '作業フォルダ' })),
      { value: 'l:__none', label: 'ラベルなし', group: 'ラベル' },
      ...b.labels.map(l => ({ value: `l:${l.id}`, label: l.name, color: l.color, group: 'ラベル' })),

    ],
    onPick: (v) => {
      if (!v) return setScope({ agent: 'all', directory: '', repo: '', worktree: '', dirName: '', host: '', project: '', folder: '', workingFolder: '', section: '', label: '', sourceFilters: [], cardKind: 'all' });
      if (v.startsWith('ag:')) return setScope({ agent: f.agent === v.slice(3) ? 'all' : v.slice(3) });
      if (v.startsWith('repo:')) return setScope({ repo: f.repo === v.slice(5) ? '' : v.slice(5) });
      if (v.startsWith('wt:')) return setScope({ worktree: f.worktree === v.slice(3) ? '' : v.slice(3) });
      if (v.startsWith('dn:')) return setScope({ dirName: f.dirName === v.slice(3) ? '' : v.slice(3) });
      if (v.startsWith('host:')) return setScope({ host: f.host === v.slice(5) ? '' : v.slice(5) });
      if (v.startsWith('source:')) return toggleSourceFilter(b.sourceFacets.find(x => x.key === v.slice(7)).ref);
      if (v.startsWith('l:')) return setScope({ label: f.label === v.slice(2) ? '' : v.slice(2) });
      if (v.startsWith('s:')) return setScope({ section: f.section === v.slice(2) ? '' : v.slice(2) });
      if (v.startsWith('wf:')) return setScope({ workingFolder: f.workingFolder === v.slice(3) ? '' : v.slice(3) });
      if (v.startsWith('d:')) setScope({ directory: f.directory === v.slice(2) ? '' : v.slice(2), project: '', folder: '', workingFolder: '' });
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
const SIDE_LOOK = [['analytics', 'chart', '分析', 'a'], ['usage', 'gauge', 'Agent Usage', ''], ['orbit', 'refresh', '軌道', 'Shift+O']];
const SIDE_MANAGE = [['rules', 'zap', T.automation], ['labels', 'tag', 'ラベル'], ['views', 'bookmark', '保存ビュー'], ['hosts', 'server', 'マシン'], ['slack', 'message', 'Slack接続'], ['settings', 'gear', '設定']];
// The axes a lane can follow, in the order the sidebar offers them; the rest sit behind ⋯.
const LANE_AXES = [
  ['', 'なし'],
  ['directory', T.category],
  ['repo', 'リポジトリ'],
  ['host', '環境'],
  ['status', '状態'],
  ['agent', 'AI Apps'],
];
const SIDE_SOURCE_TOP = 5; // rows per 元アプリ axis before the rest fold into 「ほか N 件…」
const LANE_MORE = [
  ['worktree', 'ワークツリー'],
  ['dirName', 'ディレクトリ名'],
  ['branch', 'ブランチ'],
  ['workingFolder', '作業フォルダ'],
  ['label', 'ラベル'],
  ['account', 'アカウント'],
];
function laneAxisPicker(anchor = null) {
  const b = state.board;
  if (!b) { toast(state.boardError ? 'ボードを読み込めませんでした。更新で再試行してください' : 'ボードを読み込んでいます。取得後にレーンを選べます', !!state.boardError); return; }
  picker(anchor || $('#sideBtn'), {
    title: 'レーン（グループ分け）の軸', width: 280,
    selected: [state.filters.swimlane || ''],
    items: [
      ...LANE_AXES.map(([k, label]) => ({ value: k, label, group: '主な軸' })),
      ...LANE_MORE.map(([k, label]) => ({ value: k, label, group: 'その他の軸' })),
    ],
    onPick: (v) => setLaneAxis(v),
  });
}
function sideCount(b, page) {
  return { rules: b.settings?.rules?.length, views: b.settings?.views?.length, labels: b.labels?.length, directories: b.directories?.length,
    hosts: (b.hosts || []).filter((x) => !x.local && !x.cloud && x.enabled).length || null }[page] ?? null;
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
  if (isSourceAxis(mode)) {
    const sourceFilters = (state.filters.sourceFilters || []).filter(f => sourceAxis(f.ref) !== mode);
    if (sourceFilters.length !== (state.filters.sourceFilters || []).length || mode === 'workingFolder' && (state.filters.folder || state.filters.workingFolder)) return setScope({ sourceFilters, ...(mode === 'workingFolder' ? { folder: '', workingFolder: '' } : {}) });
  }
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
  const more = !LANE_AXES.some(([k]) => k === mode) && mode ? (LANE_MORE.find(([k]) => k === mode) || [mode, LANE_MODES[mode] || SOURCE_AXES[mode] || SOURCE_LEGACY_AXES[mode] || mode]) : null;
  const axes = h('div', { class: 'side-seg side-seg-wrap', role: 'group', 'aria-label': 'レーンの軸' },
    ...LANE_AXES.map(([k, label]) => h('button', { type: 'button', 'aria-pressed': String(mode === k), text: label, onclick: () => setLaneAxis(k) })),
    h('button', { type: 'button', 'aria-pressed': String(!!more), title: 'ほかの軸（ワークツリー・ディレクトリ名・ブランチ・作業フォルダ・ラベル・アカウント）', text: more ? more[1] : '⋯',
      onclick: (e) => popover(e.currentTarget, 'レーンの軸', h('div', {}, LANE_MORE.map(([k, label]) => h('button', { class: 'menu-item', text: label, onclick: () => { closePopover(); setLaneAxis(k); } }))), { width: 240 }) }));
  const tools = mode ? [h('button', { class: 'side-mini', title: 'すべて展開', text: '⊞', onclick: () => setAllLanes(false) }),
    h('button', { class: 'side-mini', title: 'すべてたたむ', text: '⊟', onclick: () => setAllLanes(true) })] : [];
  const nodes = [sideHead('レーン', ...keycap('Shift+G'), ...tools), axes];
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
function aiAppsFilterNodes(b, f, hit, seg) {
  const byAgent = b.totals?.byAgent || {};
  const countOf = (ag) => byAgent[ag]?.total ?? (ag === 'codex' ? b.totals?.codex || 0 : ag === 'claude' ? b.totals?.claude || 0 : 0);
  const extraAgents = Object.keys(AGENT_META).filter((ag) => ag !== 'codex' && ag !== 'claude');
  const activeExtras = extraAgents.filter((ag) => countOf(ag) > 0 || f.agent === ag);
  const idleExtras = extraAgents.filter((ag) => !activeExtras.includes(ag));
  const out = [seg(T.aiApps, [['all', 'すべて'], ['codex', 'Codex'], ['claude', 'Claude']], (k) => f.agent === k, (k) => setScope({ agent: k }))];
  const appRows = [];
  for (const ag of activeExtras) {
    const meta = AGENT_META[ag];
    if (!hit(meta.label) && !hit(meta.app)) continue;
    const stats = byAgent[ag] || { total: countOf(ag), running: 0, waiting: 0 };
    const on = f.agent === ag;
    appRows.push(h('button', {
      type: 'button',
      class: `side-app-row${on ? ' active' : ''}`,
      'aria-pressed': String(on),
      title: `${meta.app} で絞り込み（${SURFACE_META[meta.defaultSurface]?.title || ''}）`,
      onclick: () => setScope({ agent: on ? 'all' : ag }),
    },
      h('span', { class: 'side-app-dot', style: { background: meta.color } }),
      h('span', { class: 'grow ellipsis', text: meta.label }),
      ...liveBadges(stats),
      sideCountEl(stats.total)));
  }
  if (idleExtras.length && !state.sideQ.trim()) {
    appRows.push(h('button', {
      type: 'button',
      class: 'side-row side-more',
      title: 'すべての AI App から選ぶ',
      onclick: (e) => picker(e.currentTarget, {
        title: `${T.aiApps}で絞り込み`,
        width: 280,
        selected: [f.agent || 'all'],
        items: [
          { value: 'all', label: 'すべての AI App' },
          ...Object.entries(AGENT_META).map(([ag, meta]) => ({
            value: ag,
            label: meta.app,
            description: SURFACE_META[meta.defaultSurface]?.title || '',
            hint: countOf(ag) ? `${countOf(ag)}件` : '0件',
          })),
        ],
        onPick: (v) => setScope({ agent: v === f.agent ? 'all' : v }),
      }),
    }, h('span', { class: 'grow', text: `ほかの AI App（${idleExtras.length}）…` })));
  }
  if (appRows.length) out.push(h('div', { class: 'side-apps' }, ...appRows));
  return out;
}

// 絞り込み: nothing chosen shows every card; pressing a value shows only those, pressing it again lifts it.
function filterSection(b, hit = () => true) {
  const f = state.filters, nodes = [sideHead('絞り込み', filterChips(b).length ? h('button', { class: 'side-mini', title: '絞り込みをすべて解除', text: '解除', onclick: clearFilters }) : null)];
  const seg = (label, items, on, pick) => h('div', { class: 'side-seg', role: 'group', 'aria-label': label }, items.map(([k, t]) => h('button', { type: 'button', 'aria-pressed': String(on(k)), text: t, onclick: () => pick(k) })));
  if (!laneHides('agent')) nodes.push(...aiAppsFilterNodes(b, f, hit, seg));
  const group = (title, rows, extra, always = false) => { const shown = rows.filter((r) => r && hit(r.label)); if (shown.length || always) nodes.push(sideHead(title, extra), ...shown.map((r) => r.el)); };
  const choice = (label, on, pick, lead, ...tail) => ({ label, el: h('button', { class: `side-row${on ? ' active' : ''}`, 'aria-pressed': String(on), onclick: pick }, lead, h('span', { class: 'grow ellipsis', text: label }), ...tail) });
  if (!laneHides('status')) group('状態', ['running', 'waiting', 'completed', 'aborted', 'idle'].filter((k) => b.statusCounts?.[k] || f.status === k).map((k) =>
    choice(STATUS_LABELS[k], f.status === k, () => setScope({ status: f.status === k ? '' : k }), h('span', { class: `sdot s-${k}` }), sideCountEl(b.statusCounts?.[k] || 0))));
  if (!laneHides('directory')) {
    const live = liveByDirectory(b);
    const dirs = state.sideQ.trim() ? allCategories(b) : categoryNavigation(allCategories(b), state.categoryPins, f.directory);
    group(T.category, dirs.map((d) => ({ label: d.name, el: h('div', { class: 'side-item side-dir', 'data-dir-id': d.id },
      h('button', { class: `side-row${f.directory === d.id ? ' active' : ''}`, 'aria-pressed': String(f.directory === d.id), title: 'クリックで絞り込み（もう一度で解除）。カードをここへドラッグすると所属を変えられます',
        onclick: () => setScope({ directory: f.directory === d.id ? '' : d.id }) },
        categoryIsPinned(d.id) ? h('span', { class: 'side-ic', title: '固定したカテゴリ', html: picon('pin', 15) }) : h('span', { class: 'dot', style: { background: d.color ? colorVar(d.color) : 'var(--header-btn-hover)' } }),
        h('span', { class: 'grow ellipsis', text: d.name }), ...liveBadges(live.get(d.id)), sideCountEl(d.count)),
      d.id === '__none' ? null : h('button', { class: 'icon-btn', 'aria-label': `${d.name} の設定`, text: '⋯', onclick: (e) => directoryMenu(e.currentTarget, d.id) })) })),
      state.layout === 'omni' || (state.layout === 'rail' && matchMedia('(min-width: 721px)').matches) ? null :
        h('button', { class: 'side-mini', title: `${T.category}を管理`, 'aria-label': `${T.category}を管理`, html: picon('gear', 14), onclick: () => workspace.toggle('directories') }), true);
    nodes.push(h('button', { type: 'button', class: 'side-row', 'data-all-categories': '', 'aria-label': 'すべてのカテゴリ…', 'aria-keyshortcuts': 'Alt+C', title: 'すべてのカテゴリ（Alt+C）', onclick: e => openCategoryPicker(e.currentTarget) },
      h('span', { class: 'side-ic', html: picon('search', 15) }), h('span', { class: 'grow', text: 'すべてのカテゴリ…' }), ...keycap('Alt+C')));
  }
  const topCross = (list, isSelected, makeItem) => {
    const shown = state.sideQ?.trim() ? list : list.filter((x, i) => i < SIDE_SOURCE_TOP || isSelected(x));
    return { shown: shown.map(makeItem), rest: list.length - shown.length };
  };
  if (!laneHides('repo') && ((b.repos || []).length || f.repo)) {
    const { shown, rest } = topCross(b.repos || [], r => f.repo === r.name, r =>
      choice(r.name, f.repo === r.name, () => setScope({ repo: f.repo === r.name ? '' : r.name }), h('span', { class: 'side-ic', html: picon('folder', 15) }), sideCountEl(r.count)));
    group('リポジトリ', [...shown, rest > 0 ? { label: '', el: h('button', { type: 'button', class: 'side-row side-more', title: 'すべてのリポジトリから選ぶ（p）', onclick: e => scopePicker(e.currentTarget) }, h('span', { class: 'grow', text: `ほか ${rest} 件…` })) } : null]);
  }
  if (!laneHides('worktree') && ((b.worktrees || []).length || f.worktree)) {
    const { shown, rest } = topCross(b.worktrees || [], w => f.worktree === w.key, w =>
      choice(w.name, f.worktree === w.key, () => setScope({ worktree: f.worktree === w.key ? '' : w.key }), null, sideCountEl(w.count)));
    group('ワークツリー', [
      choice('ワークツリーのみ（全件）', f.worktree === '__only', () => setScope({ worktree: f.worktree === '__only' ? '' : '__only' }), null),
      ...shown,
      rest > 0 ? { label: '', el: h('button', { type: 'button', class: 'side-row side-more', title: 'すべてのワークツリーから選ぶ（p）', onclick: e => scopePicker(e.currentTarget) }, h('span', { class: 'grow', text: `ほか ${rest} 件…` })) } : null,
    ]);
  }
  if (!laneHides('dirName') && ((b.dirNames || []).length > 1 || f.dirName)) {
    const { shown, rest } = topCross(b.dirNames || [], d => f.dirName === d.name, d =>
      choice(d.name, f.dirName === d.name, () => setScope({ dirName: f.dirName === d.name ? '' : d.name }), null, sideCountEl(d.count)));
    group('ディレクトリ名', [...shown, rest > 0 ? { label: '', el: h('button', { type: 'button', class: 'side-row side-more', title: 'すべてのディレクトリ名から選ぶ（p）', onclick: e => scopePicker(e.currentTarget) }, h('span', { class: 'grow', text: `ほか ${rest} 件…` })) } : null]);
  }
  nodes.push(sideHead('元アプリ', keycap('p')));
  // 元アプリ: each axis shows its busiest few and whatever is chosen; the rest stay one press away in the picker (p).
  for (const [axis, label] of Object.entries(SOURCE_AXES)) if (!laneHides(axis)) {
    const items = (axis === 'workingFolder'
      ? workingFolderFacets(b).map(x => ({ x, name: x.name, on: f.workingFolder === x.cwd, pick: () => setScope({ workingFolder: f.workingFolder === x.cwd ? '' : x.cwd }) }))
      : (b.sourceFacets || []).filter(x => sourceAxis(x.ref) === axis).map(x => ({ x, name: sourceFacetName(x, b.sourceFacets), on: sourceFilterSelected(x.ref), pick: () => toggleSourceFilter(x.ref) })))
      .sort((a, z) => z.x.count - a.x.count);
    const shown = state.sideQ.trim() ? items : items.filter((it, i) => i < SIDE_SOURCE_TOP || it.on), rest = items.length - shown.length;
    group(label, [...shown.map(it => choice(it.name, it.on, it.pick, null,
      (it.x.origins || []).includes('planned') ? h('span', { class: 'side-tag', title: '開始予定', text: '予定' }) : null, sideCountEl(it.x.count))),
      rest ? { label: '', el: h('button', { type: 'button', class: 'side-row side-more', title: 'すべての元アプリから選ぶ（p）', onclick: e => scopePicker(e.currentTarget) }, h('span', { class: 'grow', text: `ほか ${rest} 件…` })) } : null]);
  }
  const hosts = (b.hosts || []).filter((x) => (x.local || x.enabled) && !x.cloud);
  if (!laneHides('host') && (hosts.length > 1 || b.cloudCount > 0 || f.host)) {
    const envRows = [
      ...hosts.map((x) => {
        const id = x.local ? 'local' : x.id;
        return choice(x.local ? 'このマシン' : x.label, f.host === id, () => setScope({ host: f.host === id ? '' : id }), h('span', { class: 'side-ic', html: picon('server', 15) }), x.count ? sideCountEl(x.count) : null);
      }),
      ...(b.cloudCount > 0 || f.host === 'cloud' ? [choice('クラウド', f.host === 'cloud', () => setScope({ host: f.host === 'cloud' ? '' : 'cloud' }), h('span', { class: 'side-ic', html: picon('server', 15) }), sideCountEl(b.cloudCount || 0))] : []),
    ];
    group('環境（マシン）', envRows);
  }
  if (!laneHides('label') && b.labels.length) group('ラベル', [...b.labels.map((l) => ({ id: l.id, name: l.name, color: l.color })), { id: '__none', name: 'ラベルなし', color: null }].map((l) =>
    choice(l.name, f.label === l.id, () => setScope({ label: f.label === l.id ? '' : l.id }), h('span', { class: 'dot', style: { background: l.color ? colorVar(l.color) : 'var(--header-btn-hover)' } }))));
  const scope = (key, label) => h('label', { class: 'side-check' }, h('input', { type: 'checkbox', checked: !!f[key], onchange: (e) => setScope({ [key]: e.target.checked }) }), label);
  nodes.push(h('label', { class: 'side-check' }, h('input', { type: 'checkbox', checked: slackUi.visible, onchange: e => slackUi.toggle(e.target.checked) }), 'Slackタイムライン ', keycap('v')));
  nodes.push(sideHead('dotのセッション', keycap('Shift+V')), seg('dotのセッション', [['exclude', '除く'], ['all', '含める'], ['only', 'dotだけ']], k => f.dotScope === k, k => setScope({ dotScope: k })));
  nodes.push(sideHead('表示する対象'), scope('includeArchived', 'アーカイブ済みも表示'), scope('includeSubagents', 'サブエージェントも表示'), scope('pinnedOnly', 'Codex でピン留めしたものだけ'));
  return h('section', { class: 'side-sec-filters' }, nodes);
}
// The foot of the sidebar: the sheets, the management pages and the color theme.
function sideFoot(b) {
  if (state.layout === 'omni' || (state.layout === 'rail' && matchMedia('(min-width: 721px)').matches)) return h('div');
  return h('div', { class: 'side-foot' },
    h('div', { class: 'side-foot-look side-sec-look' }, (state.layout === 'hud' ? [] : SIDE_LOOK).map((x) => sideEntry(b, x))),
    h('div', { class: 'side-head side-sec-manage' }, h('span', { class: 'grow', text: '管理' })),
    h('div', { class: 'side-foot-grid side-sec-manage' }, SIDE_MANAGE.map((x) => sideEntry(b, x))),
    h('button', { class: 'side-row side-entry', type: 'button', 'data-look': '', title: 'レイアウトと色', onclick: (e) => themeMenu(e.currentTarget) },
      h('span', { class: 'side-ic', html: picon(THEME_CHOICES.find(([k]) => k === (state.themePref || 'system'))[1], 18) }), h('span', { class: 'grow ellipsis', text: 'レイアウトと色' }),
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
  el.replaceChildren(h('div', { class: 'side-scroll' }, ...(layoutParts.rail ? [layoutParts.rail] : []), ...secs), sideFoot(b));
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
  const bindings = (state.board.categoryBindings || []).filter(x => x.categoryId === d.id).map(({ ref, relation }) => ({ ref, ...(relation ? { relation } : {}) }));
  const knownSources = new Map([...(state.board.sourceFacets || []).filter(x => isPrimarySourceRef(x.ref)).map(x => [x.key, x]), ...bindings.map(x => [sourceRefKey(x.ref), { key: sourceRefKey(x.ref), ref: x.ref }])]);
  const bindingRows = [...knownSources.values()].map(facet => {
    const selected = bindings.some(x => sourceRefKey(x.ref) === facet.key);
    const input = h('input', { type: 'checkbox', checked: selected, onchange: () => {
      const next = bindings.filter(x => sourceRefKey(x.ref) !== facet.key);
      if (input.checked) next.push({ ref: facet.ref, relation: sourceCategoryRelation(facet.ref) });
      act('canban_update_directory', { directoryId: d.id, sourceBindings: next }, { okMsg: '元アプリとの対応を保存しました' }).then(again);
    } });
    return h('label', { class: 'side-check', title: sourceFacetTitle(facet) }, input, sourceFacetLabel(facet), facet.ref.provider === 'claude' && facet.ref.kind === 'environment' ? h('span', { class: 'muted', text: '開始実績の確認後に有効' }) : null);
  });
  popover(anchor, `${T.category}の設定`, h('div', {},
    name,
    h('div', { class: 'field-label', text: '色' }),
    h('div', { class: 'swatches' }, [null, ...COLORS].map((c) => h('button', { class: 'swatch', title: c ? COLOR_NAMES[c] : '色なし', 'aria-label': c ? COLOR_NAMES[c] : '色なし', 'aria-pressed': String((d.color || null) === c),
      style: { background: c ? colorVar(c) : 'var(--btn-subtle-hover)' }, text: c ? '' : '✕', onclick: () => act('canban_update_directory', { directoryId: d.id, color: c }).then(again) }))),
    h('div', { class: 'field-label' }, 'タスクの自動分類に使うフォルダ ', helpTip('フォルダのパス規則はタスクに適用します。セッションには元アプリの出典との明示的な対応を設定します。カードのカテゴリは個別に変更できます。')),
    ...d.paths.map((pth) => h('div', { class: 'rule-row' }, h('span', { class: 'ellipsis grow', title: pth, text: pth }),
      h('button', { class: 'icon-btn', 'aria-label': `${pth} を外す`, text: '✕', onclick: () => act('canban_update_directory', { directoryId: d.id, paths: d.paths.filter((x) => x !== pth) }).then(again) }))),
    path, folders,
    h('div', { class: 'field-label', text: '元アプリとの明示的な対応' }),
    h('p', { class: 'muted', text: '候補は現在の絞り込み後のボードで取得できた出典です。絞り込み中は候補が減ります。同名の出典へ自動で結合しません。表示外の既存の対応も保持します。' }),
    ...bindingRows,
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

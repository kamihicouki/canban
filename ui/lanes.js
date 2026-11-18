// Part of board.html: included into its script by server/ui.mjs and shares its scope.
// Swimlanes, snippets, saved views
const LANE_MODES = {
  '': 'なし',
  directory: `${T.category}`,
  repo: 'リポジトリ',
  host: '環境（マシン）',
  status: '状態',
  worktree: 'ワークツリー',
  dirName: 'ディレクトリ名',
  branch: 'ブランチ',
  workingFolder: '作業フォルダ',
  agent: 'AI Apps',
  label: 'ラベル',
  account: 'アカウント',
  project: '旧プロジェクト',
  section: '旧セクション',
};
const LANE_AGENT_LABELS = { codex: 'Codex', claude: 'Claude Code', gemini: 'Gemini CLI', antigravity: 'Antigravity', cursor: 'Cursor', chatgpt: 'ChatGPT', grok: 'Grok' };
const NO_DIR = 'カテゴリ無し';
const STATUS_LANE_ORDER = { running: 0, waiting: 1, aborted: 2, completed: 3, idle: 4, unknown: 5 };
const STATUS_LANE_LABELS = { running: '実行中', waiting: '入力待ち', aborted: '中断', completed: '応答済み', idle: '待機中', unknown: '状態未取得' };
// 明示した repo: null / dirName: null を旧 project / cwd で補完しないための3値解決。
function cardEffectiveRepo(card) {
  const ctx = card?.context;
  if (ctx && Object.hasOwn(ctx, 'repo')) {
    const trimmed = String(ctx.repo || '').trim();
    return trimmed && trimmed !== 'outside-of-project' ? trimmed : '';
  }
  if (card && Object.hasOwn(card, 'repoName') && card.kind === 'task') {
    const trimmed = String(card.repoName || '').trim();
    return trimmed && trimmed !== 'outside-of-project' ? trimmed : '';
  }
  const raw = String(card?.repoName || card?.project || '').trim();
  return raw && raw !== 'outside-of-project' ? raw : '';
}
function cardEffectiveDirName(card) {
  const ctx = card?.context;
  if (ctx && Object.hasOwn(ctx, 'dirName')) {
    return String(ctx.dirName || '').trim();
  }
  if (card && Object.hasOwn(card, 'dirName') && card.kind === 'task') {
    return String(card.dirName || '').trim();
  }
  return String(card?.dirName || (card?.cwd ? card.cwd.replace(/\/+$/, '').split('/').pop() : '') || '').trim();
}
// 手動指定と「カテゴリ無し」を優先し、未設定だけを元リポジトリでまとめる。
function resolveDirectoryLane(card, directories = []) {
  if (card.directory) return { id: card.directory.id, name: card.directory.name, creation: { directory: card.directory.id } };
  if (card.directoryId !== '__none') {
    const repo = cardEffectiveRepo(card);
    if (repo) {
      const matched = (directories || []).find(d => d.name.trim().toLowerCase() === repo.trim().toLowerCase());
      if (matched) return { id: matched.id, name: matched.name, creation: { directory: matched.id } };
      return { id: `auto:${repo}`, name: `未分類（${repo}）`, creation: { directory: null, context: { repo } } };
    }
  }
  return { id: '__none', name: NO_DIR, creation: { directory: '__none' } };
}
function resolveRepoLane(card) {
  const repo = cardEffectiveRepo(card);
  return repo
    ? { id: repo, name: repo, creation: { context: { repo } } }
    : { id: '__none', name: '（リポジトリ不明）', creation: { context: { repo: null } } };
}
function resolveWorktreeLane(card) {
  const cleanRepo = cardEffectiveRepo(card);
  if (card.worktreeName) {
    return {
      id: `${cleanRepo || '-'}/${card.worktreeName}`,
      name: cleanRepo ? `${cleanRepo} / ${card.worktreeName}` : card.worktreeName,
      creation: cleanRepo ? { context: { repo: cleanRepo } } : {},
      orderGroup: 0,
    };
  }
  const dn = cardEffectiveDirName(card);
  const base = cleanRepo || dn;
  if (base) {
    return {
      id: `main:${base}`,
      name: `${base}（メイン）`,
      creation: cleanRepo ? { context: { repo: cleanRepo } } : dn ? { context: { dirName: dn } } : {},
      orderGroup: 1,
    };
  }
  return { id: '__none', name: '（ワークツリーなし）', creation: {}, orderGroup: 2 };
}
function resolveDirNameLane(card) {
  const dn = cardEffectiveDirName(card);
  return dn
    ? { id: dn, name: dn, creation: { context: { dirName: dn } } }
    : { id: '__none', name: '（ディレクトリなし）', creation: { context: { dirName: null } } };
}
function resolveEnvironmentLane(card) {
  const isCloud = card.environmentKey === 'cloud' || card.surface === 'cloud' || card.sourceKind === 'codex-cloud' || !!card.cloud || !!card.host?.cloud;
  if (isCloud) return { id: 'cloud', nativeId: 'cloud', name: 'クラウド', creation: {} };
  const hostId = card.host?.id || 'local';
  const name = card.host?.label || (hostId === 'local' ? 'このマシン' : hostId);
  return { id: hostId, nativeId: null, name, creation: { context: { host: hostId } } };
}
function resolveStatusLane(card) {
  const st = card.statusKnown === false ? 'unknown' : (card.status || 'idle');
  const labels = typeof STATUS_LABELS !== 'undefined' ? STATUS_LABELS : STATUS_LANE_LABELS;
  return { id: st, name: labels[st] || STATUS_LANE_LABELS[st] || st, orderRank: STATUS_LANE_ORDER[st] ?? 9 };
}
function laneKey(card, mode, board = state.board) {
  if (mode === 'repo') return resolveRepoLane(card).name;
  if (mode === 'worktree') return resolveWorktreeLane(card).name;
  if (mode === 'dirName') return resolveDirNameLane(card).name;
  if (mode === 'status') return resolveStatusLane(card).name;
  if (mode === 'branch') {
    const b = card.branch || card.worktreeName;
    return b ? b : '（ブランチなし）';
  }
  if (mode === 'directory') {
    return resolveDirectoryLane(card, board?.directories).name;
  }
  if (isSourceAxis(mode)) return sourceLane(card, mode).name;
  if (mode === 'section') {
    const sec = card.codexSection;
    return sec ? `§ ${sec.name}` : '（セクションなし）';
  }
  if (mode === 'agent') return card.agent ? (LANE_AGENT_LABELS[card.agent] || card.agent) : `${T.taskCard}`;
  if (mode === 'host') return resolveEnvironmentLane(card).name;
  if (mode === 'account') return accountLaneKey(card);
  if (mode === 'label') {
    const l = (board?.labels || state.board.labels).find((x) => card.labels.includes(x.id));
    return l ? l.name : 'ラベルなし';
  }
  return card.project || '（プロジェクトなし）';
}
function laneIdForCard(card, mode, board = state.board) {
  if (mode === 'repo') return JSON.stringify([mode, resolveRepoLane(card).id]);
  if (mode === 'worktree') return JSON.stringify([mode, resolveWorktreeLane(card).id]);
  if (mode === 'dirName') return JSON.stringify([mode, resolveDirNameLane(card).id]);
  if (mode === 'status') return JSON.stringify([mode, resolveStatusLane(card).id]);
  if (mode === 'branch') return JSON.stringify([mode, card.branch || card.worktreeName || '__none']);
  if (mode === 'directory') {
    return JSON.stringify([mode, resolveDirectoryLane(card, board?.directories).id]);
  }
  if (mode === 'host') {
    const env = resolveEnvironmentLane(card);
    return JSON.stringify([mode, env.nativeId != null ? env.nativeId : env.creation]);
  }
  if (isSourceAxis(mode)) return JSON.stringify([mode, sourceLane(card, mode, board.sourceFacets).id]);
  const labelId = board.labels.find(label => card.labels.includes(label.id))?.id;
  return JSON.stringify([mode, taskLaneCreation(card, mode, labelId)]);
}
function buildLanes(b, mode) {
  const lanes = new Map();
  const lane = (creation, name, nativeId = null) => {
    const key = nativeId == null ? JSON.stringify([mode, creation]) : JSON.stringify([mode, nativeId]);
    if (!lanes.has(key)) lanes.set(key, { key, creation, name, count: 0, unread: 0, running: 0, waiting: 0, color: null, dirId: null });
    return lanes.get(key);
  };
  for (const list of b.lists) for (const card of list.cards) {
    const labelId = b.labels.find(label => card.labels.includes(label.id))?.id;
    let ln;
    if (mode === 'repo') {
      const r = resolveRepoLane(card);
      ln = lane(r.creation, r.name, r.id);
    } else if (mode === 'worktree') {
      const wt = resolveWorktreeLane(card);
      ln = lane(wt.creation, wt.name, wt.id);
      ln.orderGroup = wt.orderGroup;
    } else if (mode === 'dirName') {
      const dn = resolveDirNameLane(card);
      ln = lane(dn.creation, dn.name, dn.id);
    } else if (mode === 'status') {
      const st = resolveStatusLane(card);
      ln = lane({}, st.name, st.id);
      ln.orderRank = st.orderRank;
    } else if (mode === 'branch') {
      const bKey = card.branch || card.worktreeName || '__none';
      ln = lane({}, laneKey(card, mode, b), bKey);
    } else if (mode === 'directory') {
      const d = resolveDirectoryLane(card, b.directories);
      ln = lane(d.creation, d.name, d.id);
    } else if (mode === 'host') {
      const env = resolveEnvironmentLane(card);
      ln = lane(env.creation, env.name, env.nativeId);
    } else {
      const native = isSourceAxis(mode) ? sourceLane(card, mode, b.sourceFacets) : null;
      ln = native ? lane(native.creation, native.name, native.id) : lane(taskLaneCreation(card, mode, labelId), laneKey(card, mode, b));
    }
    ln.count++;
    if (card.unread) ln.unread++;
    if (card.status === 'running') ln.running++;
    if (card.status === 'waiting') ln.waiting++;
  }
  if (mode === 'repo') {
    lane({ context: { repo: null } }, '（リポジトリ不明）', '__none');
  }
  if (mode === 'worktree') {
    lane({}, '（ワークツリーなし）', '__none').orderGroup = 2;
  }
  if (mode === 'dirName') {
    lane({ context: { dirName: null } }, '（ディレクトリなし）', '__none');
  }
  if (mode === 'status') {
    for (const st of ['running', 'waiting', 'aborted', 'completed', 'idle']) {
      const s = resolveStatusLane({ status: st, statusKnown: true });
      lane({}, s.name, s.id).orderRank = s.orderRank;
    }
  }
  if (mode === 'branch') {
    lane({}, '（ブランチなし）', '__none');
  }
  if (mode === 'directory') {
    for (const d of b.directories) Object.assign(lane({ directory: d.id }, d.name, d.id), { color: d.color, dirId: d.id });
    lane({ directory: '__none' }, NO_DIR, '__none').dirId = '__none';
  }
  if (mode === 'label') {
    for (const label of b.labels) lane({ labels: [label.id] }, label.name).color = label.color;
    lane({ labels: [] }, 'ラベルなし');
  }
  if (mode === 'project') {
    for (const project of b.projects) lane({ context: { project: project.name } }, project.name);
    lane({ context: { project: null } }, '（プロジェクトなし）');
  }
  if (mode === 'section') {
    for (const section of b.codexSections || []) lane({ context: { section: section.id } }, `§ ${section.name}`);
    lane({ context: { section: null } }, '（セクションなし）');
  }
  if (mode === 'agent') {
    lane({ context: { agent: 'codex' } }, 'Codex');
    lane({ context: { agent: 'claude' } }, 'Claude Code');
    for (const [ag, name] of Object.entries(LANE_AGENT_LABELS)) {
      if (ag !== 'codex' && ag !== 'claude' && b.totals?.byAgent?.[ag]?.total > 0) {
        lane({ context: { agent: ag } }, name);
      }
    }
    lane({ context: { agent: null } }, T.taskCard);
  }
  if (mode === 'host') {
    lane({ context: { host: 'local' } }, 'このマシン');
    for (const host of b.hosts || []) if (!host.cloud) lane({ context: { host: host.local ? 'local' : host.id } }, host.local ? 'このマシン' : host.label);
    if (b.cloudCount > 0) lane({}, 'クラウド', 'cloud');
  }
  if (mode === 'account') {
    for (const account of b.accounts?.accounts || []) lane({ context: { account: account.key } }, accountName(account.key));
    lane({ context: { account: null } }, 'アカウント不明');
    for (const host of b.hosts || []) if (!host.local && !host.cloud) lane({ context: { account: null, host: host.id } }, `⌂ ${host.label}`);
  }
  const last = name => /^（.*なし）$|^（.*不明）$/.test(name);
  return [...lanes.values()].sort((a, c) =>
    mode === 'status'
      ? (a.orderRank ?? 99) - (c.orderRank ?? 99)
      : mode === 'worktree'
        ? (a.orderGroup ?? 99) - (c.orderGroup ?? 99) || last(a.name) - last(c.name) || c.count - a.count
        : last(a.name) - last(c.name) || c.count - a.count
  ).map(ln => ({
    ...ln, lists: b.lists.map(list => {
      const cards = list.cards.filter(card => laneIdForCard(card, mode, b) === ln.key);
      return { ...list, cards, count: cards.length };
    }),
  }));
}
const collapsedLanes = new Set(store.get('collapsedLanes', []));
function renderLane(lane) {
  const collapsed = collapsedLanes.has(lane.key) || collapsedLanes.has(lane.name);
  const toggle = () => {
    collapsedLanes.delete(lane.name);
    collapsed ? collapsedLanes.delete(lane.key) : collapsedLanes.add(lane.key);
    store.set('collapsedLanes', [...collapsedLanes]);
    render();
  };
  const live = lane.running ? 'running' : lane.waiting ? 'waiting' : null;
  // collapsed lanes still show what is inside: cards per list
  const chips = collapsed ? lane.lists.filter((l) => l.count).map((l) =>
    h('span', { class: 'lane-chip' }, h('span', { class: 'stripe', style: { background: colorVar(l.color) } }), `${l.title} ${l.count}`)) : [];
  return h('section', { class: `lane${collapsed ? ' collapsed' : ''}`, 'aria-label': lane.name, 'data-lane': lane.key, 'data-dir-id': lane.dirId || null },
    h('div', { class: 'lane-head' },
      h('button', { class: 'lane-toggle', 'aria-expanded': String(!collapsed), title: '開く／たたむ（[ ] で前後のレーンへ）', onclick: toggle },
        h('span', { text: collapsed ? '▸' : '▾' }),
        lane.color ? h('span', { class: 'sdot', style: { background: colorVar(lane.color) } }) : null,
        h('span', { class: 'lane-name', text: lane.name }), h('span', { class: 'count', text: `${lane.count}` }),
        live ? h('span', { class: `sdot s-${live}`, title: STATUS_LABELS[live] }) : null,
        lane.unread ? h('span', { class: 'side-new', text: `新着 ${lane.unread}` }) : null),
      ...chips,
      h('button', { class: 'quick-task-trigger', type: 'button', text: '＋ タスク', 'aria-label': `${lane.name}にタスクを追加`, onclick: () => taskQuickAdd.open({ lane }) }),
      h('button', { class: 'lane-solo', title: 'このレーンだけを表示', text: state.soloLane === lane.key ? '◀ 全レーン' : '◎ これだけ', onclick: () => setSolo(state.soloLane === lane.key ? null : lane.key) })),
    collapsed ? null : h('div', { class: 'lane-lists' }, lane.lists.map((l) => renderList(l, { inLane: true, lane }))));
}
function setSolo(name) {
  state.soloLane = name;
  if (name) { collapsedLanes.delete(name); collapsedLanes.delete(state.lanes.find(l => l.key === name)?.name); }
  render();
  $('#board').scrollTop = 0;
}
function jumpToLane(name) {
  if (state.soloLane && state.soloLane !== name) state.soloLane = null;
  if (collapsedLanes.has(name)) { collapsedLanes.delete(name); store.set('collapsedLanes', [...collapsedLanes]); }
  render();
  const el = $(`.lane[data-lane="${CSS.escape(name)}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'start' });
  (el.querySelector('.card') || el.querySelector('.lane-toggle'))?.focus({ preventScroll: true });
}
// The lane at the top of the viewport, then step to the previous / next one.
function stepLane(dir) {
  const names = state.lanes.map((l) => l.key);
  if (!names.length) return toast('レーンが有効ではありません（サイドバーの「レーン」で選べます）');
  const top = $('#board').getBoundingClientRect().top;
  const els = [...document.querySelectorAll('#board .lane')];
  let cur = els.findIndex((el) => el.getBoundingClientRect().bottom > top + 48);
  const focusLane = document.activeElement?.closest?.('.lane');
  if (focusLane) cur = els.indexOf(focusLane);
  const curName = els[Math.max(0, cur)]?.dataset.lane;
  const i = Math.max(0, names.indexOf(curName));
  const next = names[Math.min(names.length - 1, Math.max(0, i + dir))];
  if (state.soloLane) setSolo(next);
  else jumpToLane(next);
}
function setAllLanes(collapse) {
  collapsedLanes.clear();
  if (collapse) state.lanes.forEach((l) => collapsedLanes.add(l.key));
  store.set('collapsedLanes', [...collapsedLanes]);
  render();
}

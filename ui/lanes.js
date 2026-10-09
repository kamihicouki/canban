// Part of board.html: included into its script by server/ui.mjs and shares its scope.
// Swimlanes, snippets, saved views
const LANE_MODES = { '': 'なし', directory: `${T.category}`, project: 'プロジェクト', section: 'Codex セクション', host: 'マシン', account: 'アカウント', agent: 'AI Apps', label: 'ラベル' };
const NO_DIR = 'カテゴリ無し';
function laneKey(card, mode) {
  if (mode === 'directory') return card.directory ? card.directory.name : NO_DIR;
  if (mode === 'section') {
    const sec = card.codexSection;
    return sec ? `§ ${sec.name}` : '（セクションなし）';
  }
  if (mode === 'agent') return card.agent ? card.agent === 'codex' ? 'Codex' : 'Claude Code' : `${T.taskCard}`;
  if (mode === 'host') return card.host?.label || 'このマシン';
  if (mode === 'account') return accountLaneKey(card);
  if (mode === 'label') {
    const l = state.board.labels.find((x) => card.labels.includes(x.id));
    return l ? l.name : 'ラベルなし';
  }
  return card.project || '（プロジェクトなし）';
}
function laneIdForCard(card, mode, board = state.board) {
  const labelId = board.labels.find(label => card.labels.includes(label.id))?.id;
  return JSON.stringify([mode, taskLaneCreation(card, mode, labelId)]);
}
function buildLanes(b, mode) {
  const lanes = new Map();
  const lane = (creation, name) => {
    const key = JSON.stringify([mode, creation]);
    if (!lanes.has(key)) lanes.set(key, { key, creation, name, count: 0, unread: 0, running: 0, waiting: 0, color: null, dirId: null });
    return lanes.get(key);
  };
  for (const list of b.lists) for (const card of list.cards) {
    const labelId = b.labels.find(label => card.labels.includes(label.id))?.id;
    const ln = lane(taskLaneCreation(card, mode, labelId), laneKey(card, mode));
    ln.count++;
    if (card.unread) ln.unread++;
    if (card.status === 'running') ln.running++;
    if (card.status === 'waiting') ln.waiting++;
  }
  if (mode === 'directory') {
    for (const d of b.directories) Object.assign(lane({ directory: d.id }, d.name), { color: d.color, dirId: d.id });
    lane({ directory: '__none' }, NO_DIR).dirId = '__none';
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
    lane({ context: { agent: null } }, T.taskCard);
  }
  if (mode === 'host') {
    lane({ context: { host: 'local' } }, 'このマシン');
    for (const host of b.hosts || []) lane({ context: { host: host.local ? 'local' : host.id } }, host.local ? 'このマシン' : host.label);
  }
  if (mode === 'account') {
    for (const account of b.accounts?.accounts || []) lane({ context: { account: account.key } }, `${account.key.startsWith('codex:') ? 'Codex' : 'Claude'} · ${account.label}`);
    lane({ context: { account: null } }, 'アカウント不明');
    for (const host of b.hosts || []) if (!host.local) lane({ context: { account: null, host: host.id } }, `⌂ ${host.label}`);
  }
  const last = name => /^（.*なし）$/.test(name);
  return [...lanes.values()].sort((a, c) => last(a.name) - last(c.name) || c.count - a.count).map(ln => ({
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

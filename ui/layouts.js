// Layout themes (included into board.html's script by server/ui.mjs; shares its scope).
// The same parts — app bar, navigation, board, management panel, overlay — are arranged five ways
// (docs/ui-components.md). body[data-layout] drives the arrangement in layouts.css; this file adds the
// few parts a layout has of its own (rail, dock, live HUD, tabs, category strip) and the picker.
// Each place has exactly one entry per layout: the navigation that a layout shows is its only index.
const LAYOUTS = [
  ['trello', 'Trello', 'グラデーションの背景に、半透明のアプリバーとサイドバー。管理はサイドバーの隣に開く'],
  ['classic', '定番', 'サイドバーが上まで通る、落ち着いた配色（Linear・Notion 型）'],
  ['rail', 'レール', '左のレールで場所を選び、隣のパネルで中身を選ぶ（VS Code・Slack 型）'],
  ['omni', 'オムニバー', 'サイドバーなし。絞り込みは検索欄とカテゴリの帯、移動は下のドック'],
  ['hud', 'ライブ HUD', '動いているセッションを、いつも最上段にタイルで表示'],
];
const layoutOf = (v) => (LAYOUTS.some(([id]) => id === v) ? v : 'trello');
// Places a layout can jump to: [icon, label]. analytics / usage / orbit open a sheet on the overlay; the rest open the management panel.
const PLACES = {
  home: ['board', 'ボード'], analytics: ['chart', '分析'], usage: ['gauge', 'Agent Usage'], orbit: ['refresh', '軌道'], rules: ['zap', T.automation],
  labels: ['tag', 'ラベル'], directories: ['folder', T.category], views: ['bookmark', '保存ビュー'], hosts: ['server', 'マシン'], settings: ['gear', '設定'],
  look: ['layout', 'レイアウトと色'],
  slack: ['message', 'Slack接続'], slackTimeline: ['message', 'Slack'],
};
const MANAGE_PLACES = ['rules', 'labels', 'directories', 'views', 'hosts', 'slack', 'settings'];
const layoutParts = {};
state.layoutSaved = store.get('layout', 'trello');
state.layout = layoutOf(state.layoutSaved);

function currentPlace() { return workspace.current(); }
function goPlace(page, anchor) {
  if (page === 'look') return themeMenu(anchor);
  if (page === 'slackTimeline') return slackUi.toggle();
  if (VIEW_SHEETS[page]) return toggleView(page);
  if (page === 'home') { closeCards(); return workspace.navigate('home'); }
  workspace.toggle(page);
}
const placeBtn = (page, cls, { label = PLACES[page][1], size = 20 } = {}) =>
  h('button', { class: cls, type: 'button', 'data-place': page, title: label, 'aria-label': label, onclick: (e) => goPlace(page, e.currentTarget) },
    h('span', { class: 'place-ic', html: picon(PLACES[page][0], size) }), h('span', { class: 'place-lbl', text: label }));

function buildLayouts() { applyLayout(); }
function applyLayout() {
  document.body.dataset.layout = layoutOf(state.layout);
  for (const part of Object.values(layoutParts)) part.remove();
  for (const key of Object.keys(layoutParts)) delete layoutParts[key];
  const content = $('.app-content');
  if (!content) return;
  if (state.layout === 'rail' && matchMedia('(min-width: 721px)').matches) {
    layoutParts.rail = h('nav', { class: 'layout-rail', 'aria-label': '場所' },
      h('span', { class: 'rail-logo', html: LOGO_SVG }),
      ...['home', 'analytics', 'usage', 'orbit', 'slackTimeline'].map(p => placeBtn(p, 'rail-item', { size: 21 })), h('span', { class: 'rail-sep' }),
      ...MANAGE_PLACES.map(p => placeBtn(p, 'rail-item', { size: 21 })), placeBtn('look', 'rail-item', { size: 21 }));
    content.prepend(layoutParts.rail);
  }
  if (state.layout === 'omni') {
    layoutParts.dock = h('nav', { class: 'layout-dock', 'aria-label': '場所' },
      ...['home', 'analytics', 'usage', 'orbit', 'slackTimeline', ...MANAGE_PLACES, 'look'].map(p => placeBtn(p, 'dock-item', { size: 22 })));
    layoutParts.filterBtn = h('button', { class: 'hbtn omni-filter', type: 'button', 'aria-haspopup': 'dialog', onclick: e => {
      const b = state.board; if (!b) return;
      popover(e.currentTarget, 'レーンと絞り込み', h('div', { class: 'sidebar omni-pop' }, laneSection(b, () => true), filterSection(b)), { width: 320 });
    } }, h('span', { html: picon('sliders', 16) }), h('span', { class: 'lbl', text: '絞り込み' }));
    layoutParts.strip = h('div', { class: 'cat-strip', role: 'group', 'aria-label': T.category, 'data-pri': '1' });
    content.append(layoutParts.dock);
    $('#quickTaskBtn').after(layoutParts.strip, layoutParts.filterBtn);
  }
  if (state.layout === 'hud') {
    layoutParts.tabs = h('nav', { class: 'layout-tabs', 'aria-label': '場所', 'data-pri': '9' },
      ...['home', 'analytics', 'usage', 'orbit'].map(p => placeBtn(p, 'layout-tab', { size: 17 })));
    layoutParts.hud = h('section', { class: 'live-hud', 'aria-label': '動いているセッション' });
    $('.topbar').after(layoutParts.hud);
    $('#brand').after(layoutParts.tabs);
  }
  if (state.board) renderSidebar(state.board);
  paintLayoutChrome();
  fitHeader();
}
matchMedia('(min-width: 721px)').addEventListener('change', () => applyLayout());

function setLayout(id) {
  if (!LAYOUTS.some(([key]) => key === id)) return;
  state.layout = layoutOf(id);
  state.layoutSaved = state.layout;
  store.set('layout', state.layout);
  applyLayout();
  if (state.board) render();
}

// Called after every board render and page change.
function paintLayoutChrome() {
  for (const key of ['rail', 'dock', 'tabs', 'hud']) if (layoutParts[key]) layoutParts[key].inert = !paneLayer.hidden;
  for (const button of $$('[data-place=slackTimeline]')) button.setAttribute('aria-pressed', String(slackUi.visible));
  const here = currentPlace();
  for (const b of $$('[data-place]')) b.setAttribute('aria-current', String(b.dataset.place === here));
  const b = state.board;
  if (!b) return;
  if (state.layout === 'omni') paintStrip(b);
  if (state.layout === 'hud') paintHud(b);
}

// C: the strip lists the lanes (a press jumps to one) or, without lanes, the categories (a press filters).
function paintStrip(b) {
  const f = state.filters;
  const n = filterChips(b).length;
  layoutParts.filterBtn.querySelector('.lbl').textContent = n ? `絞り込み ${n}` : '絞り込み';
  if (f.swimlane) {
    layoutParts.strip.replaceChildren(...state.lanes.map((lane) => h('button', { class: 'cat-pill', type: 'button', title: 'そのレーンへ移動', onclick: () => jumpToLane(lane.key) },
      lane.color ? h('i', { style: { background: colorVar(lane.color) } }) : null, lane.name, h('span', { class: 'n', text: String(lane.count) }))));
    return;
  }
  const pill = (id, name, color, count) => h('button', { class: 'cat-pill', type: 'button', 'aria-pressed': String((f.directory || '') === id),
    onclick: () => setScope({ directory: (f.directory || '') === id && id ? '' : id }) },
    color ? h('i', { style: { background: colorVar(color) } }) : null, name, h('span', { class: 'n', text: String(count ?? '') }));
  layoutParts.strip.replaceChildren(pill('', 'すべて', null, b.totals?.shown),
    ...[...b.directories].sort((x, y) => (y.count || 0) - (x.count || 0)).map((d) => pill(d.id, d.name, d.color, d.count)));
}

function paintHud(b) {
  const live = b.lists.flatMap((l) => l.cards).filter((c) => c.status === 'running' || c.status === 'waiting')
    .sort((x, y) => (x.status === 'waiting' ? 0 : 1) - (y.status === 'waiting' ? 0 : 1) || (y.updatedAt || 0) - (x.updatedAt || 0));
  const waiting = live.filter((c) => c.status === 'waiting').length;
  const head = h('div', { class: 'hud-head' }, h('b', { text: String(live.length) }), h('span', { text: '動いている' }),
    waiting ? h('span', { class: 'hud-wait', text: `${waiting} 件 入力待ち` }) : null);
  if (!live.length) { layoutParts.hud.replaceChildren(head, h('span', { class: 'hud-empty', text: '実行中・入力待ちのセッションはありません' })); return; }
  layoutParts.hud.replaceChildren(head, ...live.slice(0, 12).map((c) => {
    const doing = activityText(c.activity, c.status, c.signals);
    return h('button', { class: `hud-tile${c.status === 'waiting' ? ' is-waiting' : ''}`, type: 'button', title: c.title, onclick: () => openCard(c.id) },
      h('span', { class: 'hud-r1' }, faceGlyph(c.status), h('span', { text: STATUS_LABELS[c.status] || STATUS_LABELS.idle }), faceWho(c.agent)),
      h('span', { class: 'hud-t', text: c.title }),
      h('span', { class: 'hud-act', text: doing || relTime(c.updatedAt) }));
  }));
}

// The picker changes only the shared screen preference. It never fetches/moves/marks cards.
function layoutChooser() {
  return h('div', { class: 'layout-chooser', role: 'group', 'aria-label': 'レイアウト' },
    LAYOUTS.map(([id, name, desc]) => h('button', { class: 'lc-card', type: 'button', 'data-layout-choice': id,
      'aria-pressed': String(state.layout === id), onclick: () => {
        closePopover(); setLayout(id);
        const trigger = layoutParts.rail?.querySelector('[data-place="look"]') || layoutParts.dock?.querySelector('[data-place="look"]') || $('#sidebar [data-look]');
        trigger?.focus({ preventScroll: true });
      } },
      h('b', { text: name }), h('span', { class: 'lc-desc', text: desc }))));
}

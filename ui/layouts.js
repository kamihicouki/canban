// Layout themes (included into board.html's script by server/ui.mjs; shares its scope).
// The same parts — header, board bar, sidebar, board, menu drawer — are arranged five ways.
// body[data-layout] drives the arrangement in layouts.css; this file adds the few parts a
// layout has of its own (rail, dock, live HUD, tabs, category strip) and the picker.
const LAYOUTS = [
  ['trello', 'Trello', 'グラデーションの背景に、半透明のヘッダーとサイドバー'],
  ['classic', '定番', 'サイドバーが上まで通る、落ち着いた配色（Linear・Notion 型）'],
  ['rail', 'レール', '左のレールで場所を選び、隣のパネルで中身を選ぶ（VS Code・Slack 型）'],
  ['omni', 'オムニバー', 'サイドバーなし。絞り込みは検索欄とカテゴリの帯、移動は下のドック'],
  ['hud', 'ライブ HUD', '動いているセッションを、いつも最上段にタイルで表示'],
];
const layoutOf = (v) => (LAYOUTS.some(([id]) => id === v) ? v : 'trello');
// Places a layout can jump to: [page, icon, label]. Pages other than home/analytics open the menu drawer.
const PLACES = {
  home: ['board', 'ボード'], analytics: ['chart', '分析'], usage: ['gauge', '使用量'], rules: ['zap', T.automation],
  labels: ['tag', 'ラベル'], directories: ['folder', T.category], views: ['bookmark', 'ビュー'], hosts: ['server', 'マシン'], settings: ['gear', '設定'],
};
const layoutParts = {};

function currentPlace() {
  if (state.view === 'analytics') return 'analytics';
  return workspace.utilityPage() ? workspace.page : 'home';
}
function goPlace(page) {
  workspace.navigate(page);
  syncViewButton();
}
const placeBtn = (page, cls, { label = PLACES[page][1], size = 20 } = {}) =>
  h('button', { class: cls, type: 'button', 'data-place': page, title: label, 'aria-label': label, onclick: () => goPlace(page) },
    h('span', { class: 'place-ic', html: picon(PLACES[page][0], size) }), h('span', { class: 'place-lbl', text: label }));

function buildLayouts() {
  const nextTheme = () => ({ light: 'dark', dark: 'system', system: 'light' }[state.themePref] || 'light');
  const themeCycle = h('button', { class: 'rail-theme', type: 'button', onclick: () => { setThemePref(nextTheme()); paintLayoutChrome(); } });
  layoutParts.themeCycle = themeCycle;
  // B: the rail. Places with labels under the icons, theme and layout at the bottom.
  layoutParts.rail = h('nav', { class: 'layout-rail', 'aria-label': '場所' },
    h('span', { class: 'rail-logo', html: LOGO_SVG }),
    ...['home', 'analytics', 'usage', 'rules', 'hosts'].map((p) => placeBtn(p, 'rail-item', { size: 21 })),
    h('span', { class: 'grow' }), themeCycle,
    h('button', { class: 'rail-item', type: 'button', title: 'レイアウト', 'aria-label': 'レイアウト', onclick: (e) => layoutPicker(e.currentTarget) },
      h('span', { class: 'place-ic', html: picon('layout', 21) }), h('span', { class: 'place-lbl', text: 'レイアウト' })),
    placeBtn('settings', 'rail-item', { size: 21 }));
  // C: the dock, floating over the bottom of the board.
  layoutParts.dock = h('nav', { class: 'layout-dock', 'aria-label': '場所' },
    ...['home', 'analytics', 'usage'].map((p) => placeBtn(p, 'dock-item', { size: 22 })), h('span', { class: 'dock-sep' }),
    ...['rules', 'labels', 'directories', 'hosts', 'settings'].map((p) => placeBtn(p, 'dock-item', { size: 22 })), h('span', { class: 'dock-sep' }),
    h('button', { class: 'dock-item dock-add', type: 'button', title: 'タスクを作成（c）', onclick: () => taskQuickAdd.open() },
      h('span', { class: 'place-ic', html: picon('plus', 22) }), h('span', { class: 'place-lbl', text: 'タスク' })));
  // D: tabs in the header and the live HUD under the board bar.
  layoutParts.tabs = h('nav', { class: 'layout-tabs', 'aria-label': '場所' },
    ...['home', 'analytics', 'usage'].map((p) => placeBtn(p, 'layout-tab', { size: 17 })),
    placeBtn('rules', 'layout-tab', { label: '管理', size: 17 }));
  layoutParts.hud = h('section', { class: 'live-hud', 'aria-label': '動いているセッション' });
  // C: categories as a strip of pills in the board bar.
  layoutParts.strip = h('div', { class: 'cat-strip', role: 'group', 'aria-label': T.category });
  const content = $('.app-content');
  content.prepend(layoutParts.rail);
  content.append(layoutParts.dock);
  $('.boardbar').after(layoutParts.hud);
  $('#brand').after(layoutParts.tabs);
  $('#logo').after(layoutParts.strip);
  $('#layoutBtn').addEventListener('click', (e) => layoutPicker(e.currentTarget));
  applyLayout();
}

function applyLayout() {
  document.body.dataset.layout = layoutOf(state.layout);
  paintLayoutChrome();
  if (typeof fitHeader === 'function') fitHeader();
}
function setLayout(id) {
  state.layout = layoutOf(id);
  store.set('layout', state.layout);
  applyLayout();
  layoutPanes();
  if (state.board && state.view !== 'analytics') render();
}

// Called after every board render and page change.
function paintLayoutChrome() {
  if (!layoutParts.rail) return;
  const here = currentPlace();
  // The HUD's 管理 tab stands for every management page except Agent Usage (which has its own tab).
  const managing = DRAWER_PAGES.includes(here) && here !== 'usage';
  for (const b of $$('[data-place]')) {
    const on = b.dataset.place === here || (managing && b.dataset.place === 'rules' && !!b.closest('.layout-tabs'));
    b.setAttribute('aria-current', String(on));
  }
  // (THEME_PREFS is defined later in board.html; this runs during start-up.)
  const pref = ['light', 'dark'].includes(state.themePref) ? state.themePref : 'system';
  const name = { light: 'ライト', dark: 'ダーク', system: 'システム' }[pref];
  layoutParts.themeCycle.replaceChildren(h('span', { class: 'place-ic', html: picon(pref === 'system' ? 'system' : pref === 'dark' ? 'moon' : 'sun', 21) }), h('span', { class: 'place-lbl', text: name }));
  layoutParts.themeCycle.title = `テーマ: ${name}（押すと次へ）`;
  const b = state.board;
  if (!b) return;
  if (state.layout === 'omni') paintStrip(b);
  if (state.layout === 'hud') paintHud(b);
}

function paintStrip(b) {
  const f = state.filters;
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
    const pct = ctxPct(c.signals?.ctx);
    const doing = activityText(c.activity, c.status, c.signals);
    return h('button', { class: `hud-tile${c.status === 'waiting' ? ' is-waiting' : ''}`, type: 'button', title: c.title, onclick: () => openCard(c.id) },
      h('span', { class: 'hud-r1' }, statusTag(c.status), agentTag(c.agent)),
      h('span', { class: 'hud-t', text: c.title }),
      h('span', { class: 'hud-act', text: doing || relTime(c.updatedAt) }),
      h('span', { class: 'hud-prog' }, h('i', { class: heat(pct ?? 0), style: { width: `${pct ?? 0}%` } })));
  }));
}

// The picker: a thumbnail of each layout, plus the color theme (light / dark / system).
function layoutChooser(after = () => {}) {
  const box = h('div', { class: 'layout-chooser' });
  const paint = () => {
    box.replaceChildren(
      h('div', { class: 'lc-grid' }, LAYOUTS.map(([id, name, desc]) => h('button', { class: 'lc-card', type: 'button', 'aria-pressed': String(state.layout === id),
        onclick: () => { setLayout(id); paint(); after(); } },
        h('span', { class: `lc-thumb lc-${id}`, 'aria-hidden': 'true' }, h('i', { class: 'a' }), h('i', { class: 'b' }), h('i', { class: 'c' }), h('i', { class: 'd' })),
        h('span', { class: 'lc-name', text: name }), h('span', { class: 'lc-desc', text: desc })))),
      h('div', { class: 'field-label', text: '色' }),
      h('div', { class: 'lc-modes' }, [['light', 'sun', 'ライト'], ['dark', 'moon', 'ダーク'], ['system', 'system', 'システム']].map(([k, ic, n]) =>
        h('button', { type: 'button', 'aria-pressed': String((state.themePref || 'system') === k), onclick: () => { setThemePref(k); paintLayoutChrome(); paint(); } },
          h('span', { html: picon(ic, 16) }), n))));
  };
  paint();
  return box;
}
function layoutPicker(anchor) {
  popover(anchor, 'レイアウトと色', layoutChooser(), { width: 460 });
}

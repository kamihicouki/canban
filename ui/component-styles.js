// Component styles (included into board.html's script; shares its scope).
// A component with two designs keeps both; the user picks one per component in 「レイアウトとテーマ」
// and ⌘K. body[data-cs-<component>] carries the choice for CSS; renderers read state.styles.
const styleIs = (key, value) => state.styles[key] === value;
function applyComponentStyles() {
  for (const key of COMPONENT_STYLE_KEYS) document.body.dataset[`cs${key[0].toUpperCase()}${key.slice(1)}`] = state.styles[key];
}
// Which parts must be painted again after a style changes.
const STYLE_REPAINT = { boardCard: 'board', peek: 'board', boardView: 'board', detail: 'cards', conversation: 'cards', composer: 'cards', taskDetail: 'cards', review: 'cards' };
function setComponentStyle(key, value) {
  if (!COMPONENT_STYLES[key] || state.styles[key] === value) return;
  state.styles = normalizeComponentStyles({ ...state.styles, [key]: value });
  store.set('componentStyles', state.styles);
  applyComponentStyles();
  repaintForStyles(STYLE_REPAINT[key]);
}
function repaintForStyles(part) {
  if (part === 'board' || !paneLayer.hidden) { if (state.board) render(); }
  if (!paneLayer.hidden && panes[0] && panes[0].kind !== 'view') openCard(panes[0].id);
}
// One row per component: its name and a segmented choice. The description of the chosen one sits under it.
function componentStyleChooser() {
  const box = h('div', { class: 'cs-chooser' });
  const paint = () => box.replaceChildren(...COMPONENT_STYLE_KEYS.map((key) => {
    const [label, , options] = COMPONENT_STYLES[key];
    const chosen = options.find(([v]) => v === state.styles[key]) || options[0];
    return h('div', { class: 'cs-row' },
      h('div', { class: 'cs-name', text: label }),
      h('div', { class: 'seg-row', role: 'group', 'aria-label': `${label}のスタイル`, style: { gridTemplateColumns: `repeat(${options.length}, 1fr)` } },
        options.map(([v, text, desc]) => h('button', { class: 'seg-btn', type: 'button', title: desc, 'aria-pressed': String(state.styles[key] === v), text,
          onclick: () => { setComponentStyle(key, v); paint(); } }))),
      h('div', { class: 'cs-desc muted', text: chosen[2] }));
  }));
  paint();
  return box;
}

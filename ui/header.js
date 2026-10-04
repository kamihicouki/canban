// The app bar (included into board.html's script by server/ui.mjs; shares its scope).
// When it does not fit, it gives way in steps: the logo's word, then the full-text toggle,
// then button labels (icons stay), then the [data-pri] items into ⋯ from the lowest priority up.
let fitting = false;
function fitHeader() {
  const bar = $('.topbar');
  if (!bar || fitting) return;
  fitting = true;
  const items = [...bar.querySelectorAll('[data-pri]')].sort((x, y) => x.dataset.pri - y.dataset.pri);
  items.forEach((el) => el.classList.remove('folded'));
  bar.classList.remove('compact', 'no-word');
  const more = $('#moreBtn');
  more.hidden = true;
  const over = () => bar.scrollWidth > bar.clientWidth + 1;
  const steps = [() => bar.classList.add('no-word'), () => items[0]?.classList.add('folded'), () => bar.classList.add('compact'), ...items.slice(1).map((el) => () => el.classList.add('folded'))];
  for (const step of steps) {
    if (!over()) break;
    step();
    if (items.some((el) => el.classList.contains('folded'))) more.hidden = false;
  }
  more.hidden = !items.some((el) => el.classList.contains('folded'));
  fitting = false;
}
function moreMenu(anchor) {
  const folded = [...document.querySelectorAll('.topbar [data-pri].folded')].sort((x, y) => y.dataset.pri - x.dataset.pri);
  const go = (fn) => () => { closePopover(); fn(); };
  const rows = folded.map((el) => {
    if (el.id === 'days') return h('div', {}, h('div', { class: 'field-label', text: '期間' }), h('div', { class: 'more-row' },
      ...[...el.options].map((o) => h('button', { 'aria-pressed': String(o.value === el.value), text: o.textContent, onclick: go(() => { el.value = o.value; el.dispatchEvent(new Event('change')); }) }))));
    if (el.classList.contains('seg')) return h('div', {}, h('div', { class: 'field-label', text: T.aiApps }), h('div', { class: 'more-row' },
      ...[...el.querySelectorAll('button')].map((b) => h('button', { 'aria-pressed': b.getAttribute('aria-pressed'), text: b.textContent, onclick: go(() => b.click()) }))));
    if (el.classList.contains('ft-toggle')) {
      const cb = $('#fulltext');
      return h('button', { class: 'menu-item', onclick: go(() => { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }) }, `${cb.checked ? '☑' : '☐'} 本文も検索`);
    }
    const label = el.querySelector('.lbl')?.textContent.replace(/\s*▾$/, '') || el.textContent.replace(/\s*▾$/, '');
    // Menus opened from here anchor to ⋯ (the folded button has no place on screen).
    return h('button', { class: 'menu-item', onclick: () => { closePopover(); HEADER_OPEN[el.id]?.(anchor); } }, h('span', { html: picon(el.dataset.icon || 'more', 16) }), label.trim());
  });
  popover(anchor, 'その他', h('div', { class: 'more-menu' }, ...rows), { width: 260 });
}

const HEADER_OPEN = {};
$('#moreBtn').addEventListener('click', (e) => moreMenu(e.currentTarget));
if (typeof ResizeObserver === 'function') new ResizeObserver(() => fitHeader()).observe($('.topbar'));

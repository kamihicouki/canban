// Category navigation keeps frequent destinations on the board; the complete list stays selectable.
function categoryNavigation(directories, pins, selected = '') {
  const ids = Array.isArray(pins) ? pins : directories.slice(0, 5).map(d => d.id);
  const byId = new Map(directories.map(d => [d.id, d]));
  return [...new Set([...ids, selected].filter(Boolean))].map(id => byId.get(id)).filter(Boolean);
}
function toggleCategoryPin(directories, pins, id) {
  const current = Array.isArray(pins) ? pins : directories.slice(0, 5).map(d => d.id);
  return [...new Set(current.includes(id) ? current.filter(key => key !== id) : [...current, id])];
}
function allCategories(b = state.board) {
  return [...(b?.directories || []), { id: '__none', name: 'カテゴリ無し', color: null, count: b?.uncategorizedCount || 0 }];
}
function categoryIsPinned(id) { return categoryNavigation(allCategories(), state.categoryPins).some(d => d.id === id); }
function setCategoryPin(id) {
  state.categoryPins = toggleCategoryPin(allCategories(), state.categoryPins, id);
  store.set('categoryPins', state.categoryPins);
  const trigger = document.querySelector('.category-picker') ? categoryPickerAnchor() : null;
  renderSidebar(state.board);
  if (state.layout === 'omni') paintStrip(state.board);
  // Keep the open popover anchored to the same DOM button across navigation redraws.
  const replacement = trigger ? categoryPickerAnchor() : null;
  if (trigger?.matches('[data-all-categories]') && replacement !== trigger && replacement?.matches('[data-all-categories]')) replacement.replaceWith(trigger);
}
function categoryPickerAnchor() {
  return [...document.querySelectorAll('[data-all-categories]')].find(el => el.getClientRects().length) || $('#sideBtn');
}
function openCategoryPicker(anchor = null) {
  if (!state.board || laneHides('directory')) return;
  anchor ||= categoryPickerAnchor();
  const existing = document.querySelector('.category-picker');
  if (existing) { closePopover(existing); return; }
  const input = h('input', { type: 'search', class: 'text-input', placeholder: 'カテゴリ名で検索', 'aria-label': 'カテゴリ名で検索', autocomplete: 'off' });
  const list = h('div', { class: 'category-picker-list', role: 'group', 'aria-label': 'カテゴリ一覧' });
  const count = h('div', { class: 'muted', role: 'status', 'aria-live': 'polite' });
  let rows = [], active = 0;
  const select = id => { closePopover(p); if (laneHides('directory')) return; setScope({ directory: state.filters.directory === id ? '' : id }); };
  const mark = () => rows.forEach((row, i) => row.el.classList.toggle('active', i === active));
  const paintPin = (button, id) => {
    const on = categoryIsPinned(id);
    button.setAttribute('aria-pressed', String(on));
    button.setAttribute('aria-label', `${allCategories().find(d => d.id === id)?.name || ''} を${on ? '固定解除' : '固定'}`);
    button.title = `${on ? '固定解除' : '固定'}（Alt+P）`;
    button.innerHTML = picon('pin', 16);
  };
  const toggle = row => { if (!row) return; setCategoryPin(row.id); paintPin(row.pin, row.id); p.returnFocus = categoryPickerAnchor(); };
  const paint = () => {
    const hit = matcher(input.value.trim());
    rows = allCategories().filter(d => hit(d.name)).map(d => {
      const choose = h('button', { type: 'button', class: 'category-choice', 'aria-pressed': String(state.filters.directory === d.id), title: d.name, onclick: () => select(d.id) },
        h('span', { class: 'picker-check', text: state.filters.directory === d.id ? '✓' : '' }),
        h('span', { class: 'grow ellipsis', text: d.name }), h('span', { class: 'muted', text: String(d.count || 0) }));
      const pin = h('button', { type: 'button', class: 'icon-btn category-pin' });
      const row = { id: d.id, choose, pin, el: h('div', { class: 'category-picker-row' }, choose, pin) };
      pin.onclick = () => toggle(row); paintPin(pin, d.id);
      row.el.addEventListener('focusin', () => { active = rows.indexOf(row); mark(); });
      return row;
    });
    active = 0;
    list.replaceChildren(...rows.map(r => r.el));
    count.textContent = rows.length ? `${rows.length}件のカテゴリ` : '一致するカテゴリはありません';
    mark();
  };
  const p = popover(anchor, 'すべてのカテゴリ', h('div', { class: 'category-picker-body' }, input, count, list,
    h('div', { class: 'category-picker-hints' }, ...keycap('↑↓'), ' 選択 ', ...keycap('Enter'), ' 決定 ', ...keycap('Alt+P'), ' 固定・解除 ', ...keycap('Esc'))), { width: 360 });
  p.classList.add('category-picker');
  input.addEventListener('input', paint);
  p.addEventListener('keydown', e => {
    if (e.isComposing) return;
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyP') { e.preventDefault(); toggle(rows[active]); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = document.activeElement === input ? (e.key === 'ArrowDown' ? 0 : rows.length - 1) : active + (e.key === 'ArrowDown' ? 1 : -1);
      if (next < 0) input.focus(); else rows[Math.min(rows.length - 1, next)]?.choose.focus();
    } else if (e.key === 'Enter' && document.activeElement === input) { e.preventDefault(); if (rows[active]) select(rows[active].id); }
  });
  paint(); input.focus();
  return p;
}

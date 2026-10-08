// Part of board.html: included into its script by server/ui.mjs and shares its scope.
// Popovers
// Popovers remember what had focus and give it back when they close (keyboard flow).
// A `stack` popover opens on top of another one (e.g. a picker inside a menu).
function refocus(el) {
  if (!el || el === document.body) return;
  if (el.isConnected) return el.focus({ preventScroll: true });
  const id = el.dataset?.cardId;
  if (id) $(`.card[data-card-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
}
let popoverClosedAt = 0; // when a popover last closed: the press that closed it must not also close a card
function closePopover(p = null) {
  const all = [...document.querySelectorAll('.popover')];
  const gone = p ? all.slice(all.indexOf(p)) : all;
  if (!gone.length || (p && !p.isConnected)) return;
  gone.forEach((x) => { x.cleanupPopover?.(); x.remove(); x.onClose?.(); });
  popoverClosedAt = Date.now();
  if (!document.activeElement || document.activeElement === document.body) refocus(gone[0].returnFocus);
}
function popover(anchor, title, body, { width, stack = false } = {}) {
  if (anchor?._pagePanel) {
    anchor._pagePanel.replaceChildren(body);
    workspace.trackDrafts(body);
    return anchor._pagePanel;
  }
  const returnFocus = stack ? document.activeElement : document.querySelector('.popover')?.returnFocus || document.activeElement;
  if (!stack) closePopover();
  const p = h('div', { class: 'popover', role: 'dialog', 'aria-label': title, style: width ? { width: `${width}px` } : null },
    h('h3', { text: title }),
    h('button', { class: 'icon-btn close', 'aria-label': '閉じる', text: '✕', onclick: () => closePopover(p) }),
    body);
  p.returnFocus = returnFocus;
  document.body.append(p);
  const place = () => {
    if (!p.isConnected) return;
    const r = anchor.getBoundingClientRect();
    const minTop = Math.max(8, ($('.appbar')?.getBoundingClientRect().bottom || 48) + 8);
    p.style.maxHeight = `${Math.max(120, window.innerHeight - minTop - 8)}px`;
    p.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - p.offsetWidth - 8))}px`;
    p.style.top = `${Math.max(minTop, Math.min(r.bottom + 6, window.innerHeight - p.offsetHeight - 8))}px`;
  };
  place();
  const observer = new ResizeObserver(place);
  observer.observe(p);
  window.addEventListener('resize', place);
  p.cleanupPopover = () => { observer.disconnect(); window.removeEventListener('resize', place); };
  setTimeout(() => {
    const off = (e) => {
      if (!p.isConnected) return document.removeEventListener('pointerdown', off, true);
      const inside = e.target.closest?.('.popover');
      if (inside === p || (inside && [...document.querySelectorAll('.popover')].indexOf(inside) > [...document.querySelectorAll('.popover')].indexOf(p))) return;
      closePopover(p);
      document.removeEventListener('pointerdown', off, true);
    };
    document.addEventListener('pointerdown', off, true);
  });
  p.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopover(p); } });
  return p;
}

// Filterable picker (keyword filter, ↑↓ / Enter / Esc). Used for every
// attribute choice: lists, labels, directories, projects, machines, views…
const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
// Every whitespace-separated word must appear (case / width / kana insensitive).
const matcher = (q) => { const words = norm(q).split(/\s+/).filter(Boolean); return (text) => { const t = norm(text); return words.every((w) => t.includes(w)); }; };
function picker(anchor, { title, items, multi = false, selected = [], onPick, onCreate, createText = 'を作成', placeholder = 'キーワードで絞り込み…', width = 300, stack = false, footer = null, limit = 300 }) {
  const sel = new Set(selected);
  const input = h('input', { class: 'text-input picker-input', placeholder, 'aria-label': `${title}を絞り込み`, autocomplete: 'off' });
  const listEl = h('div', { class: 'picker-list', role: 'listbox', 'aria-label': title, 'aria-multiselectable': multi ? 'true' : null });
  let active = 0, rows = [];
  const mark = () => {
    listEl.querySelectorAll('.picker-row').forEach((el) => el.classList.toggle('active', Number(el.dataset.i) === active));
    listEl.querySelector('.picker-row.active')?.scrollIntoView({ block: 'nearest' });
  };
  const paint = () => {
    const raw = input.value.trim();
    const hit = matcher(raw);
    rows = items.filter((it) => hit(`${it.group || ''} ${it.label} ${it.description || ''} ${it.hint ?? ''} ${it.keywords || ''} ${it.badge || ''}`)).slice(0, limit).map((it) => ({ it }));
    if (onCreate && raw && !items.some((it) => norm(it.label) === norm(raw))) rows.push({ create: raw });
    active = Math.max(0, Math.min(active, rows.length - 1));
    let group;
    const out = [];
    rows.forEach((r, i) => {
      if (r.it?.group && r.it.group !== group) { group = r.it.group; out.push(h('div', { class: 'picker-group', text: group })); }
      const on = r.it && sel.has(r.it.value);
      out.push(h('button', { class: 'picker-row', role: 'option', 'aria-selected': String(!!on), 'data-i': i, tabindex: -1, type: 'button',
        onpointerdown: (e) => e.preventDefault(), onclick: () => choose(i), onmousemove: () => { if (active !== i) { active = i; mark(); } } },
        r.create ? h('span', { class: 'grow', text: `＋「${r.create}」${createText}` }) : [
          h('span', { class: 'picker-check', text: on ? '✓' : '' }),
          r.it.badge ? h('span', { class: 'picker-badge', text: r.it.badge }) : null,
          r.it.color ? h('span', { class: 'sdot', style: { background: colorVar(r.it.color) } }) : null,
          r.it.dot ? h('span', { class: `sdot s-${r.it.dot}` }) : null,
          r.it.description ? h('span', { class: 'grow picker-text', title: r.it.keywords || r.it.description },
            h('span', { class: 'picker-label ellipsis', text: r.it.label }), h('span', { class: 'picker-description', text: r.it.description }))
            : h('span', { class: 'grow ellipsis', text: r.it.label }),
          r.it.hint != null && r.it.hint !== '' ? h('span', { class: 'muted', text: String(r.it.hint) }) : null,
          r.it.tag ? h('span', { class: 'picker-tag', text: r.it.tag, title: r.it.tagTitle || r.it.tag }) : null]));
    });
    if (!rows.length) out.push(h('div', { class: 'muted picker-empty', text: '一致する項目はありません' }));
    listEl.replaceChildren(...out);
    mark();
  };
  const choose = (i) => {
    const r = rows[i];
    if (!r) return;
    if (r.create) { closePopover(p); return onCreate(r.create); }
    if (multi) {
      sel.has(r.it.value) ? sel.delete(r.it.value) : sel.add(r.it.value);
      onPick(r.it.value, sel.has(r.it.value), [...sel]);
      paint();
      input.focus();
      return;
    }
    closePopover(p);
    onPick(r.it.value, r.it);
  };
  input.addEventListener('input', () => { active = 0; paint(); });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) { e.preventDefault(); active = Math.min(rows.length - 1, active + 1); mark(); }
    else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) { e.preventDefault(); active = Math.max(0, active - 1); mark(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
    else if (e.key === ' ' && multi && !input.value) { e.preventDefault(); choose(active); }
  });
  const p = popover(anchor, title, h('div', { class: 'picker' }, input, listEl, footer), { width, stack });
  paint();
  const cur = rows.findIndex((r) => r.it && sel.has(r.it.value));
  if (cur > 0 && !multi) { active = cur; mark(); }
  input.focus();
  return p;
}
// A button that behaves like a <select> but opens the picker. `.value` holds the choice.
function pickerButton({ title, popoverTitle = title, items, value, onChange, stack = true, className = 'text-input picker-btn', label = 'aria-label', footer = null, width = 300, placeholder, popoverClass = '' }) {
  const btn = h('button', { class: className, type: 'button', 'aria-haspopup': 'listbox', [label]: title });
  const paint = () => {
    const it = items().find((i) => i.value === btn.value);
    btn.classList.toggle('rich', !!it?.description);
    btn.title = it?.keywords || it?.description || it?.label || '';
    if (it?.description) btn.replaceChildren(h('span', { class: 'grow picker-text' },
      h('span', { class: 'picker-label ellipsis', text: it.label }), h('span', { class: 'picker-description', text: it.description })), h('span', { text: '▾', 'aria-hidden': 'true' }));
    else btn.textContent = `${it ? it.label : '—'} ▾`;
  };
  btn.repaint = paint;
  btn.value = value;
  btn.onclick = () => {
    const p = picker(btn, { title: popoverTitle, items: items(), selected: [btn.value], stack, width, placeholder,
      footer: typeof footer === 'function' ? footer() : footer, onPick: (v) => { btn.value = v; paint(); onChange?.(v); } });
    if (popoverClass) p.classList.add(popoverClass);
  };
  paint();
  return btn;
}
// Keyword filter for menus whose rows are richer than picker items (rows carry data-key).
function rowFilter(rows, placeholder = 'キーワードで絞り込み…') {
  return h('input', { class: 'text-input picker-input', placeholder, 'aria-label': placeholder, style: { marginBottom: '6px' },
    oninput: (e) => { const hit = matcher(e.target.value); rows.forEach((r) => (r.hidden = !hit(r.dataset.key))); } });
}

function listMenu(anchor, list) {
  const b = state.board;
  const wip = h('input', { class: 'text-input', type: 'number', min: 0, placeholder: 'なし', value: list.wipLimit ?? '' });
  const body = h('div', {},
    h('button', { class: 'menu-item', text: '名前を変更', onclick: () => { closePopover(); editListTitle($(`.list[data-list-id="${list.id}"] .list-title`), list); } }),
    list.isDefault ? null : h('button', { class: 'menu-item', text: '新しいセッションの受け皿にする', onclick: () => { closePopover(); act('canban_set_default_list', { listId: list.id }, { okMsg: `「${list.title}」を既定リストにしました` }); } }),
    h('div', { class: 'sep' }),
    h('div', { class: 'field-label', text: 'リストの色' }),
    h('div', { class: 'swatches' },
      [null, ...COLORS].map((c) => h('button', { class: 'swatch', title: c ? COLOR_NAMES[c] : '色なし', 'aria-label': c ? COLOR_NAMES[c] : '色なし', 'aria-pressed': String((list.color || null) === c),
        style: { background: c ? colorVar(c) : 'var(--btn-subtle-hover)' }, text: c ? '' : '✕',
        onclick: () => { closePopover(); act('canban_update_list', { listId: list.id, color: c }); } }))),
    h('div', { class: 'field-label', text: 'WIP 制限（カード数の上限）' }),
    h('div', { class: 'row' }, wip, h('button', { class: 'btn', text: '保存', onclick: () => { closePopover(); act('canban_update_list', { listId: list.id, wipLimit: wip.value === '' ? null : Number(wip.value) }); } })),
    h('div', { class: 'sep' }),
    b.lists.length > 1 ? h('button', { class: 'menu-item danger', text: 'このリストを削除…', onclick: () => confirmDeleteList(anchor, list) }) : null,
  );
  popover(anchor, 'リストの操作', body);
}

function confirmDeleteList(anchor, list) {
  const others = state.board.lists.filter((l) => l.id !== list.id);
  const target = others.find((l) => l.isDefault) || others[0];
  const sel = h('select', { class: 'text-input' }, others.map((l) => h('option', { value: l.id, text: l.title })));
  sel.value = target.id;
  popover(anchor, 'リストを削除', h('div', {},
    h('p', { text: `「${list.title}」を削除します。含まれるカード（${list.count} 件）は次のリストへ移動します。セッション本体は削除されません。` }),
    sel,
    h('div', { class: 'row', style: { marginTop: '8px' } },
      h('button', { class: 'btn-danger', text: '削除', onclick: () => { closePopover(); act('canban_delete_list', { listId: list.id, moveCardsTo: sel.value }, { okMsg: 'リストを削除しました' }); } }))));
}

// 色: light / dark / system. The only matter of taste left; everything else on the board follows the cards' lifetime.
const THEME_CHOICES = [['light', 'sun', 'ライト'], ['dark', 'moon', 'ダーク'], ['system', 'system', 'システム']];
function themeMenu(anchor) {
  popover(anchor, '色', h('div', { class: 'theme-modes', role: 'group', 'aria-label': '色' }, THEME_CHOICES.map(([k, ic, n]) =>
    h('button', { type: 'button', 'aria-pressed': String((state.themePref || 'system') === k), onclick: () => { setThemePref(k); themeMenu(anchor); } },
      h('span', { html: picon(ic, 16) }), n))), { width: 300 });
}

function labelsManager(anchor) {
  const render_ = () => {
    const rows = state.board.labels.map((l) => {
      const name = h('input', { class: 'text-input', value: l.name, 'aria-label': 'ラベル名' });
      name.dataset.labelName = l.name;
      name.onchange = () => act('canban_update_label', { labelId: l.id, name: name.value }).then(render_);
      const color = h('select', { class: 'text-input', style: { width: '96px' }, 'aria-label': '色' }, COLORS.map((c) => h('option', { value: c, text: COLOR_NAMES[c] })));
      color.value = l.color;
      color.onchange = () => act('canban_update_label', { labelId: l.id, color: color.value }).then(render_);
      return h('div', { class: 'row', style: { marginBottom: '6px' }, 'data-key': `${l.name} ${COLOR_NAMES[l.color] || ''}` },
        h('span', { class: 'swatch', style: { width: '20px', height: '20px', background: colorVar(l.color), flex: 'none' } }), name, color,
        h('button', { class: 'icon-btn', 'aria-label': `${l.name} を削除`, text: '🗑', onclick: () => act('canban_delete_label', { labelId: l.id }).then(render_) }));
    });
    const newName = h('input', { class: 'text-input', placeholder: '新しいラベル' });
    const newColor = h('select', { class: 'text-input', style: { width: '96px' } }, COLORS.map((c) => h('option', { value: c, text: COLOR_NAMES[c] })));
    newColor.value = 'blue';
    const add = () => newName.value.trim() && act('canban_create_label', { name: newName.value, color: newColor.value }).then(render_);
    newName.onkeydown = (e) => { if (e.key === 'Enter') add(); };
    popover(anchor, 'ラベル', h('div', {}, rows.length > 5 ? rowFilter(rows) : null, rows, h('div', { class: 'sep' }), h('div', { class: 'row' }, newName, newColor), h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn-primary', text: '追加', onclick: add }))), { width: 360 });
  };
  render_();
}

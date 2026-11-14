// Part of board.html: included into its script by server/ui.mjs and shares its scope.
// Header wiring
let qTimer;
$('#q').value = state.filters.q || '';
const applySearch = () => { clearTimeout(qTimer); state.filters.q = $('#q').value; saveFilters(); state.shown = {}; return load(); };
$('#q').addEventListener('input', () => {
  clearTimeout(qTimer);
  qTimer = setTimeout(applySearch, 250);
});
// In the search box: Esc clears (then leaves), ↓ / Enter jump to the first hit.
// Prefixes: '/' opens the command palette, '@' opens task/session creation.
$('#q').placeholder = '検索、/ コマンド、@ 作成…';
$('#q').addEventListener('keydown', async (e) => {
  if (e.isComposing) return;
  const val = $('#q').value.trim();
  if (e.key === 'Escape') {
    e.preventDefault();
    if ($('#q').value) { $('#q').value = ''; applySearch(); } else { $('#q').blur(); $('#board .card')?.focus(); }
  } else if (e.key === 'Enter' && val.startsWith('/')) {
    e.preventDefault();
    $('#q').value = '';
    applySearch();
    commandPalette();
  } else if (e.key === 'Enter' && val.startsWith('@')) {
    e.preventDefault();
    $('#q').value = '';
    applySearch();
    quickAdd();
  } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
    e.preventDefault();
    if (state.filters.q !== $('#q').value) await applySearch();
    $('#board .card')?.focus();
  }
});
function focusSearch() {
  $('#q').focus();
  $('#q').select();
}

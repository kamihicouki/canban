// Part of board.html: included into its script by server/ui.mjs and shares its scope.
// The app bar's own controls, wired once the header and the account button exist.
$('#quickTaskBtn').addEventListener('click', () => taskQuickAdd.open());
$('#logo').addEventListener('click', (e) => scopePicker(e.currentTarget));
$('#sideBtn').addEventListener('click', () => toggleSidebar());
$('#fulltext').checked = !!state.filters.fulltext;
$('#fulltext').addEventListener('change', (e) => { state.filters.fulltext = e.target.checked; saveFilters(); if (state.filters.q) load(); });
// Analytics is a sheet on the overlay, over the board (a / the sidebar's 分析 toggle it).
function toggleAnalytics() { toggleView('analytics'); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.querySelector('.popover')) closePopover(); });

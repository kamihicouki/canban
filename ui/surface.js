// The display surface is selected before state is loaded.
const SURFACE = new URLSearchParams(location.search).get('surface') === 'sidepanel' || window.name === 'canban-surface:sidepanel' ? 'sidepanel' : 'page';
document.documentElement.dataset.surface = SURFACE;

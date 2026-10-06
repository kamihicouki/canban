// Canban's one icon language: 24px line icons, stroke 1.8, round caps (AGENTS.md「見た目」).
// Header/board-bar buttons name an icon with data-icon; fillIcons() puts the SVG in.
const PIC = {
  box: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v12h14V8M10 12h4"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',

  message: '<path d="M4 4h16v12H9l-5 4z"/><path d="M8 8h8M8 12h5"/>',
  grip: '<g fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></g>',
  chev: '<path d="M6 9l6 6 6-6"/>', close: '<path d="M6 6l12 12M18 6L6 18"/>', note: '<path d="M5 5h14v9l-5 5H5z"/><path d="M14 19v-5h5"/>',
  lock: '<path d="M8 11V8a4 4 0 018 0v3"/><rect x="5" y="11" width="14" height="9" rx="2"/>',
  free: '<path d="M14 4h6v6M20 4l-9 9M10 6H5v13h13v-5"/>',
  follow: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/>',
  view: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  system: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  board: '<rect x="3" y="4" width="5" height="14" rx="1.5"/><rect x="10" y="4" width="5" height="9" rx="1.5"/><rect x="17" y="4" width="4" height="6" rx="1.5"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>',
  gauge: '<path d="M12 14l4-4"/><path d="M3.5 18a9 9 0 1 1 17 0"/>',
  zap: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="7.5" r="1.2"/>',
  folder: '<path d="M3 6h6l2 2h10v11H3z"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  more: '<g fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></g>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  layout: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/>',
  cards: '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="M19 8v11a2 2 0 0 1-2 2H8"/>',
};
const picon = (n, s = 16) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PIC[n] || ''}</svg>`;
function fillIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]:not([data-icon-done])')) {
    el.insertAdjacentHTML('afterbegin', picon(el.dataset.icon, Number(el.dataset.iconSize) || 18));
    el.dataset.iconDone = '1';
  }
}
// The logo: three columns of different lengths (a kanban board) and a dot (an agent at work).
const LOGO_SVG = '<svg class="logo-mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="var(--logo-bg)"/><g fill="var(--logo-fg)"><rect x="7" y="7" width="5" height="17" rx="2.5"/><rect x="13.5" y="7" width="5" height="11" rx="2.5" opacity=".8"/><rect x="20" y="7" width="5" height="6.5" rx="2.5" opacity=".62"/><circle cx="22.5" cy="21.5" r="3.2"/></g></svg>';

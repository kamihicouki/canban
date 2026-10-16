// Part of board.html: included into its script by server/ui.mjs and shares its scope.
const pbtn = (icon, label, fn, cls = '') => h('button', { class: `icon-btn ${cls}`, type: 'button', 'aria-label': label, title: label, html: picon(icon), onclick: (e) => { e.stopPropagation(); fn(e); } });

// ---- the assistant's text as a preview (Markdown, lightly) ----
const escH = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// Links open in a new tab; the trailing punctuation of a sentence stays outside the link.
const mdLinks = (s) => s.replace(/https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]）」』。、]/g, (url) => `<a href="${url.replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer">${url}</a>`);
const mdInline = (s) => mdLinks(escH(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>'));
function mdHtml(src) {
  const out = [];
  let list = null, code = null, table = null;
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const flush = () => {
    if (list) { out.push(`<${list.tag}>${list.items.join('')}</${list.tag}>`); list = null; }
    if (table) {
      const [head, ...rows] = table;
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${mdInline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      table = null;
    }
  };
  const item = (tag, html) => { if (list?.tag !== tag) { flush(); list = { tag, items: [] }; } list.items.push(`<li>${html}</li>`); };
  for (const line of String(src).split('\n')) {
    if (/^\s*```/.test(line)) { if (code) { out.push(`<pre><code>${escH(code.join('\n'))}</code></pre>`); code = null; } else { flush(); code = []; } continue; }
    if (code) { code.push(line); continue; }
    // A table is a | row | followed by its |---| divider; rows keep going until a line without pipes.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (table) { if (!/^\s*\|[\s:|-]+\|\s*$/.test(line)) table.push(cells(line)); continue; }
      flush(); table = [cells(line)]; continue;
    }
    const li = line.match(/^\s*[-*] (.*)$/);
    if (li) { item('ul', mdInline(li[1])); continue; }
    const ol = line.match(/^\s*\d+[.)] (.*)$/);
    if (ol) { item('ol', mdInline(ol[1])); continue; }
    if (list && !line.trim()) continue; // a blank line between items keeps one list
    flush();
    const hd = line.match(/^#{1,6}\s+(.*)$/);
    if (hd) out.push(`<p><strong>${mdInline(hd[1])}</strong></p>`);
    else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) out.push('<hr>');
    else if (line.trim()) out.push(`<p>${mdInline(line)}</p>`);
  }
  flush();
  if (code) out.push(`<pre><code>${escH(code.join('\n'))}</code></pre>`);
  return out.join('');
}

// ---- the layer that holds the cards ----
const paneLayer = h('div', { id: 'paneLayer', class: 'pane-layer', hidden: true });
// The same layer docks on the right of the 時間軸 (inbox.js): no scrim, the list stays usable, Enter opens it large.
const paneDocked = () => !paneLayer.hidden && paneLayer.classList.contains('docked');
const overlayOpen = () => !paneLayer.hidden && !paneLayer.classList.contains('docked');
const inDockedPane = (el) => paneDocked() && !!el?.closest?.('#paneLayer');
const paneBar = h('div', { class: 'pane-bar', role: 'toolbar', 'aria-label': 'カードの表示' });
const paneStage = h('div', { class: 'pane-stage' });
const paneRow = h('div', { class: 'pane-row' });
paneStage.append(paneRow);

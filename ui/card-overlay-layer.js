// Part of board.html: included into its script by server/ui.mjs and shares its scope.
const pbtn = (icon, label, fn, cls = '') => h('button', { class: `icon-btn ${cls}`, type: 'button', 'aria-label': label, title: label, html: picon(icon), onclick: (e) => { e.stopPropagation(); fn(e); } });

// ---- the assistant's text as a preview (Markdown, lightly) ----
const escH = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const mdInline = (s) => escH(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
function mdHtml(src) {
  const out = [];
  let list = null, code = null;
  const flush = () => { if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; } };
  for (const line of String(src).split('\n')) {
    if (/^\s*```/.test(line)) { if (code) { out.push(`<pre><code>${escH(code.join('\n'))}</code></pre>`); code = null; } else { flush(); code = []; } continue; }
    if (code) { code.push(line); continue; }
    const li = line.match(/^\s*[-*] (.*)$/);
    if (li) { (list = list || []).push(`<li>${mdInline(li[1])}</li>`); continue; }
    flush();
    const hd = line.match(/^#{1,6}\s+(.*)$/);
    if (hd) out.push(`<p><strong>${mdInline(hd[1])}</strong></p>`);
    else if (line.trim()) out.push(`<p>${mdInline(line)}</p>`);
  }
  flush();
  if (code) out.push(`<pre><code>${escH(code.join('\n'))}</code></pre>`);
  return out.join('');
}

// ---- the layer that holds the cards ----
const paneLayer = h('div', { id: 'paneLayer', class: 'pane-layer', hidden: true });
const paneBar = h('div', { class: 'pane-bar', role: 'toolbar', 'aria-label': 'カードの表示' });
const paneStage = h('div', { class: 'pane-stage' });
const paneRow = h('div', { class: 'pane-row' });
paneStage.append(paneRow);

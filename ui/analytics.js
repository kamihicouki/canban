// Part of board.html: included into its script by server/ui.mjs and shares its scope.
// Analytics view
const VIZ = { codex: '#12a381', claude: '#d46f4c' }; // validated categorical pair (light + dark)
const fmtNum = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));
function fmtDur(ms) {
  if (ms == null) return '—';
  const h = ms / 3600e3;
  return h < 1 ? `${Math.round(ms / 60e3)} 分` : h < 48 ? `${h.toFixed(1)} 時間` : `${(h / 24).toFixed(1)} 日`;
}
// Analytics renders into its sheet on the overlay; the board underneath keeps its own data.
let statsSeq = 0;
async function loadAnalytics(p) {
  const seq = ++statsSeq, body = $('.sheet-b', p.el);
  try {
    if (!state.board) return; // the board loads first; refreshViews() comes back after it
    const f = state.filters;
    const args = { days: state.analyticsDays || 30, agent: f.agent };
    for (const key of ['project', 'folder', 'section', 'label']) if (f[key]) args[key] = f[key];
    if (f.host) args.host = f.host;
    if (f.account) args.account = f.account;
    if (f.directory) args.directory = f.directory;
    const st = await bridge.callTool('canban_get_stats', args);
    if (seq === statsSeq && panes.includes(p)) renderAnalytics(st, p);
  } catch (e) {
    if (seq === statsSeq && body) body.replaceChildren(h('div', { class: 'loading', text: `分析を読み込めませんでした: ${e.message}` }));
  }
}
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
// Rect with only the top corners rounded (data end), square at the baseline.
function topRounded(x, y, w, hgt, r) {
  r = Math.min(r, w / 2, hgt);
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}
function niceMax(v) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / p / (v / p > 5 ? 2 : 1)) * p * (v / p > 5 ? 2 : 1);
}
function dailyChart(st, tip) {
  const W = Math.max(480, Math.min(1100, $('#board').clientWidth - 72));
  const H = 220, L = 36, R = 8, T = 8, B = 26;
  const data = st.daily;
  const max = niceMax(Math.max(1, ...data.map((d) => d.codex + d.claude)));
  const bw = (W - L - R) / data.length;
  const barW = Math.max(3, Math.min(18, bw * 0.62));
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': '日別のセッション数（Codex / Claude の積み上げ）' });
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    svg.append(svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }));
    const t = svgEl('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis' });
    t.textContent = Math.round(v);
    svg.append(t);
  }
  data.forEach((d, i) => {
    const cx = L + bw * i + bw / 2;
    const x = cx - barW / 2;
    const hCodex = (H - T - B) * (d.codex / max);
    const hClaude = (H - T - B) * (d.claude / max);
    const base = H - B;
    const gap = d.codex && d.claude ? 2 : 0;
    if (d.codex) svg.append(svgEl('path', { d: d.claude ? `M${x},${base}h${barW}v${-hCodex}h${-barW}Z` : topRounded(x, base - hCodex, barW, hCodex, 4), fill: VIZ.codex }));
    if (d.claude) svg.append(svgEl('path', { d: topRounded(x, base - hCodex - gap - hClaude, barW, hClaude, 4), fill: VIZ.claude }));
    if (i % Math.ceil(data.length / 8) === 0 || i === data.length - 1) {
      const t = svgEl('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: 'axis' });
      t.textContent = d.date.slice(5).replace('-', '/');
      svg.append(t);
    }
    const hit = svgEl('rect', { x: L + bw * i, y: T, width: bw, height: H - T - B, fill: 'transparent', class: 'hit' });
    hit.addEventListener('mouseenter', (e) => tip.show(e, [`${d.date}`, `Codex ${d.codex}`, `Claude ${d.claude}`, `トークン ${fmtNum(d.tokens)}`]));
    hit.addEventListener('mousemove', (e) => tip.move(e));
    hit.addEventListener('mouseleave', () => tip.hide());
    svg.append(hit);
  });
  return svg;
}
function makeTip(host) {
  const el = h('div', { class: 'viz-tip', role: 'tooltip', hidden: true });
  host.append(el);
  return {
    show(e, lines) { el.replaceChildren(...lines.map((l, i) => h('div', { class: i ? '' : 'tip-head', text: l }))); el.hidden = false; this.move(e); },
    move(e) { const r = host.getBoundingClientRect(); el.style.left = `${e.clientX - r.left + 12}px`; el.style.top = `${e.clientY - r.top + 12}px`; },
    hide() { el.hidden = true; },
  };
}
function breakdownRows(rows, tip) {
  const max = Math.max(1, ...rows.map((r) => r.sessions));
  return h('div', { class: 'hbars' }, rows.map((r) => {
    const bar = h('div', { class: 'hbar' },
      r.codex ? h('span', { style: { width: `${(r.codex / max) * 100}%`, background: VIZ.codex } }) : null,
      r.claude ? h('span', { style: { width: `${(r.claude / max) * 100}%`, background: VIZ.claude } }) : null);
    const row = h('div', { class: 'hbar-row' }, h('span', { class: 'hbar-name ellipsis', title: r.name, text: r.name }), bar,
      h('span', { class: 'hbar-val', text: `${r.sessions} 件 · ${fmtNum(r.tokens)}` }));
    row.addEventListener('mouseenter', (e) => tip.show(e, [r.name, `Codex ${r.codex || 0} / Claude ${r.claude || 0}`, `トークン ${r.tokens.toLocaleString()}`]));
    row.addEventListener('mousemove', (e) => tip.move(e));
    row.addEventListener('mouseleave', () => tip.hide());
    return row;
  }));
}
function renderAnalytics(st, p) {
  const body = $('.sheet-b', p.el);
  if (!body) return;
  const page = h('div', { class: 'analytics' });
  const tip = makeTip(page);
  const daysSeg = h('div', { class: 'seg', role: 'group', 'aria-label': '期間' }, [7, 30, 90].map((d) =>
    h('button', { 'aria-pressed': String((state.analyticsDays || 30) === d), text: `${d}日`, onclick: () => { state.analyticsDays = d; loadAnalytics(p); } })));
  const legend = h('div', { class: 'legend' },
    h('span', {}, h('i', { style: { background: VIZ.codex } }), 'Codex'), h('span', {}, h('i', { style: { background: VIZ.claude } }), 'Claude Code'));
  const tile = (label, value, sub) => h('div', { class: 'tile' }, h('div', { class: 'tile-label', text: label }), h('div', { class: 'tile-value', text: value }), sub ? h('div', { class: 'tile-sub', text: sub }) : null);
  const table = h('details', { class: 'viz-table' }, h('summary', { text: '表で見る' }),
    h('table', {}, h('thead', {}, h('tr', {}, ['日付', 'Codex', 'Claude', 'トークン'].map((t) => h('th', { text: t })))),
      h('tbody', {}, st.daily.map((d) => h('tr', {}, [d.date, d.codex, d.claude, d.tokens.toLocaleString()].map((v) => h('td', { text: String(v) })))))));
  const lists = h('table', { class: 'plain' },
    h('thead', {}, h('tr', {}, ['リスト', 'カード', '滞留（中央値）'].map((t) => h('th', { text: t })))),
    h('tbody', {}, st.lists.map((l) => h('tr', {},
      h('td', {}, h('span', { class: 'stripe', style: { background: colorVar(l.color) } }), ` ${l.title}`), h('td', { text: String(l.cards) }), h('td', { text: fmtDur(l.medianDwellMs) })))));
  const wmax = Math.max(1, ...st.cycle.weekly.map((w) => w.count));
  const weekly = st.cycle.weekly.length ? h('div', { class: 'hbars' }, st.cycle.weekly.map((w) => h('div', { class: 'hbar-row' },
    h('span', { class: 'hbar-name', text: `${w.week.slice(5).replace('-', '/')} 週` }),
    h('div', { class: 'hbar' }, h('span', { style: { width: `${(w.count / wmax) * 100}%`, background: 'var(--c-blue)' } })),
    h('span', { class: 'hbar-val', text: `${w.count} 件` })))) : h('p', { class: 'muted', text: 'まだ完了したカードの記録がありません（カードを最後のリストへ移すと記録されます）' });
  page.append(
    h('div', { class: 'row analytics-bar' }, h('h2', { text: '分析' }), daysSeg,
      h('span', { class: 'muted', text: `AI Apps・マシン・アカウント・${T.category}の絞り込みは、アプリバーとサイドバーで選んだ条件に従います` })),
    h('div', { class: 'tiles' },
      tile('セッション', st.totals.sessions.toLocaleString(), `Codex ${st.totals.codex} / Claude ${st.totals.claude}`),
      tile('トークン', fmtNum(st.totals.tokens), st.totals.tokens.toLocaleString()),
      tile(`「${st.lists.find((l) => l.id === st.cycle.doneListId)?.title ?? '最後のリスト'}」へ移動`, `${st.cycle.count} 件`, `直近 ${st.days} 日`),
      tile('サイクルタイム（中央値）', fmtDur(st.cycle.medianMs), '最初の配置 → 最後のリスト')),
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', { text: '日別のセッション数' }), legend), dailyChart(st, tip), table),
    h('div', { class: 'panel-grid' },
      h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', { text: 'カテゴリ別' }), legend.cloneNode(true)), breakdownRows(st.directories, tip)),
      h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', { text: 'マシン別' }), legend.cloneNode(true)), breakdownRows(st.hosts, tip)),
      accountsPanel(st, legend, tip)),
    h('div', { class: 'panel-grid' },
      h('section', { class: 'panel' }, h('h3', { text: 'リストの滞留時間' }), lists),
      h('section', { class: 'panel' }, h('h3', { text: '週ごとの完了数' }), weekly)));
  const top = body.scrollTop;
  body.replaceChildren(page);
  body.scrollTop = top;
}

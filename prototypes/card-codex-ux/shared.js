// Shared helpers for the card-codex-ux previews: icons, theme, prototype bar, faux shell, sample thread.
// Icons use the product's line language (24px, stroke 1.8). Names marked NEW are not yet in ui/icons.js PIC.
const IC = {
  chev: '<path d="M6 9l6 6 6-6"/>', right: '<path d="M9 6l6 6-6 6"/>', left: '<path d="M15 6l-6 6 6 6"/>', up: '<path d="M6 15l6-6 6 6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>', plus: '<path d="M12 5v14M5 12h14"/>', search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  more: '<g fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></g>',
  check: '<path d="M5 12l5 5L20 7"/>', alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
  folder: '<path d="M3 6h6l2 2h10v11H3z"/>', tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="7.5" r="1.2"/>',
  zap: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>', sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  board: '<rect x="3" y="4" width="5" height="14" rx="1.5"/><rect x="10" y="4" width="5" height="9" rx="1.5"/><rect x="17" y="4" width="4" height="6" rx="1.5"/>',
  message: '<path d="M4 4h16v12H9l-5 4z"/><path d="M8 8h8M8 12h5"/>', note: '<path d="M5 5h14v9l-5 5H5z"/><path d="M14 19v-5h5"/>',
  lock: '<path d="M8 11V8a4 4 0 018 0v3"/><rect x="5" y="11" width="14" height="9" rx="2"/>', sliders: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>', eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>', filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>', gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  gauge: '<path d="M12 14l4-4"/><path d="M3.5 18a9 9 0 1 1 17 0"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  // NEW
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>', diff: '<path d="M7 3v12M3 7h8M13 17h8"/><circle cx="17" cy="19" r="0"/><path d="M15 6h6"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/>', stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>', terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 10l3 2-3 2M12 15h5"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10M18 11c0 4-6 3-12 6"/>',
  pr: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10M18 17V9a3 3 0 00-3-3h-2M15 3l-2 3 2 3"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>', clip: '<path d="M20 11l-8.5 8.5a5 5 0 01-7-7L13 4a3.3 3.3 0 014.7 4.7l-8.5 8.5a1.7 1.7 0 01-2.4-2.4L14 7"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', file: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/>',
  play: '<path d="M7 4l13 8-13 8z"/>', image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 9"/>',
  queue: '<path d="M4 6h16M4 12h16M4 18h9"/>', bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>', pin: '<path d="M9 3h6l-1 6 3 3H7l3-3zM12 12v9"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  hash: '<path d="M5 9h14M5 15h14M10 4L8 20M16 4l-2 16"/>', at: '<circle cx="12" cy="12" r="4"/><path d="M16 12v1.5a2.5 2.5 0 005 0V12a9 9 0 10-3.5 7.1"/>',
  checklist: '<path d="M4 6l2 2 3-3M4 14l2 2 3-3M12 7h8M12 15h8"/>', link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3A4 4 0 0011 18.7l1-1"/>',
  rewind: '<path d="M11 6l-7 6 7 6zM20 6l-7 6 7 6z"/>', copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>',
  cmd: '<path d="M9 9h6v6H9zM9 9V6a3 3 0 10-3 3zM15 9V6a3 3 0 113 3zM9 15v3a3 3 0 11-3-3zM15 15v3a3 3 0 103-3z"/>',
};
const ic = (n, s = 16) => `<svg class="ic" viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[n] || ''}</svg>`;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fillIc = (root = document) => $$('[data-i]:not([data-done])', root).forEach((el) => { el.insertAdjacentHTML('afterbegin', ic(el.dataset.i, +el.dataset.s || 16)); el.dataset.done = 1; });
const kc = (k) => `<span class="keycap">${k}</span>`;

// ---- theme + prototype bar ----
(function theme() {
  const q = new URLSearchParams(location.search);
  let t = q.get('theme');
  try { t = t || localStorage.getItem('cx-theme'); } catch {}
  if (!t) t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
  if (q.get('bar') === '0') document.addEventListener('DOMContentLoaded', () => document.body.classList.add('nobar'));
})();
function protoBar(title) {
  const bar = document.createElement('div'); bar.className = 'proto-bar';
  bar.innerHTML = `<a href="index.html">${ic('left', 14)} 一覧</a><span class="t">${title}</span><button id="themeBtn" title="ライト / ダーク">${ic('moon', 14)}</button>`;
  document.body.append(bar);
  const set = (t) => { document.documentElement.dataset.theme = t; try { localStorage.setItem('cx-theme', t); } catch {} $('#themeBtn').innerHTML = ic(t === 'dark' ? 'sun' : 'moon', 14); };
  $('#themeBtn').onclick = () => set(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  $('#themeBtn').innerHTML = ic(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon', 14);
}
const LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="var(--logo-bg)"/><g fill="var(--logo-fg)"><rect x="7" y="7" width="5" height="17" rx="2.5"/><rect x="14" y="7" width="5" height="11" rx="2.5"/><rect x="21" y="7" width="4" height="6" rx="2"/><circle cx="23" cy="22" r="2.2"/></g></svg>';
// Faux Canban shell: app bar + stage. Returns the stage element.
function shell(title, { backdrop = true } = {}) {
  document.body.insertAdjacentHTML('afterbegin', `
  <header class="appbar"><button class="hb" data-i="sidebar" data-s="18"></button><span class="logo">${LOGO}canban</span><span class="hb" style="font-weight:700">すべてのセッション ${ic('chev', 12)}</span>
  <span class="search">${ic('search', 15)}<span class="grow">検索・コマンド</span>${kc('/')} ${kc('⌘K')}</span>
  <span class="hb" style="background:var(--primary-bg);color:var(--primary-fg)">${ic('plus', 14)} 作成 ${kc('c')}</span><span class="grow"></span><span class="hb">${ic('refresh', 16)}</span></header>
  <main class="stage" id="stage"></main>`);
  protoBar(title);
  const stage = $('#stage');
  if (backdrop) stage.innerHTML = `<div class="bgboard">${['未着手', '進行中', 'レビュー', '完了'].map((n, i) => `<div class="l"><b>${n}</b>${'<div class="c"></div>'.repeat(4 - i % 3)}</div>`).join('')}</div>`;
  fillIc();
  return stage;
}

// ---- sample session ----
const SAMPLE = {
  title: 'カレンダーをインフィニティスクロールに', agent: 'Codex', branch: 'feat/calendar-infinite', pr: '#128', ctx: 42, dir: 'nuxt-app', list: '進行中',
  files: [['nuxt-app/assets/css/', 'cal-event-f-integrated.css', 20, 3], ['nuxt-app/assets/css/', 'cal-neumorph.css', 6, 1], ['', 'DESIGN.md', 10, 1], ['nuxt-app/components/', 'CalendarGrid.vue', 31, 0], ['nuxt-app/composables/', 'useInfiniteWeeks.ts', 7, 0]],
};
const THREAD_HTML = ({ running = true, open = false } = {}) => `
<div class="thumbs"><div class="thumb"></div></div>
<div class="msg-user"><ol><li>カレンダーの左右切り替えを廃止。上限またはスクロールによるインフィニティスクロールを模して、スムースに日が地続きになるイメージ ui preview を作ってから実装して</li><li>左の年月と月日に使うフォントスタイルを統一して。現行年月のスタイルを基準に<ol><li>年月に年のサフィックスをつけて</li></ol></li><li>バッジのフォントサイズを少し大きく。強調して。</li></ol></div>
<div class="work-div"><span class="num wk">7m 24s</span>${running ? "作業中" : "作業しました"}</div>
<div class="msg-agent"><p>Product Designを使い、日付が連続して上下にスクロールするカレンダーのプレビューを先に作ります。年月・日付の書体とバッジの強調もそこで確認し、製品へ実装します。</p></div>
<div class="tools${open ? ' open' : ''}"><button><span class="chev">${ic('right', 13)}</span><span class="sum">Headroomの連携を使用しました · ツールを読み込みました · ファイルを読み込む · コマンドを実行しました</span></button>
<ul><li>${ic('spark', 14)}<span>Headroom 連携を使用</span><time>0.4s</time></li><li>${ic('file', 14)}<span class="mono">nuxt-app/assets/css/cal-neumorph.css</span><time>0.1s</time></li><li>${ic('file', 14)}<span class="mono">DESIGN.md</span><time>0.1s</time></li><li>${ic('terminal', 14)}<span class="mono">npm run lint -- --quiet</span><time>6.2s</time></li></ul></div>
<div class="msg-agent"><p>月ごとのカード切り替えを、重複のない週の連続表示に変えます。曜日は上に固定し、月境界には「11月」のような小さな目印を置きます。左右ボタンをなくし、上下のスクロールで日付を追加する操作可能プレビューにします。</p></div>
${editCard(SAMPLE.files)}
${running ? `<div class="live"><span class="spinner"></span><span class="shimmer">変更前を同じ412px幅で確認</span></div>` : `<div class="msg-agent"><p>プレビューを確認しました。実装は <b>CalendarGrid.vue</b> と <b>useInfiniteWeeks.ts</b> に入っています。</p></div>`}`;
function editCard(files, { max = 3 } = {}) {
  const a = files.reduce((s, f) => s + f[2], 0), d = files.reduce((s, f) => s + f[3], 0);
  const row = (f, i) => `<div class="f"${i >= max ? ' hidden data-extra' : ''}><span class="grow"><span class="p">${f[0]}</span><span class="n">${f[1]}</span></span><span class="add num">+${f[2]}</span><span class="del num">−${f[3]}</span></div>`;
  return `<div class="edit-card"><div class="hd"><span class="ico">${ic('diff', 18)}</span><div class="grow ttl">${files.length} 件のファイルを編集<small><span class="add num">+${a}</span> <span class="del num">−${d}</span></small></div><button class="btn line">${ic('undo', 14)} 元に戻す</button><button class="btn line">変更内容を表示</button></div>
<div class="files">${files.map(row).join('')}</div>${files.length > max ? `<button class="more" data-more>あと ${files.length - max} 個のファイルを表示 ${ic('chev', 13)}</button>` : ''}</div>`;
}
document.addEventListener('click', (e) => { const m = e.target.closest('[data-more]'); if (m) { $$('[data-extra]', m.parentElement).forEach((x) => x.hidden = false); m.remove(); } });
document.addEventListener('click', (e) => { const b = e.target.closest('.tools > button'); if (b) b.parentElement.classList.toggle('open'); });
// Close any .menu when clicking outside.
document.addEventListener('click', (e) => { if (!e.target.closest('.menu, [data-menu]')) $$('.menu.open').forEach((m) => m.classList.remove('open')); });
function wireMenus(root = document) {
  $$('[data-menu]', root).forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation(); const m = document.getElementById(b.dataset.menu); const was = m.classList.contains('open');
    $$('.menu.open').forEach((x) => x.classList.remove('open')); if (!was) m.classList.add('open');
  }));
}
// Running timer for the "作業中" divider.
function tick(el, from = 444) { let s = from; const f = () => { el.textContent = `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; }; f(); return setInterval(() => { s++; f(); }, 1000); }

// Composer (Codex-style): + / permission / [spacer] / model / mic / send|stop. Menus open upward.
function composer({ running = true, placeholder = 'このセッションに指示を送る', id = 'c1', extra = '' } = {}) {
  return `<div class="cmp" id="${id}">${extra}<textarea rows="1" placeholder="${placeholder}"></textarea>
  <div class="bar"><button class="iconbtn" data-menu="${id}-plus" title="追加">${ic('plus', 18)}</button>
  <button class="pill warn" data-menu="${id}-perm">${ic('shield', 15)} ワークスペース内で実行 ${ic('chev', 11)}</button><span class="grow"></span>
  <button class="pill" data-menu="${id}-model">GPT-6.1 Sol <span class="dim">極高</span> ${ic('chev', 11)}</button><button class="iconbtn" title="音声入力">${ic('mic', 18)}</button>
  <button class="send${running ? ' stop' : ''}" title="${running ? '停止' : '送信'}" ${running ? '' : 'disabled'}>${running ? ic('stop', 14) : ic('send', 16)}</button></div>
  <div class="menu" id="${id}-plus" style="left:8px;bottom:54px"><button class="it">${ic('image', 16)} 画像を追加</button><button class="it">${ic('clip', 16)} ファイルを添付</button><button class="it">${ic('hash', 16)} スキル <small>$</small></button><button class="it">${ic('at', 16)} ファイルを参照 <small>@</small></button></div>
  <div class="menu" id="${id}-perm" style="left:48px;bottom:54px"><div class="sec">権限</div><button class="it on">${ic('shield', 16)} ワークスペース内で実行 ${ic('check', 14)}</button><button class="it">${ic('eye', 16)} 読み取り専用</button><button class="it">${ic('alert', 16)} フルアクセス <small>外部も変更</small></button></div>
  <div class="menu" id="${id}-model" style="right:44px;bottom:54px"><div class="sec">モデル</div><button class="it on">GPT-6.1 Sol ${ic('check', 14)}</button><button class="it">GPT-6.1 Mini</button><hr><div class="sec">推論の強さ</div><button class="it">標準</button><button class="it">高</button><button class="it on">極高 ${ic('check', 14)}</button></div></div>`;
}
function wireComposer(root = document, onSend) {
  const ta = $('textarea', root), send = $('.send', root);
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; if (!send.classList.contains('stop')) send.disabled = !ta.value.trim(); });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ta.value.trim()) { onSend?.(ta.value); ta.value = ''; ta.dispatchEvent(new Event('input')); } });
  send.addEventListener('click', () => { if (!send.classList.contains('stop') && ta.value.trim()) { onSend?.(ta.value); ta.value = ''; ta.dispatchEvent(new Event('input')); } });
  wireMenus(root);
}

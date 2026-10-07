// Thread detail (included into board.html's script; shares its scope).
//   · the folded conversation: tool calls collapse into one line, a turn ends with its working time,
//     the files the agent edited become one summary card (component style "会話の表示")
//   · the thread layout of a session card: the conversation and the input are the card; attributes and
//     the folder's changes live in a side panel (component style "カード詳細", "変更のレビュー")
// The module layout (renderPane's columns) is untouched; both read the same sections.

// ---- the folded conversation ----
const TOOL_KINDS = [
  ['edit', /^(Edit|Write|MultiEdit|NotebookEdit)$/, (n) => `ファイルを ${n} 件編集`],
  ['read', /^(Read|Grep|Glob|Image)$/, (n) => `ファイルを ${n} 件読み込み`],
  ['run', /^(Bash|Shell|BashOutput|KillShell)$/, (n) => `コマンドを ${n} 件実行`],
  ['web', /^(WebFetch|WebSearch)$/, (n) => `Web を ${n} 件参照`],
  ['agent', /^(Task|Agent)$/, (n) => `サブエージェントを ${n} 件起動`],
  ['plan', /^(TodoWrite|Plan)$/, () => '計画を更新'],
  ['mcp', /: /, (n) => `連携を ${n} 件使用`],
];
const toolKindOf = (name) => (TOOL_KINDS.find(([, re]) => re.test(name || '')) || ['other', null, (n) => `ツールを ${n} 件使用`]);
const TOOL_KIND_ICON = { edit: 'diff', read: 'file', run: 'terminal', web: 'search', agent: 'branch', plan: 'checklist', mcp: 'spark', other: 'gear' };
const folded = () => state.styles.conversation === 'folded';
function fmtElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000)), m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

// Tool and thinking items between two messages share one group; its summary counts them by kind.
function toolGroup() {
  const label = h('span', { class: 'tg-sum' });
  const head = h('button', { class: 'tg-head', type: 'button', 'aria-expanded': 'false' }, h('span', { class: 'tg-chev', html: picon('right', 13) }), label);
  const list = h('div', { class: 'tg-list' });
  const g = h('div', { class: 'tg' }, head, list);
  head.onclick = () => { const open = g.classList.toggle('open'); head.setAttribute('aria-expanded', String(open)); };
  g._label = label; g._list = list; g._kinds = new Map(); g._running = 0;
  return g;
}
function paintToolGroup(g) {
  const parts = [...g._kinds].map(([k, n]) => TOOL_KINDS.find(([id]) => id === k)?.[2]?.(n) ?? toolKindOf(k)[2](n));
  const running = $$('.fi-tool .ti:not(.ok):not(.error)', g._list).length;
  g._label.replaceChildren(...[h('span', { text: parts.join(' · ') || '考えています…' }), running ? h('span', { class: 'tg-run', title: '実行中' }) : null].filter(Boolean));
  g.classList.toggle('has-error', !!$('.fi-tool .ti.error', g._list));
}
// Put one item into the feed: folded mode groups tool calls and ends a turn with its working time.
function feedPush(f, it) {
  if (!folded()) { const el = feedItem(it, f); if (el) f.list.append(el); return el; }
  if (it.k === 'turn') { endTurn(f, it); return null; }
  if (it.k === 'user') f.turnStart = Date.parse(it.at) || Date.now();
  const el = feedItem(it, f);
  if (!el) return null;
  if (it.k === 'tool' || it.k === 'thinking') {
    let g = f.list.lastElementChild;
    if (g?.classList.contains('fi-edits')) g = g.previousElementSibling;
    if (!g?.classList.contains('tg')) { g = toolGroup(); f.edits ? f.list.insertBefore(g, f.edits.el) : f.list.append(g); }
    g._list.append(el);
    const kind = it.k === 'tool' ? toolKindOf(it.name)[0] : 'think';
    if (kind !== 'think') g._kinds.set(kind, (g._kinds.get(kind) || 0) + 1);
    paintToolGroup(g);
    return g;
  }
  f.edits ? f.list.insertBefore(el, f.edits.el) : f.list.append(el);
  return el;
}
function endTurn(f, it) {
  const at = Date.parse(it.at) || Date.now();
  const dur = f.turnStart ? at - f.turnStart : null;
  f.turnStart = null;
  const text = it.state === 'aborted' ? `中断しました${dur != null ? ` · ${fmtElapsed(dur)}` : ''}` : dur != null && dur > 1500 ? `${fmtElapsed(dur)} 作業しました` : null;
  if (!text) return;
  const div = h('div', { class: `work-div${it.state === 'aborted' ? ' aborted' : ''}`, text });
  // Above the last reply of the turn, like the agent apps; with no reply, at the end.
  let anchor = null;
  for (let el = f.list.lastElementChild; el; el = el.previousElementSibling) {
    if (el.classList.contains('fi-user')) break;
    if (el.classList.contains('fi-asst')) anchor = el;
    if (el.classList.contains('work-div')) { anchor = null; break; }
  }
  if (anchor) f.list.insertBefore(div, anchor); else f.edits ? f.list.insertBefore(div, f.edits.el) : f.list.append(div);
}
setInterval(() => {
  for (const f of live.feeds.values()) {
    const span = f.foot?.querySelector('.elapsed');
    if (span && f.turnStart) span.textContent = ` ${fmtElapsed(Date.now() - f.turnStart)}`;
  }
}, 1000);

// ---- the edit summary: "N 件のファイルを編集 +a −r" with the files of the current turn ----
async function loadChanges(p, { force = false } = {}) {
  if (p.changes?.loading) return p.changes.promise;
  if (!force && p.changes?.data && Date.now() - p.changes.at < 4000) return p.changes.data;
  const promise = bridge.callTool('canban_get_changes', { cardId: p.id }).then((r) => r.result || r).catch((e) => ({ available: false, reason: e.message }));
  p.changes = { loading: true, promise, data: p.changes?.data, at: p.changes?.at || 0 };
  const data = await promise;
  p.changes = { loading: false, data, at: Date.now() };
  return data;
}
const changeFor = (data, abs) => (data?.files || []).find((f) => abs === f.path || abs.endsWith(`/${f.path}`));
function editSummary(f) {
  const el = h('div', { class: 'fi-edits', hidden: true });
  const edits = { el, key: '', paint() {
    const files = f.signals?.files;
    el.hidden = !files;
    if (!files) { edits.key = ''; return; }
    const key = `${files.count}:${files.paths?.join('|')}:${f.status}`;
    if (key === edits.key) return;
    edits.key = key;
    draw(null);
    if (f.pane.d?.session?.host) return;
    loadChanges(f.pane, { force: true }).then((data) => { if (edits.key === key && data?.available) draw(data); });
  } };
  const draw = (data) => {
    const files = f.signals.files, paths = files.paths || files.names;
    const rows = paths.map((abs) => { const c = changeFor(data, abs); return { abs, name: abs.split('/').pop(), dir: abs.includes('/') ? abs.slice(0, abs.lastIndexOf('/') + 1).split('/').slice(-3).join('/') : '', c }; });
    const sum = rows.reduce((a, r) => ({ a: a.a + (r.c?.added || 0), d: a.d + (r.c?.removed || 0) }), { a: 0, d: 0 });
    const show = (n) => rows.slice(0, n).map((r) => h('div', { class: 'ef', title: r.abs },
      h('span', { class: 'grow ellipsis' }, h('span', { class: 'p', text: r.dir }), h('span', { class: 'n', text: r.name })),
      r.c ? h('span', { class: 'add num', text: `+${r.c.added}` }) : null, r.c ? h('span', { class: 'del num', text: `−${r.c.removed}` }) : null));
    const body = h('div', { class: 'ef-rows' }, ...show(3));
    const more = rows.length > 3 ? h('button', { class: 'ef-more', type: 'button', onclick: () => { body.replaceChildren(...show(rows.length)); more.remove(); } }, `あと ${rows.length - 3} 個のファイルを表示 `, h('span', { html: picon('chev', 12) })) : null;
    el.replaceChildren(
      h('div', { class: 'ef-head' }, h('span', { class: 'ef-ico', html: picon('diff', 18) }),
        h('div', { class: 'grow' }, h('div', { class: 'ef-title', text: `${files.count} 件のファイルを編集` }), data && (sum.a || sum.d) ? h('div', { class: 'ef-stat' }, h('span', { class: 'add num', text: `+${sum.a}` }), ' ', h('span', { class: 'del num', text: `−${sum.d}` })) : null),
        state.styles.review === 'on' && !f.pane.d?.session?.host ? h('button', { class: 'btn', type: 'button', text: '変更内容を表示', onclick: () => openThreadSide(f.pane, 'changes') }) : null),
      body, more);
  };
  f.edits = edits;
  return edits;
}

// ---- the thread layout ----
const SIDE_TABS = [['changes', '変更', 'diff', 'f'], ['details', '詳細', 'panel', 'd']];
function sideTabOf(p) { return p.sideTab === undefined ? store.get('threadSide', null) : p.sideTab; }
function openThreadSide(p, tab) {
  if (tab === 'changes' && state.styles.review !== 'on') tab = 'details';
  p.sideTab = tab || null;
  store.set('threadSide', p.sideTab);
  paintThreadSide(p);
}
function toggleThreadSide(p, tab) { openThreadSide(p, sideTabOf(p) === tab ? null : tab); }
function paintThreadSide(p) {
  const tab = sideTabOf(p), side = $('.th-side', p.el);
  if (!side) return;
  const shown = tab === 'changes' && state.styles.review !== 'on' ? 'details' : tab;
  p.el.classList.toggle('side-open', !!shown);
  side.hidden = !shown;
  side.dataset.tab = shown || '';
  for (const [id] of SIDE_TABS) { $$(`[data-side-tab="${id}"]`, p.el).forEach((b) => b.setAttribute('aria-pressed', String(shown === id))); }
  const body = $('.th-side-b', side);
  if (shown === 'changes') { body.replaceChildren(renderChangesPanel(p)); }
  else if (shown === 'details') { body.replaceChildren(...(p.detailNodes || [])); }
  else body.replaceChildren();
  refreshShortcutHints();
}
function paintThreadStat(p, git = p.d?.git) {
  const slot = $('.th-diffstat', p.el);
  if (!slot) return;
  slot.replaceChildren(...(git && (git.added || git.removed) ? [h('span', { class: 'add num', text: `+${git.added}` }), h('span', { class: 'del num', text: `−${git.removed}` })] : []));
}

function detailSection(id, title, nodes, { open = true, extra = null } = {}) {
  const det = h('details', { class: 'dsec', 'data-sec': id, open });
  det.append(h('summary', {}, h('span', { class: 'dsec-t', text: title }), extra), h('div', { class: 'dsec-b' }, ...nodes));
  return det;
}
function renderThreadPane(p, d, secs, { card, listSel }) {
  const el = p.el, s = d.session;
  const side = h('aside', { class: 'th-side', 'aria-label': '詳細パネル', hidden: true },
    h('div', { class: 'th-side-h' }, h('div', { class: 'seg', role: 'group', 'aria-label': '詳細パネル' },
      ...SIDE_TABS.filter(([id]) => id !== 'changes' || state.styles.review === 'on').map(([id, label, , key]) => h('button', { type: 'button', 'data-side-tab': id, 'aria-pressed': 'false', 'aria-keyshortcuts': key, onclick: () => toggleThreadSide(p, id) }, label, ' ', ...keycap(key)))),
      h('span', { class: 'grow' }), h('button', { class: 'icon-btn', type: 'button', title: '詳細パネルを閉じる', 'aria-label': '詳細パネルを閉じる', html: picon('close', 14), onclick: () => openThreadSide(p, null) })),
    h('div', { class: 'th-side-b' }));
  // The attributes: every section the module layout has, in one reading order.
  const order = [['progress', true], ['add', true], ['labels', true], ['prio', true], ['task', false], ['related', true], ['pr', true], ['memo', true], ['resume', true], ['detail', false], ['first', false], ['slack', true], ['other', false], ['actions', false]];
  p.detailNodes = order.filter(([id]) => secs[id]).map(([id, open]) => detailSection(id, secs[id].title ?? secTitle(id), secs[id].nodes, { open, extra: secs[id].extra }));
  const sig = s.signals, git = d.git;
  const chips = [
    dirPill(card.directory || { name: 'カテゴリ無し' }),
    git ? gitPill(git, s.branch) : s.branch ? h('span', { class: 'ellipsis', title: s.branch, text: `⎇ ${s.branch}` }) : null,
    d.pr ? prPill(d.pr) : null,
    ...card.labels.map((id) => state.board.labels.find((l) => l.id === id)).filter(Boolean).map((l) => h('span', { class: 'th-label', title: 'ラベル' }, h('i', { style: { background: colorVar(l.color) } }), l.name)),
    sig?.model ? h('span', { class: 'th-model', title: [sig.model, sig.effort ? `effort ${sig.effort}` : null, sig.mode ? (MODE_TEXT[sig.mode] || sig.mode) : null].filter(Boolean).join(' · '), text: [sig.model, sig.effort].filter(Boolean).join(' ') }) : null,
    sig?.ctx ? h('span', { class: ctxPct(sig.ctx) >= 90 ? 'sig-hot' : ctxPct(sig.ctx) >= 75 ? 'sig-warn' : '', title: ctxTitle(sig.ctx), text: `◔ ${ctxLabel(sig.ctx)}` }) : null,
    s.host ? h('span', { class: 'host-chip', text: s.host.label }) : null,
    acctChip({ account: s.account, home: s.home }),
    h('span', { class: 'th-time', title: fmtDate(s.updatedAt), text: relTime(s.updatedAt) }),
  ].filter(Boolean);
  const head = h('div', { class: 'th-head' }, secs.breadcrumb.nodes[0], h('span', { class: 'grow' }),
    state.styles.review === 'on' && !s.host ? h('button', { class: 'th-tool', type: 'button', 'data-side-tab': 'changes', title: '変更を見る（f）', 'aria-pressed': 'false', onclick: () => toggleThreadSide(p, 'changes') }, h('span', { html: picon('diff', 15) }), h('span', { class: 'th-diffstat' })) : null,
    h('button', { class: 'th-tool', type: 'button', 'data-side-tab': 'details', title: '詳細パネル（d）', 'aria-pressed': 'false', onclick: () => toggleThreadSide(p, 'details') }, h('span', { html: picon('panel', 15) })),
    h('span', { class: 'ph-btns card-actions' }));
  const title = h('div', { class: 'th-title' }, secs.status.nodes[0], secs.title.nodes[0]);
  const main = h('div', { class: 'th-main' },
    h('div', { class: 'th-conv', 'data-sec': 'conv' }, ...secs.conv.nodes),
    h('div', { class: 'th-dock', 'data-sec': 'send' }, ...secs.send.nodes));
  el.replaceChildren(head, threadStrip(p, d), title, h('div', { class: 'th-meta' }, ...chips), h('div', { class: 'th-body' }, main, side), ...paneSizeHandles('session'));
  paintThreadStat(p, git);
  paintThreadSide(p);
}

// ---- the changes panel: files with +/−, and one file's diff on demand ----
function renderPatch(patch) {
  const box = h('div', { class: 'dl' });
  let a = 0, b = 0;
  for (const line of String(patch).split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) { a = +hunk[1]; b = +hunk[2]; box.append(h('div', { class: 'h' }, h('span', { class: 'ln' }), h('span', { class: 'ln' }), h('span', { class: 't', text: line }))); continue; }
    if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|\\ No newline)/.test(line)) continue;
    if (!b && !a) continue;
    const k = line[0];
    if (k === '+') box.append(h('div', { class: 'a' }, h('span', { class: 'ln' }), h('span', { class: 'ln', text: b++ }), h('span', { class: 't', text: line.slice(1) })));
    else if (k === '-') box.append(h('div', { class: 'd' }, h('span', { class: 'ln', text: a++ }), h('span', { class: 'ln' }), h('span', { class: 't', text: line.slice(1) })));
    else if (line !== '') box.append(h('div', { class: 'c' }, h('span', { class: 'ln', text: a++ }), h('span', { class: 'ln', text: b++ }), h('span', { class: 't', text: line.slice(1) })));
  }
  if (!box.childElementCount) box.append(h('div', { class: 'muted', style: { padding: '8px 12px' }, text: '差分はありません（バイナリまたは空のファイル）' }));
  return box;
}
const CHANGE_STATUS = { modified: '変更', added: '追加', deleted: '削除', renamed: '名前変更', untracked: '未追跡', conflict: '競合' };
function renderChangesPanel(p) {
  const box = h('div', { class: 'chg' });
  const refresh = h('button', { class: 'icon-btn', type: 'button', title: '変更を読み直す', 'aria-label': '変更を読み直す', html: picon('refresh', 14), onclick: () => draw(true) });
  const head = h('div', { class: 'chg-h' }, h('span', { class: 'chg-t', text: '変更' }), h('span', { class: 'chg-s' }), h('span', { class: 'grow' }), refresh);
  const list = h('div', { class: 'chg-list' });
  box.append(head, list);
  async function draw(force) {
    list.replaceChildren(h('div', { class: 'muted pane-pad', text: '読み込み中…' }));
    const data = await loadChanges(p, { force });
    if (!box.isConnected && !force) return;
    $('.chg-s', head).replaceChildren(...(data?.available ? [h('span', { class: 'add num', text: `+${data.added}` }), ' ', h('span', { class: 'del num', text: `−${data.removed}` }), h('span', { class: 'muted', text: ` · ${data.files.length} ファイル` })] : []));
    if (!data?.available) return list.replaceChildren(h('div', { class: 'muted pane-pad', text: data?.reason || '変更を読み取れませんでした' }));
    if (!data.files.length) return list.replaceChildren(h('div', { class: 'muted pane-pad', text: 'コミットしていない変更はありません' }));
    list.replaceChildren(...data.files.map((f) => {
      const body = h('div', { class: 'chg-body' });
      const item = h('section', { class: 'chg-file closed' }, h('button', { class: 'chg-fh', type: 'button', 'aria-expanded': 'false', title: f.path }, h('span', { class: 'tg-chev', html: picon('chev', 13) }),
        h('span', { class: 'grow ellipsis' }, h('span', { class: 'p', text: f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '' }), h('span', { class: 'n', text: f.path.split('/').pop() })),
        f.status !== 'modified' ? h('span', { class: 'chg-st', text: CHANGE_STATUS[f.status] || f.status }) : null,
        h('span', { class: 'add num', text: `+${f.added}` }), h('span', { class: 'del num', text: `−${f.removed}` })), body);
      let loaded = false;
      $('.chg-fh', item).onclick = async (e) => {
        const open = item.classList.toggle('closed') === false;
        e.currentTarget.setAttribute('aria-expanded', String(open));
        if (!open || loaded) return;
        loaded = true;
        body.replaceChildren(h('div', { class: 'muted pane-pad', text: '読み込み中…' }));
        try {
          const r = (await bridge.callTool('canban_get_changes', { cardId: p.id, path: f.path })).result;
          body.replaceChildren(renderPatch(r.diff.patch), ...(r.diff.truncated ? [h('div', { class: 'muted pane-pad', text: '長いため途中までを表示しています' })] : []));
        } catch (err) { loaded = false; body.replaceChildren(h('div', { class: 'muted pane-pad', text: err.message })); }
      };
      return item;
    }));
    if (data.files.length === 1) $('.chg-fh', list).click();
  }
  draw(false);
  return box;
}

// ---- threads of a task: the task beside one session, the others a click away ----
const taskThreadsSaved = () => store.get('taskThreads', null) || {};
function taskThreadChoice(taskId, links) {
  const real = links.filter((l) => !l.subagent);
  const saved = taskThreadsSaved()[taskId];
  return real.some((l) => l.id === saved) ? saved : [...real].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0]?.id || null;
}
async function selectTaskThread(taskId, id) {
  store.set('taskThreads', { ...taskThreadsSaved(), [taskId]: id });
  if (panes[0]?.id !== taskId) return openCard(id);
  showCards([taskId, id]);
  const p = panes[1];
  if (p) { await loadSession(p); revealPane(id); }
}
// The strip above a session that sits beside its task: every session of the task, and a new one.
function threadStrip(p, d) {
  const task = d.task && panes[0]?.kind === 'task' && panes[0].id === d.task.id && styleIs('taskDetail', 'threads') ? findCard(d.task.id)?.card : null;
  if (!task) return null;
  const links = task.links.filter((l) => !l.subagent);
  return h('div', { class: 'th-threads', role: 'tablist', 'aria-label': `${T.taskCard}のスレッド` },
    ...links.map((l) => h('button', { class: 'th-thread', type: 'button', role: 'tab', 'aria-selected': String(l.id === p.id), title: l.title, onclick: () => l.id !== p.id && selectTaskThread(task.id, l.id) },
      faceGlyph(l.status), faceWho(l.agent), h('span', { class: 'ellipsis', text: l.title }))),
    h('button', { class: 'th-thread th-new', type: 'button', title: 'このタスクで新しいセッションを始める', onclick: () => { revealPane(task.id); requestAnimationFrame(() => panes[0]?.el.querySelector('[data-sec="send"] textarea')?.focus()); } }, h('span', { html: picon('plus', 13) }), '新しいスレッド'));
}

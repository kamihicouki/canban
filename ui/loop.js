// Shared task component and layer-2 orbit sheet. All editable text stays local until submitted.
const loopDrafts = store.get('loopDrafts', {});
function loopInput(key, tag, attrs, value = '') {
  const el = h(tag, attrs); el.value = el.defaultValue = loopDrafts[key] ?? value;
  el.addEventListener('input', () => { loopDrafts[key] = el.value; store.cache('loopDrafts', loopDrafts); });
  return el;
}
function loopClearDraft(prefix) {
  for (const key of Object.keys(loopDrafts)) if (key.startsWith(prefix)) delete loopDrafts[key];
  store.cache('loopDrafts', loopDrafts);
}
const loopLabel = (label, input) => h('label', { class: 'loop-field' }, h('span', { text: label }), input);
function loopButton(text, run, cls = '') { return h('button', { type: 'button', class: `btn ${cls}`, text, onclick: run }); }
function loopSvg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  el.append(...kids); return el;
}
function loopDiagram(c, children = [], selectChild = () => {}) {
  const last = c.rounds.at(-1), m = last?.version === c.version ? loopMeasure(c, last) : null;
  const known = !!m && !!last?.results && !c.stale && !c.dependenciesChanged;
  const svg = loopSvg('svg', { viewBox: '0 0 420 420', 'aria-hidden': 'true', class: 'loop-svg' });
  [48, 106, 164].forEach(r => svg.append(loopSvg('circle', { cx: 210, cy: 210, r, class: 'loop-grid' })));
  svg.append(loopSvg('line', { x1: 28, y1: 210, x2: 392, y2: 210, class: 'loop-grid' }), loopSvg('line', { x1: 210, y1: 28, x2: 210, y2: 392, class: 'loop-grid' }));
  for (const trail of loopTrail(c)) {
    svg.append(loopSvg('path', { d: trail.path, class: 'loop-history-line' }), loopSvg('circle', { cx: trail.point[0], cy: trail.point[1], r: 5, class: 'loop-history-dot' }));
  }
  const radius = loopRadius(known ? m.value : null);
  svg.append(loopSvg('circle', { cx: 210, cy: 210, r: radius, class: `loop-current ${known ? '' : 'loop-unknown'}` }));
  if (known && m.unknown) {
    const unknown = m.unknown / m.total * Math.PI * 2;
    const points = Array.from({ length: 33 }, (_, i) => loopPoint(radius, -Math.PI / 2 + unknown * i / 32));
    svg.append(loopSvg('path', { d: points.map((p, i) => `${i ? 'L' : 'M'}${p.join(' ')}`).join(' '), class: 'loop-unknown-arc' }));
  }
  const angle = { plan: -Math.PI / 2, act: 0, adjust: Math.PI, done: -Math.PI / 2 }[c.phase] ?? Math.PI / 2;
  const point = loopPoint(radius, angle);
  svg.append(loopSvg('circle', { cx: point[0], cy: point[1], r: 9, class: `loop-node loop-${c.status}` }));
  const box = h('figure', { class: 'loop-diagram', 'aria-label': `${c.goal}、基準 v${c.version}、${known ? `${m.passed}/${m.total}条件を確認、未知${m.unknown}件` : '現在の進みは未確認'}` }, svg,
    h('div', { class: 'loop-core' }, h('span', { class: 'loop-eyebrow', text: '目標' }), h('strong', { text: c.goal })),
    ...[['plan','目標', 'loop-north'], ['act','実行','loop-east'], ['observe','検証','loop-south'], ['adjust','調整','loop-west']].map(([phase, label, cls]) => h('span', { class: `loop-phase ${cls}${c.phase === phase ? ' is-current' : ''}`, text: label })),
    ...children.map((child, i) => {
      const a = -Math.PI / 4 + i / Math.max(children.length, 1) * Math.PI * 2;
      return h('button', { type: 'button', class: `loop-satellite loop-${child.status}`, style: { left: `${50 + Math.cos(a) * 42}%`, top: `${50 + Math.sin(a) * 42}%` },
        title: `小さなループ: ${child.goal}`, 'aria-label': `小さなループ ${child.goal}`, text: String(i + 1), onclick: () => selectChild(child.id) });
    }), h('figcaption', { class: 'loop-caption', text: '半径 = 未達と未知の条件。線 = 確認済みの周回。同じ基準の中で描きます。' }));
  return box;
}
function loopDraftText(taskId, c) {
  const last = c.rounds.at(-1);
  const observed = c.rounds.filter(r => r.version === c.version && r.results).at(-1);
  return [`目標: ${c.goal}`, `守る原則（全文はタスクのループ参照）: ${c.principles?.slice(0, 1600) || '既存のプロジェクトの指示と権限を守る'}`, `条件（v${c.version}）:\n${c.criteria.map(x => `${x.id}: ${x.text}`).join('\n')}`, `今回の調整（全文はタスクのループ参照）: ${c.nextAction.slice(0, 2000)}`,
    last?.results ? last.results.map(x => `${x.criterionId}: ${x.pass === null ? '未観測' : x.pass ? '合格の報告' : '未達'} — ${x.summary} (${x.ref})`).join('\n') : '',
    observed ? `直近の観測:\n${observed.results.map(x => `${x.criterionId}: ${x.pass === null ? '未観測' : x.pass ? '合格' : '未達'} — ${x.summary.slice(0, 80)} (${x.ref.slice(0, 60) || '根拠なし'})`).join('\n')}` : '',
    `作業後、canban_get_loop(taskId=${taskId})で最新revisionを取得し、canban_loop_commandのrecordでcycleId=${c.id}, roundId=${last?.id}, version=${c.version}と検証した成果物の版artifactRef、各条件のcriterionId/pass/summary/ref、学びlearningを報告してください。実施していない検証を合格にせず、通常終了を完了の根拠にしないでください。`].filter(Boolean).join('\n\n');
}
function loopComponent(card, { selectedId = null, compact = false } = {}) {
  const box = h('section', { class: `loop-component${compact ? ' loop-compact' : ''}`, tabindex: -1, 'data-sec': 'loop', 'aria-label': '改善ループ' });
  let record, selected = selectedId, generation = 0;
  async function command(command, prefix = '') {
    try {
      box.setAttribute('aria-busy', 'true');
      const result = await bridge.callTool('canban_review_loop', { taskId: card.id, expectedRevision: record.revision, commandId: crypto.randomUUID(), command });
      if (result.conflict) { toast('別の画面で更新されています。下書きを残して最新の条件を読み直します', true); await draw(); return; }
      if (prefix) loopClearDraft(prefix);
      selected = result.cycleId || selected; await draw();
      load();
    } catch (e) { toast(e.message, true); } finally { box.setAttribute('aria-busy', 'false'); }
  }
  function configureForm(c = null) {
    const prefix = `${card.id}:${c?.id || 'new'}:configure:`;
    const goal = loopInput(prefix + 'goal', 'input', { required: true, maxlength: 500, placeholder: 'どうなったら、この仕事は終わり？' }, c?.goal || card.title);
    const criteria = loopInput(prefix + 'criteria', 'textarea', { required: true, rows: 3, placeholder: '1行に1条件。例: 認証のテストがすべて通る' }, c?.criteria.map(x => x.text).join('\n') || '');
    const principles = loopInput(prefix + 'principles', 'textarea', { rows: 2, maxlength: 4000, placeholder: '例: テストを消して通さない' }, c?.principles || '');
    const max = loopInput(prefix + 'max', 'input', { type: 'number', min: 1, max: 20, required: true }, String(c?.maxRounds || 5));
    const parent = loopInput(prefix + 'parent', 'select', {}, '');
    parent.append(h('option', { value: '', text: '大きなループ' }), ...record.cycles.filter(x => !x.parentId && x.status !== 'completed').map(x => h('option', { value: x.id, text: `小さな修正: ${x.goal}` })));
    parent.value = loopDrafts[prefix + 'parent'] || '';
    const form = h('form', { class: 'loop-form', onsubmit: e => {
      e.preventDefault(); command({ type: 'configure', ...(c ? { cycleId: c.id } : { parentId: parent.value || null }), goal: goal.value, criteria: criteria.value.split('\n').map(x => x.trim()).filter(Boolean), principles: principles.value, maxRounds: Number(max.value) }, prefix);
    } }, loopLabel('目標', goal), loopLabel('完了の条件（1行に1つ）', criteria), !c ? loopLabel('周期の大きさ', parent) : null,
      loopLabel('守る原則', principles), loopLabel('上限の周回数', max), h('button', { type: 'submit', class: 'btn-primary', text: c ? '新しい基準として保存' : 'ループを作る' }));
    return h('details', { open: !record.cycles.length }, h('summary', { text: c ? '基準と進め方を見直す（履歴を残す）' : '目標からループを作る' }), form);
  }
  function cycleBody(c) {
    const last = c.rounds.filter(r => r.version === c.version).at(-1), m = last && !c.stale && !c.dependenciesChanged ? loopMeasure(c, last) : null;
    const active = last && !last.closedAt;
    const head = h('div', { class: 'loop-heading' }, h('h3', { text: c.goal }), h('span', { class: 'pill', text: LOOP_STATUS[c.status] }), keycap('Shift+L'));
    const meter = h('div', { class: 'loop-metric' }, h('span', { class: 'muted', text: `基準 v${c.version}` }), h('strong', { text: `${c.rounds.filter(r => r.version === c.version).length}/${c.maxRounds} 周` }),
      m && !active ? h('progress', { max: m.total, value: m.passed, 'aria-label': '確認済みの完了条件' }) : h('span', { class: 'muted', text: '進みは未確認' }),
      m && !active ? h('span', { text: `${m.passed}/${m.total} 条件を確認 · 未知 ${m.unknown}` }) : null);
    const summary = h('div', { class: 'loop-cycle-summary' }, head, meter,
      h('ul', { class: 'loop-criteria' }, ...c.criteria.map(x => h('li', { text: x.text }))),
      c.principles ? h('p', { class: 'loop-principles', text: `守る原則: ${c.principles}` }) : null,
      c.reason ? h('p', { class: 'loop-reason', role: 'status', text: c.reason }) : null);
    const content = h('div', { class: 'loop-cycle' }, h('div', { class: 'loop-cycle-overview' },
      loopDiagram(c, record.cycles.filter(x => x.parentId === c.id), id => { selected = id; draw(); }), summary));
    if (c.stale) content.prepend(h('p', { class: 'loop-reason', role: 'status', text: '観測後に成果物が変わりました。以前の合格は履歴として残し、現在の進みは未確認とします。' }));
    if (c.dependenciesChanged) content.prepend(h('p', { class: 'loop-reason', role: 'status', text: '小さなループが変わりました。子の完了後に親の条件を再検証してください。' }));
    if (last && !c.currentArtifactRef) content.append(h('p', { class: 'loop-reason', text: '成果物の版を自動照合できません。手入力の版と根拠を確認して記録します。観測後の変更は自動検出できません。' }));
    if (c.status === 'completed') content.append(loopButton('新しい変更を再検証する', () => command({ type: 'reopen', cycleId: c.id })));
    if (['ready', 'review'].includes(c.status) && !active && c.rounds.filter(r => r.version === c.version).length < c.maxRounds) {
      const prefix = `${card.id}:${c.id}:start:`;
      const next = loopInput(prefix + 'next', 'textarea', { rows: 2, required: true, placeholder: '今回の観測から、次に何を変える？' }, c.nextAction || c.goal);
      content.append(h('form', { class: 'loop-form', onsubmit: e => { e.preventDefault(); command({ type: 'start', cycleId: c.id, nextAction: next.value }, prefix); } },
        loopLabel('次の調整', next), h('button', { type: 'submit', class: 'btn-primary', text: 'この調整で1周を始める' })));
    }
    if (c.status === 'active') content.append(loopButton('一時停止', () => command({ type: 'pause', cycleId: c.id })));
    if (c.status === 'paused' && active) content.append(loopButton('この周回を再開', () => command({ type: 'resume', cycleId: c.id })));
    if (active && c.status === 'active') {
      const prefix = `${card.id}:${c.id}:${last.id}:send:`;
      const session = h('select', { required: true, 'aria-label': 'この周回を担当するセッション' }, h('option', { value: '', text: '紐付いたセッションを選ぶ' }), ...card.links.filter(x => !x.subagent).map(x => h('option', { value: x.id, text: x.title })));
      const prompt = loopInput(prefix + 'prompt', 'textarea', { rows: 5, required: true }, loopDraftText(card.id, c));
      const send = h('button', { type: 'submit', class: 'btn-primary', text: 'この周回の指示を送る' });
      const sendStatus = h('p', { class: 'muted', role: 'status' });
      const sendForm = h('form', { class: 'loop-form', onsubmit: async e => {
        e.preventDefault(); send.disabled = true;
        try { const r = await bridge.callTool('canban_send_loop', { taskId: card.id, cycleId: c.id, roundId: last.id, expectedRevision: record.revision, cardId: session.value, prompt: prompt.value });
          sendStatus.textContent = `依頼 ${r.id} · ${r.state}。結果は担当セッションの依頼一覧で確認できます。`; loopClearDraft(prefix);
        } catch (e) { sendStatus.textContent = e.message; send.disabled = false; }
      } }, loopLabel('担当するセッション', session), loopLabel('観測を返す指示の下書き', prompt), send, sendStatus);
      content.append(h('details', {}, h('summary', { text: 'エージェントへ1ターン依頼する' }), sendForm));
      const rp = `${card.id}:${c.id}:${last.id}:record:`;
      const artifact = loopInput(rp + 'artifact', 'input', { required: true, maxlength: 500, placeholder: '例: git HEAD のSHA / 成果物 v3' }, c.currentArtifactRef || '');
      const results = c.criteria.map(x => {
        const pass = loopInput(rp + x.id + ':pass', 'select', { 'aria-label': `${x.text}の結果` }, 'unknown');
        pass.append(h('option', { value: 'unknown', text: '未観測' }), h('option', { value: 'pass', text: '根拠を確認して合格' }), h('option', { value: 'fail', text: '未達' }));
        pass.value = loopDrafts[rp + x.id + ':pass'] || 'unknown';
        const summary = loopInput(rp + x.id + ':summary', 'input', { required: true, placeholder: '観測したこと（未観測なら理由）' });
        const ref = loopInput(rp + x.id + ':ref', 'input', { placeholder: 'コマンド・結果・ログ / 確認者と時刻' });
        return { criterionId: x.id, pass, summary, ref, node: h('fieldset', {}, h('legend', { text: x.text }), pass, loopLabel('観測', summary), loopLabel('根拠', ref)) };
      });
      const learning = loopInput(rp + 'learning', 'textarea', { rows: 2, placeholder: '次の周回で活かすこと' });
      content.append(h('details', { open: true }, h('summary', { text: '検証した根拠を記録する' }),
        h('form', { class: 'loop-form', onsubmit: e => { e.preventDefault(); command({ type: 'record', cycleId: c.id, roundId: last.id, version: c.version, artifactRef: artifact.value,
          results: results.map(x => ({ criterionId: x.criterionId, pass: x.pass.value === 'unknown' ? null : x.pass.value === 'pass', summary: x.summary.value, ref: x.ref.value })), learning: learning.value }, rp); } },
        loopLabel('検証した成果物の版', artifact), ...results.map(x => x.node), loopLabel('学び', learning), h('p', { class: 'muted', text: '現在の成果物に対して根拠を確認してから保存してください。CLIの通常終了だけでは合格になりません。' }), h('button', { type: 'submit', class: 'btn-primary', text: '確認した観測を保存' }))));
    }
    if (last?.results && !loopVerified(c, last)) {
      const artifact = loopInput(`${card.id}:${c.id}:confirm:artifact`, 'input', { required: true, placeholder: '現在の成果物の版を入力して照合' }, c.currentArtifactRef || '');
      content.append(h('form', { class: 'loop-form', onsubmit: e => { e.preventDefault(); command({ type: 'confirm', cycleId: c.id, roundId: last.id, artifactRef: artifact.value }, `${card.id}:${c.id}:confirm:`); } },
        loopLabel('報告の根拠と現在の成果物を確認', artifact), h('button', { type: 'submit', class: 'btn', text: 'この報告を確認済みにする' })));
    }
    content.append(h('details', { open: !!c.rounds.length }, h('summary', { text: `周回と学びの履歴（${c.rounds.length}）` }),
      ...[...c.rounds].reverse().map(r => h('article', { class: 'loop-round' }, h('strong', { text: `基準 v${r.version} · ${r.number}周目 · ${r.superseded ? '基準を変更' : !r.results ? '検証待ち' : loopVerified(c, r) ? '確認済み' : 'エージェント報告'}` }),
        h('p', { text: r.action }), r.artifactRef ? h('code', { text: r.artifactRef }) : null,
        ...(r.results || []).map(x => h('p', { class: 'loop-evidence', text: `${x.pass === null ? '未観測' : x.pass ? '合格' : '未達'} · ${r.criteria.find(k => k.id === x.criterionId)?.text}: ${x.summary}${x.ref ? ` / 根拠: ${x.ref}` : ''}` })),
        r.learning ? h('p', { class: 'loop-learning', text: `学び: ${r.learning}` }) : null))), configureForm(c));
    return content;
  }
  async function draw() {
    const seq = ++generation;
    try {
      record = await bridge.callTool('canban_get_loop', { taskId: card.id });
      if (seq !== generation) return;
      const c = record.cycles.find(x => x.id === selected) || record.cycles.find(x => !x.parentId) || record.cycles[0];
      selected = c?.id;
      const select = h('select', { 'aria-label': '見るループ', onchange: e => { selected = e.target.value; draw(); } }, ...record.cycles.map(x => h('option', { value: x.id, text: `${x.parentId ? '小さな修正 · ' : ''}${x.goal}` })));
      select.value = selected || '';
      box.replaceChildren(h('div', { class: 'loop-heading' }, h('strong', { text: '改善ループ' }), keycap('Shift+L'), record.cycles.length > 1 ? select : null),
        c ? cycleBody(c) : h('p', { class: 'muted', text: '完了の条件を書き、実行 → 検証 → 調整を1周ずつ残します。' }), configureForm());
      workspace.trackDrafts(box);
    } catch (e) { box.replaceChildren(h('p', { class: 'muted', text: e.message }), loopButton('読み直す', draw)); }
  }
  box.loopReady = draw(); return box;
}
function loadOrbit(p) {
  const body = $('.sheet-b', p.el);
  if (workspace.hasDrafts(body)) return;
  const cards = [...new Map((state.board?.lists || []).flatMap(l => l.cards).filter(c => c.kind === 'task').map(c => [c.id, c])).values()];
  const selected = cards.find(c => c.id === p.loopTaskId) || cards.find(c => c.loop?.cycles.length) || cards[0];
  p.loopTaskId = selected?.id;
  const list = h('nav', { class: 'loop-task-list', 'aria-label': '軌道に表示するタスク' }, ...cards.map(c => {
    const roots = c.loop?.cycles.filter(x => !x.parentId) || [];
    return h('button', { class: 'loop-task', type: 'button', 'aria-pressed': c.id === selected?.id ? 'true' : 'false', onclick: () => { p.loopTaskId = c.id; loadOrbit(p); } },
      h('span', { class: 'loop-mini', 'aria-hidden': 'true' }), h('strong', { text: c.title }), h('span', { class: 'muted', text: roots.length ? `${roots.length} 大きな周期 · ${c.loop.cycles.length - roots.length} 小さな修正` : '完了の条件から始める' }));
  }));
  body.replaceChildren(h('div', { class: 'loop-intro' }, h('h2', { text: '大きな流れの中で、小さく確かめる。' }), h('p', { text: '中心は目標。確かめた条件が増えると輪が縮み、過去の周回は知見として残ります。' }), keycap('Shift+O')),
    cards.length ? h('div', { class: 'loop-orbit-layout' }, list, h('div', {},
      loopButton('タスクカードを開く', () => openCard(selected.id)), loopComponent(selected))) : h('div', { class: 'loop-empty' }, h('p', { text: 'タスクカードを作り、完了の条件を1行書くところから始めます。' }), loopButton('タスクを作る', quickAdd)));
}
function focusTaskLoop() {
  const p = focusedPane();
  if (p?.kind === 'view' && openViewKind() === 'orbit') {
    const el = $('[data-sec="loop"]', p.el); el?.scrollIntoView({ block: 'nearest' }); el?.focus(); return;
  }
  const id = p?.kind === 'task' ? p.id : document.activeElement?.closest?.('.card')?.dataset.cardId;
  if (!id?.startsWith('task:')) return toast('タスクカードを選んでください');
  openCard(id).then(async () => {
    const el = $('[data-sec="loop"]', panes[0]?.el);
    await el?.loopReady;
    if (!el?.isConnected) return;
    el.scrollIntoView({ block: 'start' }); el.focus({ preventScroll: true });
  });
}

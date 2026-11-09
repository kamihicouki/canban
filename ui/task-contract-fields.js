// Goal-contract fields of the task creation dialog (layer 3). Part of board.html: shares its scope.
// Typing repaints warnings and readiness in place; structural changes (level, rows, check kind) remount the dialog.
function taskContractFields(contract, { title, field, remount, onLevel }) {
  const level = contract.level;
  const choices = h('fieldset', { class: 'contract-levels' }, h('legend', { class: 'creation-label', text: '任せる度合い' }),
    h('div', { class: 'contract-level-choices' }, CONTRACT_LEVELS.map(l => {
      const radio = h('input', { type: 'radio', name: 'contract-level', value: String(l.level), checked: l.level === level,
        onchange: () => { contract.level = l.level; onLevel(l.level); remount('input[name="contract-level"]:checked'); } });
      return h('label', { class: 'session-choice' }, radio, h('span', {}, h('strong', { text: `L${l.level} ${l.label}` }), h('span', { text: l.detail })));
    })));
  const root = h('div', { class: 'contract-fields' }, choices);
  if (level === 0) return { root, paint: () => null };

  const isEnter = e => e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && !e.metaKey && !e.ctrlKey;
  const goal = h('input', { class: 'text-input contract-goal', maxlength: 500, 'aria-label': '目標', value: contract.goal,
    oninput: e => { contract.goal = e.target.value; paint(); },
    onkeydown: e => { if (isEnter(e)) { e.preventDefault(); root.querySelector('[data-criterion="0"]')?.focus(); } } });
  root.append(field('目標（なぜ・何を）', goal));

  const warnings = [];
  const rows = h('div', { class: 'contract-criteria' });
  const addRow = (after) => {
    if (contract.criteria.length >= CONTRACT_MAX_CRITERIA) return;
    contract.criteria.splice(after + 1, 0, contractEmptyRow());
    remount(`[data-criterion="${after + 1}"]`);
  };
  contract.criteria.forEach((row, i) => {
    const text = h('input', { class: 'text-input', maxlength: 500, 'data-criterion': i, 'aria-label': `完了の条件 ${i + 1}`, value: row.text,
      placeholder: i === 0 ? '例：`npm test` が 0 で終わる' : '', oninput: e => { row.text = e.target.value; paint(); },
      onkeydown: e => { if (isEnter(e)) { e.preventDefault(); addRow(i); } } });
    // Enter on a closed select would otherwise submit the whole form.
    const kind = h('select', { 'data-verify-kind': i, 'aria-label': `条件${i + 1}の確かめ方`, onchange: e => { row.kind = e.target.value; remount(`[data-verify-kind="${i}"]`); },
      onkeydown: e => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) e.preventDefault(); } },
      [['', '確かめ方を選ぶ'], ...Object.entries(VERIFY_KINDS)].map(([value, label]) => h('option', { value, text: label })));
    kind.value = row.kind;
    const value = row.kind ? h('input', { class: 'text-input', maxlength: 500, 'data-verify-value': i, 'aria-label': `条件${i + 1}の確かめ方の内容`, value: row.value,
      placeholder: VERIFY_PLACEHOLDERS[row.kind], oninput: e => { row.value = e.target.value; paint(); },
      onkeydown: e => { if (isEnter(e)) { e.preventDefault(); addRow(i); } } }) : null;
    const remove = contract.criteria.length > 1 ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': `条件${i + 1}を削除`, text: '✕',
      onclick: () => { contract.criteria.splice(i, 1); remount(`[data-criterion="${Math.max(0, i - 1)}"]`); } }) : null;
    const warning = h('p', { class: 'contract-warning', role: 'note', hidden: true });
    warnings.push(warning);
    rows.append(h('div', { class: 'contract-criterion' }, text, kind, remove, value, warning));
  });
  rows.append(h('button', { type: 'button', class: 'link-btn contract-add', text: '＋ 条件を追加', disabled: contract.criteria.length >= CONTRACT_MAX_CRITERIA, onclick: () => addRow(contract.criteria.length - 1) }));
  root.append(h('div', { class: 'creation-field' }, h('span', { class: 'creation-label', text: level >= 2 ? '完了の条件と確かめ方' : '完了の条件（任意）' }), rows));

  const number = (label, cls, min, max, current, set) => field(label, h('input', { type: 'number', class: `text-input ${cls}`, min, max, 'aria-label': label,
    value: current ?? '', oninput: e => { set(e.target.value === '' ? null : Number(e.target.value)); paint(); } }));
  const principles = h('textarea', { class: 'note contract-principles', rows: 3, maxlength: 4000, 'aria-label': '範囲・触らないもの',
    placeholder: '触らない: …\n守る: …', oninput: e => { contract.principles = e.target.value; paint(); } });
  principles.value = contract.principles;
  const summary = h('summary');
  const gateBoxes = Object.entries(CONTRACT_GATES).map(([key, label]) => h('label', {},
    h('input', { type: 'checkbox', checked: contract.gates.includes(key), onchange: e => {
      contract.gates = e.target.checked ? [...contract.gates, key] : contract.gates.filter(g => g !== key); paint(); } }), label));
  const gateText = h('input', { class: 'text-input', maxlength: 200, 'aria-label': 'ほかに止まる場面', placeholder: '例：DB変更の前', value: contract.gateText,
    oninput: e => { contract.gateText = e.target.value; paint(); } });
  root.append(h('details', { class: 'creation-details', open: level >= 2 || contract.budgetOpen, ontoggle: e => { contract.budgetOpen = e.target.open; } }, summary,
    field('範囲・触らないもの', principles),
    h('div', { class: 'task-attributes' },
      number('周回の上限', 'contract-max-rounds', 1, 20, contract.maxRounds, v => { contract.maxRounds = v; }),
      number('時間の上限（分・任意）', 'contract-time-limit', 5, 1440, contract.timeLimitMin, v => { contract.timeLimitMin = v; })),
    h('fieldset', { class: 'contract-gates' }, h('legend', { class: 'creation-label', text: '人が確認するために止まる場面' }), h('div', { class: 'contract-gate-boxes' }, gateBoxes), gateText),
    h('p', { class: 'creation-route-note', text: '確かめ方はエージェントへの指示に載せます。Canban がコマンドを実行して検証するわけではありません。' })));

  const readiness = h('p', { class: 'contract-readiness', 'aria-live': 'polite' });
  root.append(readiness);

  function paint() {
    goal.placeholder = title() || 'なぜ・何を（空ならタイトルを使います）';
    contract.criteria.forEach((row, i) => {
      const w = criterionWarning(row.text, row.kind && row.value.trim() ? { kind: row.kind, value: row.value } : null);
      warnings[i].hidden = !w;
      warnings[i].textContent = w ? `${w.message}例: ${w.example}` : '';
    });
    summary.textContent = contractBudgetSummary(contract);
    const r = contractDraftReadiness(contract, title());
    readiness.textContent = r.text;
    readiness.classList.toggle('short', !r.ready);
    return r;
  }
  return { root, paint };
}

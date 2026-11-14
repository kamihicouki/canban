// Goal contract: how far a task is delegated, and whether what that level needs is written down.
// Included into board.html's script (shares its scope) and loaded by server/task-contract.mjs; pure, no imports.
//   L0 メモ          a note; never handed to an agent
//   L1 1回の依頼      one request; needs a goal
//   L2 ゴールのループ   loop until the criteria hold; needs a goal, criteria, how each is checked, a round limit
// Readiness is computed from the card each time, never stored (like the lifetime phase).
const CONTRACT_LEVELS = [
  { level: 0, label: 'メモ', detail: 'あとで考える。エージェントには渡さない' },
  { level: 1, label: '1回の依頼', detail: '1回の依頼で終わる。人が結果を見る' },
  { level: 2, label: 'ゴールのループ', detail: '条件を満たすまで周回させる' },
];
const VERIFY_KINDS = { command: 'コマンド', ci: 'CI', ui: '画面確認', human: '人の確認' };
const CONTRACT_GATES = { merge: 'マージの前', production: '本番の前', cost: '費用が上限を超えたとき' };
const CONTRACT_MISSING_LABELS = { goal: '目標', criteria: '完了の条件', maxRounds: '周回の上限' };

// Words that name a wish rather than something an agent can check. The example shows the rewrite.
const VAGUE_TERMS = [
  ['良く', '「表示を良くする」→「一覧の初回表示が 200ms 以内」'],
  ['きれい', '「コードをきれいに」→「`npm run lint` が 0 で終わる」'],
  ['適切', '「適切に処理する」→「空の入力でエラー文を表示する」'],
  ['改善', '「性能を改善」→「`npm run bench` の p95 が 120ms 以下」'],
  ['最適', '「最適化する」→「バンドルが 300KB 以下」'],
  ['ちゃんと', '「ちゃんと動く」→「`npm test` が 0 で終わる」'],
  ['なるべく', '「なるべく速く」→「応答が 1 秒以内」'],
  ['使いやすい', '「使いやすくする」→「キーボードだけで作成できる」'],
  ['問題ない', '「問題ないこと」→「既存の試験がすべて通る」'],
  ['しっかり', '「しっかり確認」→「画面で作成 → 受信箱に表示される」'],
  ['速く', '「速くする」→「一覧の初回表示が 200ms 以内」'],
  ['軽く', '「軽くする」→「メモリが 150MB 以下」'],
  ['高速化', '「高速化する」→「処理が 2 秒以内」'],
];
const CHECKABLE_SIGNS = [
  /\d+(?:\.\d+)?\s*(?:ms|秒|分|時間|%|％|件|行|回|px|KB|MB|GB|文字|日)/i,
  /`[^`]+`/,
  /(?:が通る|で終わる|と表示される|が表示される|を返す|が存在しない|が成功する|がない|が出ない|以内|以下|以上)/,
];

function normalizeVerify(verify) {
  if (verify == null) return null;
  if (typeof verify !== 'object' || !Object.hasOwn(VERIFY_KINDS, verify.kind)) throw new Error('確かめ方の種類が正しくありません');
  const value = typeof verify.value === 'string' ? verify.value.trim() : '';
  if (!value || value.length > 500) throw new Error('確かめ方を入力してください（500文字以内）');
  return { kind: verify.kind, value };
}

function normalizeContract(input) {
  if (input == null) return null;
  if (typeof input !== 'object') throw new Error('ゴールの契約が正しくありません');
  const level = input.level ?? 1;
  if (!CONTRACT_LEVELS.some(l => l.level === level)) throw new Error('任せる度合いが正しくありません');
  const out = { level };
  if (typeof input.goal === 'string' && input.goal.trim()) {
    if (input.goal.length > 500) throw new Error('目標を入力してください（500文字以内）');
    out.goal = input.goal.trim();
  }
  if (input.timeLimitMin != null) {
    const n = input.timeLimitMin;
    if (!Number.isSafeInteger(n) || n < 5 || n > 1440) throw new Error('時間の上限は5〜1440分です');
    out.timeLimitMin = n;
  }
  if (input.gates != null) {
    if (!Array.isArray(input.gates) || input.gates.length > 4) throw new Error('関門は4件までです');
    const gates = [];
    for (const g of input.gates) {
      if (typeof g === 'string' && Object.hasOwn(CONTRACT_GATES, g)) { if (!gates.includes(g)) gates.push(g); }
      else if (g && typeof g.text === 'string' && g.text.trim() && g.text.length <= 200) {
        if (gates.some(x => typeof x === 'object')) throw new Error('自由記述の関門は1件までです');
        gates.push({ text: g.text.trim() });
      } else throw new Error('関門が正しくありません');
    }
    if (gates.length) out.gates = gates;
  }
  return out;
}

// One warning per criterion at most: the first wish-word found, unless the text or its check is already concrete.
function criterionWarning(text, verify) {
  const t = String(text || '');
  if (!t.trim() || verify) return null;
  if (CHECKABLE_SIGNS.some(re => re.test(t))) return null;
  const hit = VAGUE_TERMS.find(([word]) => t.includes(word));
  return hit ? { term: hit[0], message: `「${hit[0]}」は確かめられません。`, example: hit[1] } : null;
}

function contractGateLabel(gate) { return typeof gate === 'string' ? CONTRACT_GATES[gate] : gate.text; }

// contract: the task's `contract`; cycle: its top-level loop cycle ({ goal, criteria, maxRounds }) when configured.
function contractReadiness(contract, cycle = null) {
  const level = contract?.level ?? 0;
  const goal = cycle?.goal || contract?.goal || '';
  const criteria = cycle?.criteria || [];
  const warnings = criteria.map(c => ({ id: c.id, warning: criterionWarning(c.text, c.verify) })).filter(x => x.warning);
  const items = [];
  if (level >= 1) items.push(['goal', !!goal.trim()]);
  if (level >= 2) {
    items.push(['criteria', criteria.length > 0]);
    for (const c of criteria) items.push([`verify:${c.id}`, !!c.verify]);
    if (!criteria.length) items.push(['verify', false]);
    items.push(['maxRounds', Number.isSafeInteger(cycle?.maxRounds)]);
  }
  const missing = items.filter(([, ok]) => !ok).map(([key]) => key);
  return { level, required: items.length, filled: items.length - missing.length, missing, ready: !missing.length, warnings };
}

function contractMissingLabel(key, criteria = []) {
  if (key === 'verify') return '確かめ方';
  if (key.startsWith('verify:')) {
    const i = criteria.findIndex(c => c.id === key.slice(7));
    return `条件${i >= 0 ? i + 1 : ''}の確かめ方`;
  }
  return CONTRACT_MISSING_LABELS[key] || key;
}

function contractMissingText(readiness, criteria = []) {
  return readiness.missing.map(k => contractMissingLabel(k, criteria)).join('、');
}

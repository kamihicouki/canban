// Part of board.html: included into its script by server/ui.mjs and shares its scope.
// Card overlay (Trello "back of card"): one card at a time, floating above the board
//   a session card opens alone; a task card opens beside the sessions linked to it
//   both kinds use the thread layout (thread.js); the size is kept per kind and shared by every card of that kind
// Small key caps: keycap('j', 'k') for the keys alone, keyHint(['Esc'], '閉じる') for keys with what they do.
const keycap = (...keys) => keys.map((k) => h('kbd', { class: 'keycap', text: k }));
const keyHint = (keys, label, cls = '') => h('span', { class: `key-hint ${cls}`.trim() }, ...keycap(...keys), label);
const PANE_MODES = [['text', 'テキスト'], ['preview', 'プレビュー'], ['digest', '要点']];
const PANE_DEF = { mode: 'preview' };
const oneOf = (v, list, d) => (list.some(([k]) => k === v) ? v : d);
const paneGlobal = (() => {
  const s = store.get('paneGlobal', {}) || {};
  return { mode: oneOf(s.mode, PANE_MODES, PANE_DEF.mode) };
})();
const saveGlobal = () => store.set('paneGlobal', paneGlobal);
const PANE_SECS = {
  conv: ['main', '会話'], send: ['main', '指示を送る'], slack: ['main', 'Slack資料'],
  breadcrumb: ['side', 'パンくず'], title: ['side', '見出し'], status: ['side', '状態'], actions: ['side', 'カード操作'],
  add: ['side', 'カードに追加'], labels: ['side', 'ラベル'], prio: ['side', '優先度・期限'], related: ['side', '関連'],
  detail: ['side', '詳細'], pr: ['side', 'プルリクエスト'], resume: ['side', '再開'], progress: ['side', '進捗'],
  task: ['side', null], memo: ['side', 'メモ'], first: ['side', '最初の依頼'], other: ['side', 'その他'],
};
const secTitle = (id) => (id === 'task' ? T.taskCard : PANE_SECS[id][1]);
let cardWidths = normalizeCardWidths(store.get('cardWidths', null));
let cardHeights = normalizeCardHeights(store.get('cardHeights', null));
const saveCardHeights = () => store.set('cardHeights', cardHeights);
const saveCardWidths = () => store.set('cardWidths', cardWidths);

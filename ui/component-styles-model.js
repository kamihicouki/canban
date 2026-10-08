// Component styles: where two designs of one component exist, the user picks one per component
// ("レイアウトとテーマ" → コンポーネントのスタイル). The choice is shared UI state (`componentStyles`).
// Each entry: [value, label, description]; the first option listed with `def` is the default.
const COMPONENT_STYLES = {
  boardCard: ['ボードのカード', 'standard', [
    ['classic', '現行', '札・タイトル・動き・点線の属性の 4 段'],
    ['compact', 'コンパクト', '状態の記号とタイトルの 1 行'],
    ['standard', '標準', '状態の記号・タイトル・いまの動き・差分'],
    ['rich', 'リッチ', '最後の返事・進捗・承認まで']]],
  peek: ['カードのその場返信', 'on', [
    ['on', '使う', 'Space でカードを広げ、開かずに読んで返す'],
    ['off', '使わない', 'カードは開いたときだけ読む']]],
  boardView: ['ボードの表示', 'board', [
    ['board', 'ボード', 'リストを横に並べる'],
    ['inbox', '受信トレイ', '要対応を上にした一覧と、右に会話']]],
  detail: ['カード詳細', 'thread', [
    ['thread', 'スレッド', '会話を主役に、属性は右の詳細パネル'],
    ['modules', 'モジュール', '会話・指示・属性を並べ替えられる部品']]],
  conversation: ['会話の表示', 'folded', [
    ['folded', '折りたたみ', 'ツール呼び出しを 1 行にまとめ、作業時間で区切る'],
    ['classic', '現行', 'すべてのやりとりをそのまま並べる']]],
  composer: ['入力欄', 'chips', [
    ['chips', 'チップ', '権限・添付・送信を 1 つの入力欄にまとめる'],
    ['classic', '現行', '入力欄と送信ボタンを分けて並べる']]],
  taskDetail: ['タスクカード詳細', 'threads', [
    ['threads', 'スレッド', '説明・メモを左、紐付いたセッションをスレッドで切り替え'],
    ['classic', '現行', 'タスクと紐付いたセッションを横に並べる']]],
  review: ['変更のレビュー', 'on', [
    ['on', '使う', '会話の右に変更の差分を開ける'],
    ['off', '使わない', 'カードの詳細に差分を出さない']]],
};
const COMPONENT_STYLE_KEYS = Object.keys(COMPONENT_STYLES);
const componentStyleDefaults = () => Object.fromEntries(COMPONENT_STYLE_KEYS.map((k) => [k, COMPONENT_STYLES[k][1]]));
function normalizeComponentStyles(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = componentStyleDefaults();
  for (const key of COMPONENT_STYLE_KEYS) if (COMPONENT_STYLES[key][2].some(([v]) => v === input[key])) out[key] = input[key];
  return out;
}

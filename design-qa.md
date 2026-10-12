# 会話の可読性の設計確認 — 0.27.2

final result: passed

## 比較対象と状態

- ユーザーの添付デスクトップ画像を読みやすさの参照とした。目標はCanbanの既存UIで会話の文字・行間・コントラストを改善すること。
- 再現可能な変更前のsource visual truth: `docs/design/readability/before-session-light.png`、`before-session-dark.png`。添付画像のMacの一時パスはクラウドには存在しないため、添付画像を目視し、現行コードを同じ架空会話で撮影した画像を比較の基準にした。
- 実装画像: `docs/design/readability/after-session-light.png`、`after-session-dark.png`。ボード・時間軸・詳細パネルは同じディレクトリの`after-{board,timeline,details}-{light,dark}.png`。
- 全体比較: `docs/design/readability/comparison.png`。
- 本文の領域比較: `docs/design/readability/{before,after}-text-{light,dark}.png`。全体だけでは段落の間隔やコードの文字が小さいため、feed領域の画像とDOM実測値も確認した。
- 開発ホスト: `http://localhost:4517/direct`。隔離した架空のClaude会話、定番レイアウト、プレビューモード、会話スクロール位置80px。相対時刻の数分の差は撮影時間による。
- source／実装とも1280×800 pixels、CSS viewport 1280×800、deviceScaleFactor 1。全体比較だけ横に並べた。解像度の正規化や拡大縮小は不要。
- ブラウザ: インアプリBrowserのツールが提供されていないため、クラウド内のChromiumをPlaywrightと既存のChrome DevTools試験で操作した。ブラウザが描画したスクリーンショットを確認した。

## Findingsと修正履歴

1. [P2・修正済み] 本文が14px、固定の行間19px、段落の間隔4.2pxで詰まっていた。`--reading-size: 1rem`と`--reading-leading: 1.8`に変更し、段落の間隔を`.75em`にした。変更後の実測は16px／28.8px／12px。会話の本文・入力・タスク説明と時間軸にも適用した。
2. [P2・修正済み] 青みのある本文と弱いダークの文字色で、長文と補助情報の差が読み取りづらかった。既存の`--card-fg`・`--card-muted`を両テーマで調整。変更後の本文のコントラスト比はライト15.00:1、ダーク12.05:1。
3. [P2・修正済み] 本文の最大幅720pxと複数の独立した余白指定で、本文と入力欄の幅に差があった。`--reading-width: 42rem`と共通の最小余白24pxを使用。標準幅では本文672px。長いURLの折り返しと2倍の文字サイズでもfeed内の横はみ出しがないことを確認した。

各修正後の証拠は`after-*`画像と`after-metrics.json`、`verification.json`。未修正のP0/P1/P2は今回のデスクトップの可読性改善範囲にはない。

## Required fidelity surfaces

| 対象 | 確認結果 |
|---|---|
| Fonts／typography | 既存のシステムフォント・Hiraginoを使用し、Linux用のNoto Sans CJK JPをフォールバックに追加。本文16px・行間1.8、タイトル15px・太さ600、段落12px。コードブロックの二重縮小を解消。日本語と長いURLの折り返しを確認。 |
| Spacing／layout rhythm | 本文と入力を同じ幅に揃え、会話同士の間隔24px。カードのサイズ・レイアウトの枠・アプリバー・キー案内は既存のまま。大きい文字により一度に見える文章量が減るのは意図した変更で、会話内でスクロールできる。 |
| Colors／tokens | 色はbase.cssの既存トークンを変更し、ライト／ダークで定義。本文と補助情報の4組すべてで4.5:1以上。選択・実行中・エラーなどの状態色は既存のもの。 |
| Image quality／asset fidelity | 新しい画像や装飾は不要。既存のロゴ・PICアイコンを使い、文字の読みやすさの変更に画像素材を追加していない。スクリーンショットの文字を元の解像度で確認した。 |
| Copy／content | アプリの文言・機能・入口は追加していない。比較の会話は両版で同じ架空データ。ユーザーの依頼文を製品UIに追加していない。 |

## 操作とアクセシビリティ

- 5レイアウト×ライト／ダークで会話を表示し、同じ文字サイズと折り返しを確認。
- レイアウト切替、テキスト／プレビュー／要点、ツールの開閉、Esc、カードの開き直し、返信下書きの保持、ホイールによる会話内スクロールを確認。
- 標準文字サイズを200%にしたとき本文が32pxになり、横にはみ出さないことを確認。390×800でもページの横はみ出しはなく、本文をスクロールして読める。狭い画面のキー案内による狭さと詳細パネルの幅は既存仕様で、今回のモバイル最適化対象には含めていない。
- 追加の未処理ブラウザエラー0件。ボード・時間の帯・時間軸・カード・分析・Agent Usageの既存ブラウザ試験も成功。
- `npm test`: 395成功／3スキップ／0失敗。Chrome拡張ビルド成功。
- 任意の旧`conversation-scroll.browser.mjs`は変更前のHEADでも失敗する検証コードの不整合を確認。今回の回帰と扱わず、現行UIの操作検証と区別した。

## Implementation checklist

- [x] 会話本文・入力・カードの文字と余白を改善。
- [x] 同じ状態・viewportで変更前後と両テーマを撮影して比較。
- [x] 現行UIの操作と必須テスト、配布版番号0.27.2、生成Chrome CSSの一致を確認。

## Follow-up polish／確認範囲

Mac固有のフォント描画、登録済みChrome拡張と導入済みCodexプラグインへの反映は、このクラウド環境では確認できない。通常checkoutのmainから既存のローカル更新を実施する必要がある。

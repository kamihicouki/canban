# 実装後評価の対応とCodexレビュー

2026-11-14。Fableの実画面評価の原文は`completion-implementation-review.md`、再評価の原文は`completion-implementation-followup.md`に保存し、書き換えていない。

| 指摘 | 対応と証拠 |
|---|---|
| C1 会話の高さ | 質問をnative detailsへ、状態説明をcomposerのキー行へ集約。Fable再評価でdock241→398px・拡大265→444px。原文・選択肢・元アプリ案内を保持 |
| C2 検索の初期選択 | 自動選択と矢印/ポインターの明示選択を分離。Fable再操作で解消。IME、198番目の明示選択は自動試験で確認 |
| C3 外のカードから戻る | 8訪問までの一時履歴と既存pane cacheで、元カード/選択/下書き/caret/scroll/focusを復元。FableとChromeで復帰を確認 |
| C4 iの案内 | 次の表示名を再描画。3表示巡回と⌘Kの直接選択。Fable再評価で一致 |
| C5 アーカイブ印 | 共通の属性行へ追加。Fableがライト/ダークで確認 |
| C6 照らしと小片 | hover/focusでphase DOMを破棄しない。小片とeffective lensを同期、popup closeでpreview解除。元操作の完全再現ではない。Fable再操作は期待どおり、自動Chromeは12周確認 |
| R1 親タスク付き見出し | 余分なgrowを除去、内部list controlsをnowrap、親タスク名を省略表示。Codexの親タスク付き724pxのChrome計測で見出し40px、会話447.7px、ライト/ダーク。`evidence/completion/area-parent/` |
| 表示を一周した際の非先頭選択 | dockを閉じてボードへ移る際に両表示の選択IDを保存。非先頭cardで失敗を再現後、同pane/draftでの巡回成功 |
| 最小オムニの場所が送信入口を覆う | 同じ入口DOMをトップバーへ移動し、空dockを閉じる。5配置Chromeで同DOM、focus、popup非inert、実pointerの送信入口到達を確認（送信はcaptureで停止） |

## 独立Codexコードレビュー

バックエンド/modelのレビューで、期待所属のatomic guard、内容変更済みtaskのcleanup拒否、手動関連追加後のtask保持、型別DAG、期待辺による解除、相手削除後の関係保持、原文ファイル不変を照合。関連21試験成功、阻害事項なし。

追加レビューは見出し/質問/属性/3表示/関連/下書き保持を確認。思考ボタンのaria-pressed不一致はclickとyの共通関数で解消。blurした入力欄のcaret欠落は、履歴応答を止めたundo中のChromeで再現し、描画と同時に復元する修正を確認。

focused入力の復元がbackward選択をforwardへ上書きする追補指摘も修正。selectionDirectionと入力欄scrollTopをfocus後に再適用し、focused/blurredの両方の回帰で確認。本文の読む位置と入力欄内部のscrollは別々に保持する。

支援技術の実機確認、各元アプリの実アカウントでの全面的な継続操作、登録済みChrome、production/ストアはこれらの証拠の範囲外。

# 検証記録

2026-10-09、専用作業ツリー `codex/restore-layouts`、0.26.5。

| 確認 | 結果 |
|---|---|
| `npm test` | 372 / 372成功、失敗・skipなし |
| `node --test tests/board-smoke.browser.mjs tests/layouts.browser.mjs` | 2 / 2成功、ページ例外なし |
| 共有設定・Chrome・管理パネルの関連テスト | 29 / 29成功 |
| カード詳細の返信下書きと管理設定の未保存値 | それぞれ20方向の配置遷移で同じDOM・値を保持 |
| 5配置 × ボード/時間軸 × ライト/ダーク | 20枚、1280×800。文書の横はみ出し・アプリバーの2段化なし |
| 最後の画像確認で見つけたオムニバーのドックとキーヒントの重なり | 間隔とボード下端の余白を修正。配置ブラウザテストで重ならないことを再確認 |
| `npm run build:chrome` | 作業ツリーの `dist/chrome` にビルド成功 |
| ソース3か所と作業ツリー内Chromeビルドのversion | すべて0.26.5 |
| `git diff --check` | 問題なし |
| 通常repoのversionと配布物 | 0.26.4のまま、変更なし |
| 通常repoの未追跡ファイル | `prototypes/accounts-refresh/`、`ui/task-conversation.prototype.html` を保持 |

ログはGit管理外の `.local/layout-test-final.log`、`.local/layout-browser-final.log`、`.local/layout-transitions.log`、`.local/layout-adoption.log`、`.local/layout-build.log`。
最後のドック余白の変更後は、配置ブラウザ検証とChromeビルドを再実行した。JavaScriptの最終変更は全体テストの前に反映済み。

ブラウザ検証と全体テストを並行実行した際、既存の `canban_watch over stdio` の時間依存テストが1件失敗した。
ブラウザ検証の終了後に同じ全体テストを再実行し、372件すべて通過した。サーバー・監視実装は変更していない。

合成データの一時ホームと専用Storeだけを使用した。実ユーザーの履歴の取得・移行、既読変更、カード移動、外部送信、配布版の更新は行っていない。
新しい活動履歴時間軸は静的な3案までで、履歴の記録・読み取りAPIは未実装。導入済み拡張の画面撮影は操作経路の制約により未実施。

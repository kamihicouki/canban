# dotのセッション — 検証画像

1280×800、隔離したChromeと架空の保存済みクラウド情報で撮影します。実クラウドへの同期や指示送信は実行しません。

| 表示 | ライト | ダーク |
|---|---|---|
| ボード | [画像](board-light.png) | [画像](board-dark.png) |
| 時間軸 | [画像](timeline-light.png) | [画像](timeline-dark.png) |

[クラウドカードの詳細](detail-dark.png)ではdotの識別、状態未取得、保存済み情報の更新時刻、Codexで開く操作を確認します。

再実行: `node --test tests/dots.browser.mjs`（`CANBAN_PLAYWRIGHT_PACKAGE`・`CANBAN_BROWSER_EXECUTABLE`で利用するランタイムを指定）。初期非表示、切り替え、チップ解除、タスク保持、再読み込み後の条件保持、クラウド操作の拒否、ページエラーがないことを検証します。

検証結果（0.26.4）:

- `npm test`: 最終の単独実行で373件成功。
- `tests/dots.browser.mjs` と `tests/board-smoke.browser.mjs`: 最終実装で両方成功。dot用では検索を含む全解除、開始先の候補、紐付け先の状態未取得、デスクトップのリンクがない会話のプレビューも確認しました。
- `npm run build:chrome`: 成功。ソースから組み立てたJavaScript/CSSと配布物が一致し、3つのソース設定とビルド済みmanifestは0.26.4で一致しました。
- Claude Code（claude-opus-5-5）による読み取り専用レビュー: 初回5件と再確認で見つかった状態表示の漏れを修正。最後の確認は「初回の5件と追加の状態表示漏れは解消、追加指摘なし」でした。

並行検証時には既存のSQLite競合・ライブ更新テストと、dot用Chromeテストの全体タイムアウトで失敗がありました。既存2ファイルは個別再実行で成功し、最終の全373件とdot用Chromeテストも別々の実行で成功しています。時間制限や実装を緩める変更はしていません。

このworktreeのソースとビルドでの検証です。登録済み拡張の更新、mainへの取り込み、公開は行っていません。

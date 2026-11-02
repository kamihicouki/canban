# 0.29.18 統合確認

1280×800、隔離Chrome、架空セッションと一時フォルダーのシェルで撮影。実会話への送信・承認操作は行っていません。

- `board-*-composer.png` / `timeline-*-composer.png`: 共通入力欄、回答の選び直し、手入力の下書き保持。
- `board-light.png` / `board-dark.png` / `timeline-light.png` / `timeline-dark.png`: カード内ターミナル。`t`、`Shift+Esc`、`Shift+X`、`Shift+R`と⌘Kを確認。
- `npm test`: 507件成功。`node --test tests/board-smoke.browser.mjs`: 成功。
- `tests/conversation-scroll.browser.mjs`: 5画面条件と親テスト、6件成功。
- `tests/recent-integration.browser.mjs`: 回答・下書き・ターミナルのキーと⌘K・ボード/時間軸を成功。

再実行はPlaywrightの導入先を `CANBAN_PLAYWRIGHT_PACKAGE`、Chromeを `CANBAN_BROWSER_EXECUTABLE` に指定します。`CANBAN_INTEGRATION_SHOTS` で統合試験の画像保存先を指定できます。

新しい操作は既存のカードのレイヤー2に収め、ページ・権限を追加しません。mainは開発・統合、productionはリリース専用です。画像は登録済み拡張の再読み込みやストア公開の証拠ではありません。

# Slack取り込みの画面検証

0.24.0 / 1280×800 / Chrome / 架空のデータ。本人のSlack・通常のChromeプロファイル・実データは使っていません。

| レイアウト | ライト | ダーク |
|---|---|---|
| Trello | [画像](trello-light.png) | [画像](trello-dark.png) |
| 定番 | [画像](classic-light.png) | [画像](classic-dark.png) |
| レール | [画像](rail-light.png) | [画像](rail-dark.png) |
| オムニバー | [画像](omni-light.png) | [画像](omni-dark.png) |
| ライブHUD | [画像](hud-light.png) | [画像](hud-dark.png) |

[カードのSlack資料と依頼文への追加](card-source-light.png)、[カテゴリのレーンとSlack列](lanes-light.png)。

検証スクリプトは `tests/slack-intake.browser.mjs`。表示・非表示、⌘K、メッセージから編集してカード作成、資料の明示的な依頼文への追加、返信から既存カードへの追加、接続フォームの入力保持、遅延表示する行のキー操作と作成途中の文章の保持を確認します。返信取得だけを架空のAPI応答へ置き換え、カード作成・紐づけ・保存・UI配信は隔離した実Canbanサーバーを使います。

- タイムラインと接続管理はレイヤー1、カード資料は2、タスク作成は3、カードピッカーは4、⌘Kは5。
- `v` 表示切替、メッセージ上の `c / l / t` 作成・追加・返信、カードの `Alt+s → Enter` 依頼文への追加、`Esc` 上の1枚の開閉。
- Slack API・Socket Mode・編集/削除履歴は `tests/slack.test.mjs` のスタブで検証します。実Slackでの接続と配送は未検証です。

Slackブランチ: `npm test` 313件成功、Chromeブラウザーのシナリオ成功、Chrome向けビルド成功。ソース3か所と `dist/chrome/manifest.json` のバージョンは0.24.0で一致。

ローカルmain統合後: `npm test` 325件成功。セッションのアーカイブ・復元・削除と週間使用ペースの既存変更を保持し、同じChromeシナリオと画面検証を再実行して成功。

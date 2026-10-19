# Session Exchanges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** セッション間の送受信をカードと2ビューのポップオーバーで確認する。

**Architecture:** 読み取り専用のログ索引を別モジュールに置き、受信記録から方向付きイベントを作る。既存のボードに小さい要約、専用の読み取りツールに履歴を載せ、既存popoverで表示する。

**Tech Stack:** Node.js ES modules、既存の@include UI、Node test、Chrome CDP。

**Spec:** docs/design/session-exchanges.md

## Global Constraints

- 既存ページ・カード密度・タスクlinksを維持する。レイヤー4、Shift+M、⌘K。
- 取得済みの範囲を明示し、相手／状態／返信を推測しない。外部データは書き換えない。
- バージョン3ファイル・変更履歴・ストア文書を0.27.13へ更新し、日本語でコミットする。

## Review Focus

- 引用された封筒や壊れた封筒から関係が生じないこと。
- 同じ相手への反復を保持し、二重記録だけをまとめること。
- 削除・切詰め・アカウント／ホスト変更で古い関係を残さないこと。
- 既読化／移動の副作用を起こさず、非表示の相手も確認できること。
- 非同期取得後に閉じたポップオーバーを書き換えず、ビュー切替で履歴を失わないこと。

### Task 1: 読み取り索引とツール

Files: server/exchanges.mjs、server/board.mjs、server/index.mjs、tests/exchanges.test.mjs。
Produces: ExchangeIndex.sync(sessions)、summary(id)、view(id)。

- [x] 実ログ形式のfixtureで受信・反復・関係種別・更新／削除を検証する失敗テストを書く。
- [x] node --test tests/exchanges.test.mjsで失敗を確認する。
- [x] 限定されたログ読取り、索引、要約と読み取り専用canban_exchangesを実装する。
- [x] 同テストを通す。

### Task 2: カードとポップオーバー

Files: ui/exchanges-model.js、ui/exchanges.js、ui/exchanges.css、ui/card-face.js、ui/inbox.js、ui/keyboard.js、ui/board.html、tests/exchanges-ui.test.mjs。
Consumes: summary(id)の送受信相手数とview(id)のイベント／起動情報。

- [x] グループ化・時系列・ビュー切替の失敗テストを書く。
- [x] 専用部品、吹き出し、2ビュー、状態表示、キー／⌘Kを実装してテストを通す。
- [x] 実Chromeでクリック・切替・折りたたみ・Esc・ライト／ダークを確認する。

### Task 3: 配布物と検証

- [x] docs/ui-components.md、package.json、manifest.json、.codex-plugin/plugin.json、CHANGELOG.md、CHROMEWEBSTORE.mdを更新する。
- [x] npm test、node --test tests/board-smoke.browser.mjs、npm run build:chromeを実行する。
- [x] 1280×800でライト／ダーク×ボード／時間軸の画像を保存する。
- [x] 全差分を独立レビューし、必要な修正を検証して日本語でコミットする。

実行記録: baseline npm test 441/441 PASS。既存の隔離worktreeで実装する。main反映・登録済み拡張の更新・公開は今回の依頼に含まれない。

最終検証: npm test 455/455 PASS、実Chromeのboard-smoke 1/1 PASS、build:chrome PASS。1280×800のライト／ダーク×ボード／時間軸×2ビューを8枚保存した。独立レビューで受信形式・重複・自己関係を修正し、送受信数が縮む表示も実Chromeの回帰確認で修正した。ソースとChromeビルドのCSS/JSは一致、バージョンは0.27.13。検証画像と詳細はdocs/design/session-exchanges/README.mdに記録する。

# Desktop へ画像を渡す Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Canban の画像を本文のパス列へ変換せず、ユーザーが Desktop の入力欄で1回貼り付けて画像として確認できるようにする。

**Architecture:** [アカウント保持計画](2026-10-17-claude-desktop-accounts.md)の開始結果に、画像の受け渡し操作を追加する。画像 ID の検証と OS のファイルクリップボードへのコピーをサーバーに閉じ込め、共通入力欄では保存済み画像からプレビューを復元する。CLI/headless の既存の画像入力は維持する。

**Tech Stack:** Node.js 22.13 以上、既存画像保存形式、macOS AppKit/NSPasteboard の JXA、Blob/Object URL、node:test、既存ブラウザーテスト。

**Spec:** [承認済み設計書](../specs/2026-10-17-desktop-launch-design.md)の「画像を Desktop の入力欄へ渡す」「UI・キー・状態の伝え方」。

## Global Constraints

- 「ユーザーがアプリの入力欄で `⌘V` を押して画像として添付する」。自動添付・自動送信の成功とは表示しない。
- 画像は「8枚」「1枚10MB」、PNG・JPEG・WebP・GIF。既存の ID・ハッシュ・保存先を使い、任意パスを受け付けない。
- Desktop 用の画像はこの Mac の保存先を使い、Canban が先にリモートへ転送しない。Desktop が通常の画像転送を行う。
- 「起動時に無断でクリップボードを上書きしない」。明示したコピー操作だけを UI 権限で受け付ける。
- 共通入力欄・作成ダイアログの既存サムネイルを使う。新しいページ・オーバーレイ・Chrome 権限を追加しない。
- 各タスクで3箇所の版・変更履歴・Chrome ビルドを同期し、日本語でコミットする。実験と報告は `.local/desktop-launch-tests/`。

## Review Focus

1. 保存済み画像の差替え・不正 ID・不正な chunk 範囲: Task 1 でコピー前、Task 2 で表示前に拒否する。
2. モデルからのコピー要求・古い UI token・任意パス: Task 1 で OS 呼出し0回を保証する。
3. アカウント切替待ちやダイアログ再生成で Object URL が失効する: Task 2 の共有 draft と解放テストで防ぐ。
4. コピーが成功してもアプリが画像として受け取らない: Task 3 で実際の入力欄を確認し、添付成功とは表示しない。
5. 複数枚・8枚上限の Native Messaging 応答肥大化: Task 2 の128KiB chunk、Task 3 の複数枚テストで検証する。

---

### Task 1: 検証済み画像のファイルコピー

**Files:** Create `server/prompt-clipboard.mjs`, `scripts/prompt-clipboard.jxa`, `tests/prompt-clipboard.test.mjs`; Modify `server/index.mjs`; Test `tests/prompt-input.test.mjs`, `tests/chrome-extension.test.mjs`。

**Interfaces:** `copyPromptImages({dataDir,imageIds}, {platform,run}) -> {state:'copied',count,nextAction:'paste-in-desktop'}`。UI 専用 `canban_copy_prompt_images({imageIds,uiToken})` は既存 UI token と同じ方式で検証し、この関数へ ID だけを渡す。JXA の `run(argv)` は検証済み画像の絶対パスだけを受ける内部入口。

- [ ] **Step 1: 失敗するテストを書く。** `copy requires explicit UI authority`、`tampered image never reaches pasteboard`、`eight files preserve order`、`unsupported OS leaves clipboard unchanged` を追加する。`assert.equal(runCalls, 0)` を不正 ID・ハッシュ差替え・9枚・10MB超・任意パス入力で確認する。起動要求から clipboard 関数が呼ばれないことも確認する。
- [ ] **Step 2: RED を確認する。** `node --test tests/prompt-clipboard.test.mjs tests/prompt-input.test.mjs`。
- [ ] **Step 3: ID 検証と OS アダプターを実装する。** 既存 `promptImages()` で全件を検証してから、`execFile` の argv で信頼済みの JXA に渡す。`NSPasteboard` へ `NSURL.fileURLWithPath` の配列を書き、テキストのパス列にしない。画像・認証情報・ユーザーの既存 clipboard の内容をログに出さない。非 macOS は能力なしとして返す。
- [ ] **Step 4: GREEN と版の同期を確認してコミットする。** 上記テストと Chrome ビルドを実行する。テストの run はスタブにして実 clipboard を変更しない。Git 管理ファイルだけの配布物に JXA が含まれることも確認する。

### Task 2: 保存済み画像のプレビューを復元する

**Files:** Modify `server/prompt-input.mjs`, `server/index.mjs`, `ui/prompt-composer.js`; Create `tests/prompt-preview.test.mjs`; Test `tests/prompt-input.test.mjs`, `tests/task-quick-add.test.mjs`。

**Interfaces:** UI 専用 `canban_read_prompt_image({id,offset,maxBytes,expectedSha256?,uiToken})` は既存 `requireLoopUi()` で検証後、最大 `128 * 1024` bytes の base64 と `{id,mime,size,sha256,offset,nextOffset,complete}` を返す。`readPromptImageChunk(dataDir, {id,offset=0,maxBytes=128*1024,expectedSha256})` が保存先の検証を受け持つ。offset > 0 では初回応答の `sha256` を `expectedSha256` として必須にし、変わった画像は返さない。`promptComposer.restore()` は既存画像 ID を復元し、取得完了後に画像を表示する。

- [ ] **Step 1: 失敗するテストを書く。** `restored draft gets thumbnails without reupload`、`closing one view keeps the shared draft image`、`clearing releases owned object URLs` を追加する。読込みの負数・範囲外・128KiB超を拒否し、既知の全 chunk を結合したハッシュが metadata と一致することを確認する。途中で削除・変更された画像はプレビュー失敗として扱う。
- [ ] **Step 2: RED を確認する。** `node --test tests/prompt-preview.test.mjs tests/prompt-input.test.mjs`。
- [ ] **Step 3: bounded な画像読込みと復元を実装する。** 初回で ID・サイズ・形式・内容の整合性を確認し、後続 chunk は同じファイル世代だけを読む。ブラウザーでも取得した画像の SHA-256 を照合して Blob/Object URL にし、古い非同期結果で新しい draft を上書きしない。バイナリーを board settings/localStorage に保存しない。
- [ ] **Step 4: GREEN と版の同期を確認してコミットする。** 上記テストと `tests/task-quick-add.test.mjs`、Chrome ビルドを実行する。

### Task 3: 起動結果から画像として受け渡す

**Files:** Modify `server/desktop-launch.mjs`, `server/index.mjs`, `ui/task-quick-add.js`, `ui/prompt-composer.js`, `ui/keyboard.js`, `docs/ui-components.md`, `docs/local-layout.md`; Create `tests/prompt-image-handoff.browser.mjs`; Test `tests/direct-session.test.mjs`, `tests/board-smoke.browser.mjs`。

**Interfaces:** `LaunchResult.imageIds` を維持し、画像がある結果には `attachmentState:'pending-paste'` を加える。コピー結果は Task 1 の型を使い、`opened` と `copied` と実際の添付を区別する。Desktop 本文は `withSkills(rawPrompt,skills)` のみとし、`withImagePaths()` は CLI/headless の必要な経路に残す。

- [ ] **Step 1: 失敗するテストを書く。** ローカル/SSH・Claude/Codex の開始で本文に `添付画像` のパス列が入らず、Desktop 起動から remoteImages 呼出しが0回であることを確認する。画像1枚/複数枚/8枚、開始結果の開き直し、切替待ちのキャンセルで画像 ID とプレビューが残ることをブラウザーで確認する。
- [ ] **Step 2: RED を確認する。** `node --test tests/prompt-image-handoff.browser.mjs tests/direct-session.test.mjs`。
- [ ] **Step 3: 同じ開始結果へ「画像をコピー」を追加する。** 開始前から `アプリで画像を貼り付けてください（⌘V）` と案内する。コピー後は `画像をコピーしました。アプリの入力欄で⌘Vを押してください` と表示する。Tab/Enter と⌘K「添付画像をコピー」を同じ操作へ接続し、キーの案内も更新する。本文を自動送信しない。
- [ ] **Step 4: 自動検証と実機確認を行う。** `npm test`、`node --test tests/prompt-image-handoff.browser.mjs tests/board-smoke.browser.mjs`、Chrome ビルド、1280×800のライト/ダークとボード/時間軸を確認する。実機では Canban のコピー操作から両アプリへ貼り付け、サムネイルの枚数を確認し、送信しない。画像として受け取れない場合は能力を有効にせず、アプリの通常の添付操作を案内する。
- [ ] **Step 5: 版・検証結果を揃えてコミットする。** 自動添付の完成とは報告しない。通常 main と登録済み Chrome の更新は、その依頼を受けてから行う。

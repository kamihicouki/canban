# Claude の認証を保持する Desktop 切替 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CLI と Desktop の認証・会話を保持し、通常の Desktop アカウント切替をログアウト0回・再ログイン0回で行う。

**Architecture:** 登録済み Desktop 保存先を、アプリの停止中だけ標準パスへ入れ替える。登録・入替え・復元を1つのサービスに閉じ込め、CLI の認証処理は変更しない。開始要求の段階管理を分離し、複数の Canban プロセスでも同じ要求を1回だけ実行する。

**Tech Stack:** Node.js 22.13 以上、ES modules、node:test、既存 MCP/Native Messaging、macOS の標準 Desktop。

**Spec:** [承認済み設計書](../specs/2026-10-17-desktop-launch-design.md)。対象は「最優先の目標」「共通の起動処理」「Claude の Desktop アカウント切替」「UI・キー・状態の伝え方」。

## Global Constraints

- 「Desktop で同時に操作するアカウントを1つにする」。各アカウントの認証セッションは保持する。
- 「ログアウト0回・再ログイン0回」。初回登録と確認済みの認証失効は分けて扱う。
- 有効な保存先は `~/Library/Application Support/Claude/` の実ディレクトリ。symlink・別ボリューム・既存保存先の上書きは認めない。
- 対応表・台帳は `<Canban保存先>/desktop-accounts/claude/`。ファイル600・ディレクトリ700。認証情報を SQLite・開始記録・検証報告へコピーしない。
- Desktop の通常終了は、切替先を明示してユーザーが選んだ操作だけが依頼できる。強制終了しない。CLI の実行とキューを止めない。
- 作成ダイアログはレイヤー3、アカウント管理は既存のアカウントポップオーバー（`accountsMenu()`、レイヤー4）、送信はユーザーが Desktop で行う。
- 各タスクのコミットで `package.json`・`manifest.json`・`.codex-plugin/plugin.json` の patch を1つ上げ、`CHANGELOG.md`・`CHROMEWEBSTORE.md` と Chrome ビルドを同期する。コミットは日本語。
- 開発データと検証報告は `.local/desktop-launch-tests/`。実プロフィールの入替えは、具体的な計画とバックアップを提示して承認を得た後だけ行う。

## Review Focus

1. 同じアカウントを開く直前に別 Canban が切り替える競合: Task 2 のロック内 no-op と Task 4 の同時要求テストで防ぐ。
2. 最初の rename 後に OS が Desktop を起動し標準パスを作り直す: Task 2 で外部のディレクトリを残して停止する。
3. ゲスト書戻し失敗、古い履歴パス、同じ Desktop ID の複数所有者: Task 3 で拒否し、カード ID を変えない。
4. 通信断・429・状態未確認を認証失効と誤認する: Task 3 と Task 5 で認証・実行を維持する。
5. UI 権限のないモデル要求でアプリを終了・プロフィールを移動する: Task 4 で副作用前に拒否する。

---

## 実行順と共通の型

まず下記の実現性ゲートを通し、この計画、[リモート起動](2026-10-17-remote-desktop-start.md)、[画像の受け渡し](2026-10-17-prompt-image-handoff.md) の順で同じブランチへ統合する。通常 main・登録済み拡張の更新とストア公開は別工程。

**実現性ゲート（製品への接続より先に行う）:** リモート計画 Task 2 の公式 RPC を隔離 home で試し、writer 解放後の空 thread の永続化を確認する。次に登録済み SSH 接続先で試験用の空 thread だけを作り、Task 3 の URL で host・cwd・未送信の本文を確認する。画像計画 Task 1 のファイルコピー方式も、試験画像を両アプリへ1回貼り付けて確かめる。モデルのターンは開始しない。結果は `.local/desktop-launch-tests/capabilities.json` にアプリ版・接続先・確認日時・成否・理由だけを記録する。失敗した経路は実装を接続せず、未確認の能力も UI/API へ利用可能として返さない。CLI と他の成立した経路の検証は継続する。

Claude の認証保持は Task 5 の実機受け入れが別途必要。偽プロフィールの成功だけで切替能力を有効にしない。

`DesktopAccountView = { profiles: [{ id, account, active, auth: 'connected'|'login-required'|'unknown' }] }`。
`AccountResult = { state: 'prepared'|'waiting-for-quit'|'waiting-for-login'|'cancelled'|'failed', account, profileId?, reason? }`。
`LaunchResult = { clientRequestId, state: 'prepared'|'waiting-for-quit'|'waiting-for-login'|'opening'|'opened'|'uncertain'|'failed'|'cancelled', route: 'desktop', account, hostId, threadId?, url?, note?, imageIds? }`。`cancelled` は既存設計の取消しを表す終端状態として追加する。

### Task 1: プロフィールの登録と読み取り

**Files:** Create `server/claude-desktop-accounts.mjs`, `server/claude-desktop-roots.mjs`, `tests/claude-desktop-accounts.test.mjs`; Modify `docs/local-layout.md`。

**Interfaces:** `createDesktopAccounts({dataDir, appDir, runtime, restoreGuests, open, quit, backup, identity, now})` は `{view(), command(command), withAccount(account, options, action)}` を返す。`command` は `enroll-current | begin-login | finish-login | cancel | recover` と要求 ID・期待アカウントだけを受ける。`view()` は `DesktopAccountView` を返す。`server/claude-desktop-roots.mjs` の `readDesktopProfileRoots({dataDir, appDir})` は検証済みの実体一覧を返す。読み取り用モジュールは `accounts.mjs`・切替サービス・runtime に依存せず、scanner/runtime はここだけを参照する。

- [ ] **Step 1: 失敗するテストを書く。** `enroll-current preserves CLI homes and records no credentials` で偽 home の Desktop A と CLI A/B を作る。`assert.equal((await service.view()).profiles[0].account, 'claude:a')`、CLI のパス・ファイル・Keychain スタブが無変更であること、対応表が `id/account/active/dir` 以外の認証情報を含まないことを確認する。symlink・別 device・所有者不一致・不正アカウント・想定外ファイルを拒否し、書込み0回を確認する。
- [ ] **Step 2: RED を確認する。** `node --test tests/claude-desktop-accounts.test.mjs`。未実装の公開インターフェースで失敗すること。
- [ ] **Step 3: 上記インターフェースの登録・一覧部分を実装する。** ID は UUID、ルートは注入した2箇所だけ、台帳は原子的に保存する。CLI home は固定し、Desktop 初回接続を CLI のログインと同一視しない。実機の保存先はテストから参照しない。
- [ ] **Step 4: GREEN と版の同期を確認してコミットする。** 上記テストと `tests/accounts.test.mjs`、`npm run build:chrome`、`git diff --check` を実行する。実装した範囲だけ配置の契約へ記載する。

### Task 2: 停止中の入替えと中断復旧

**Files:** Create `server/claude-desktop-journal.mjs`; Modify `server/claude-desktop-lock.mjs`, `server/claude-desktop-guests.mjs`, `server/claude-desktop-accounts.mjs`, `tests/claude-desktop-accounts.test.mjs`; Create `tests/claude-desktop-journal.test.mjs`。

**Interfaces:** `withAccount(account, {requestId, allowQuit}, action)` は `AccountResult` または `action()` の結果を返す。待機時は `action()` を呼ばない。内部 journal は `parking → parked → activating → activated → committed` の intent、実パス、device/inode を文字列で保持する。`command({type:'recover'})` は停止確認後にだけ復元・確定する。既存 `desktopProfileLock()` を使う `withDesktopMutationLock({dataDir,lease}, action)` を lock モジュールへ追加する。切替・open・ゲスト配置/書戻し・watcher は同じ lifecycle lock を取得し、その後に既存 guest lock を取得する。既に保持した処理だけが内部の opaque lease を渡して再入でき、MCP の入力から lease を受けない。

- [ ] **Step 1: 失敗するテストを書く。** `same account opens without quit or login`、`A-B-A preserves both trees`、`crash after each rename recovers`、`lost lock stops the next mutation`、`guest watcher cannot write across a swap` を追加する。`assert.equal(quitCalls, 0)`、`assert.equal(loginCalls, 0)`、A/B の会話と cookie の偽データを確認する。各 rename 直前に外部起動・標準パスの再作成・device/inode の変更を注入し、既存ファイルを残すことも確認する。watcher と切替を競合させ、書戻しが元アカウント内で完了してから rename されること、再入で deadlock しないことを確認する。
- [ ] **Step 2: RED を確認する。** `node --test tests/claude-desktop-accounts.test.mjs tests/claude-desktop-journal.test.mjs`。
- [ ] **Step 3: ロック・intent 保存・rename・復旧を実装する。** 同一アカウントの no-op も、実体の照合からアプリを開くまでロックで保護する。副作用前の durable な intent を fsync し、既存パスは上書きしない。プロセスや実体が不明な場合、強制終了・自動削除・ロックの強奪をしない。
- [ ] **Step 4: GREEN と版の同期を確認してコミットする。** 上記テストに `tests/claude-desktop-guests.test.mjs` を加えて実行し、Chrome をビルドする。

### Task 3: 初回ログイン・ゲスト復元・既存 CLI との分離

**Files:** Modify `server/claude-desktop-accounts.mjs`, `server/claude-desktop-profile.mjs`, `server/claude-desktop-open.mjs`, `server/claude-desktop-runtime.mjs`, `server/accounts.mjs`, `server/accounts-mcp.mjs`, `server/start-account.mjs`, `server/sources/launch-targets.mjs`; Test `tests/claude-desktop-accounts.test.mjs`, `tests/claude-desktop-profile.test.mjs`, `tests/claude-desktop-open.test.mjs`, `tests/accounts.test.mjs`, `tests/start-account.test.mjs`。

**Interfaces:** `begin-login` は `waiting-for-login`、`finish-login` は期待アカウントが一致した場合だけ `prepared` を返す。`withDesktopAccount()` は Task 2 のサービスへ委譲する。`claudeEnvironments(appDir, {expectedAccount}={})` はアカウントが不一致なら環境を返さない。既存 `startAccount()` の CLI 用 `{prefix, account, open}` 契約は維持する。

- [ ] **Step 1: 失敗するテストを書く。** `wrong Desktop login never rebinds CLI`、`network failure is unknown, not logout`、`guest restore failure prevents switching`、`parked history keeps card IDs` を追加する。CLI A を実行したまま Desktop B の準備を行い、起動済みプロセス・キューの home とアカウントが A のままであることをスタブと既存認証分離テストで確認する。異なる所有者の同じ Desktop ID と古い sourcePath を自動統合しない。
- [ ] **Step 2: RED を確認する。** `node --test tests/claude-desktop-accounts.test.mjs tests/start-account.test.mjs tests/accounts.test.mjs`。
- [ ] **Step 3: 登録と既存起動経路を接続する。** ゲストの書戻しを入替え前に完了し、切替後に探索キャッシュと sourcePath を再解決する。Desktop のローカルアカウントと SSH 作業先を分離する一方、CLI のリモートアカウント選択制約は勝手に変更しない。CLI の access token 更新と Desktop の認証更新を結合しない。
- [ ] **Step 4: GREEN と版の同期を確認してコミットする。** 上記5テストに `tests/claude-auth-isolation.test.mjs` と `tests/claude-handoff.test.mjs` を加える。未登録の Desktop 別アカウントを拒否する既存テストは残し、登録済みの場合だけ成功するテストを追加する。

### Task 4: 再開可能な開始要求と UI 権限

**Files:** Create `server/desktop-launch.mjs`, `tests/desktop-launch.test.mjs`; Modify `server/index.mjs`, `server/launcher.mjs`, `ui/task-quick-add-model.js`; Test `tests/launch-once.test.mjs`, `tests/task-quick-add.test.mjs`, `tests/mcp.test.mjs`。

**Interfaces:** `createDesktopLaunches({dataDir, accounts, resolveTarget, prepareThread, open, now})` は `start(input, {uiAuthorized=false}={})`, `status(clientRequestId)`, `cancel(clientRequestId)`, `recover()` を返す。`start` の入力は既存開始引数に `allowDesktopSwitch?:boolean`, `allowQuit?:boolean` を加え、結果は `LaunchResult`。MCP schema には optional `uiToken` を加え、handler が既存の `requireLoopUi()` で検証した場合だけ内部の `uiAuthorized:true` を渡す。入力の boolean だけで権限を与えない。保留の再開でも、永続化した要求の許可範囲・期待アカウント・所有者を照合する。`status` は読み取り専用。本文・画像 ID の保留記録は600で保存し、UI token は保存・指紋へ含めない。

- [ ] **Step 1: 失敗するテストを書く。** `waiting is resumable with the same request ID`、`two MCP processes open once`、`unknown open never retries`、`cancel never cancels CLI`、`model request cannot quit or swap` を追加する。`assert.equal(openCalls, 1)` と、権限のない要求では `assert.equal(renameCalls, 0)` を確認する。待機中に入力を変更しても元の指紋を使い、別内容の再送を拒否する。
- [ ] **Step 2: RED を確認する。** `node --test tests/desktop-launch.test.mjs tests/launch-once.test.mjs tests/task-quick-add.test.mjs`。
- [ ] **Step 3: Desktop の開始処理をサービスへ抽出する。** `canban_start_session` を薄い入口にし、`canban_get_start_session({clientRequestId})` と UI 専用 `canban_cancel_start_session({clientRequestId,uiToken})` を追加する。切替・通常終了・初回登録は既存 UI token と同じ照合方式で保護し、モデル要求は保留案内までにする。保留は起動時の `recover()` と重複しない所有者付きワーカーで再開する。CLI/Cloud は既存 `launchOnce()` を使う。
- [ ] **Step 4: GREEN と版の同期を確認してコミットする。** 上記テストと `tests/mcp.test.mjs` を実行する。未登録・不正要求は外部操作前に失敗し、開始後に結果が不明なら `uncertain` のまま自動再送しないこと。

### Task 5: 切替 UX と認証維持の実機受け入れ

**Files:** Modify `server/index.mjs`, `ui/accounts.js`, `ui/accounts.css`, `ui/task-quick-add.js`, `ui/task-quick-add.css`, `ui/keyboard.js`, `docs/ui-components.md`, `docs/local-layout.md`; Create `tests/desktop-accounts.browser.mjs`, `scripts/desktop-account-trial.mjs`; Test `tests/account-login-ui.test.mjs`, `tests/task-quick-add.test.mjs`, `tests/board-smoke.browser.mjs`。

**Interfaces:** アカウント管理用の UI 専用ツールは `canban_desktop_accounts`（一覧）、`canban_desktop_account_command`（Task 1 の command と `uiToken`）。任意パス・OS コマンド・認証情報は受け付けない。試行スクリプトは `plan | apply --apply | verify | rollback --apply` を持ち、計画と復元先を先に表示する。

- [ ] **Step 1: ブラウザーテストを書く。** 同一アカウントは既存アプリを開く、別アカウントは `A → B に切り替えて開く`、処理中・状態未確認は待機、待機のキャンセルで本文・画像が残る、通信障害は `状態を確認できません` と表示する。Tab/Enter・⌘K・Esc とボード/時間軸の同じ入口を操作する。
- [ ] **Step 2: RED を確認する。** `node --test tests/desktop-accounts.browser.mjs`。実アプリを終了しない dry-run fixture で新しい表示と操作が未実装のため失敗すること。
- [ ] **Step 3: 同じアカウントポップオーバーと作成ダイアログへ実装する。** 初回接続・切替待ち・取消し・再確認を表示する。`⌘K` に切替取消しを追加し、ボタンの Tab/Enter と既存キーの案内を揃える。アプリで未保存の入力を保持できない場合は自動終了を依頼せず終了待ちにする。試行のログには認証情報を出さない。
- [ ] **Step 4: 自動検証する。** `npm test`、`node --test tests/desktop-accounts.browser.mjs tests/board-smoke.browser.mjs`、`npm run build:chrome` を実行する。1280×800のライト/ダーク、ボード/時間軸のスクリーンショットを確認する。
- [ ] **Step 5: 実機の保持条件を検証する。** 具体的なプロフィール入替え計画とバックアップの承認後、初回ログイン済み A/B で `A → B → A` を3往復する。再ログイン0回・ログアウト0回、双方の CLI/Desktop の会話・作業先・保存済み下書き、Dock 起動と CLI 継続を確認する。正常な token 更新は許容し、ファイルの単純なバイト一致を判定にしない。未確認・失敗なら切替機能を利用可能として公開せず、証拠と未達条件を残す。
- [ ] **Step 6: 版・ビルド・検証結果を揃えてコミットする。** ローカル検証と実機の結果を別に報告する。通常 main と登録済み Chrome への反映は、その依頼を受けてから行う。

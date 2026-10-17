# Claude・Codex のリモート Desktop 起動 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同じ SSH 接続先の仕事を Claude と Codex の Desktop で開き、本文を下書きとして渡す。

**Architecture:** [アカウント保持計画](2026-10-17-claude-desktop-accounts.md)の `LaunchResult` と開始サービスを使う。Claude は既存の SSH URL、Codex は接続先の公式 App Server で準備した空 thread の URL を使う。接続先の解決と、副作用を伴う thread 準備を分ける。

**Tech Stack:** Node.js 22.13 以上、Python 3、公式 Codex App Server の stdio JSON-RPC、既存 SSH RemotePool、node:test。

**Spec:** [承認済み設計書](../specs/2026-10-17-desktop-launch-design.md)の「共通の起動処理」「SSH の一致判定」「Claude」「Codex」。

## Global Constraints

- 「モデルのターンは開始しない」。Desktop での送信はユーザーが行う。
- `codex://threads/new` に `hostId` を追加してリモート対応と扱わない。既存 thread を `hostId` と `prompt` 付きで開く。
- ローカル Desktop のアカウントと、リモートの CLI 認証をコピー・同期しない。Codex の Desktop アカウント自動切替は追加しない。
- SSH の照合は host・user・port を使い、`ProxyCommand`・`Match exec` を照合のために実行しない。曖昧なら選び直しを案内する。
- thread の結果不明は `uncertain` とし、同じ要求を自動で作り直さない。writer を解放してから Desktop を開く。
- 各タスクで3箇所の版・変更履歴・Chrome ビルドを同期し、日本語でコミットする。実験と報告は `.local/desktop-launch-tests/` に置く。

## Review Focus

1. 同じ alias の別 user/port、同じ環境名の複数アカウント: Task 1 で誤一致を拒否する。
2. SSH 設定の動的条件・Include 循環・未解決の値: Task 1 で任意コマンドを起動せず未確認として返す。
3. 空 thread 作成直後の接続断・プロセス終了: Task 2 の接続先側の予約記録で重複を防ぐ。
4. 異なるホストに同じ thread ID がある場合: Task 2/3 で host と cwd も読み戻す。
5. Desktop の起動失敗・元の Claude 環境 ID の陳腐化: Task 3 で別ホストや CLI に黙って切り替えない。

---

### Task 1: SSH とアカウント別環境の照合

**Files:** Create `server/sources/ssh-targets.mjs`, `tests/ssh-targets.test.mjs`; Modify `server/sources/remotes.mjs`, `server/sources/launch-targets.mjs`; Test `tests/remote.test.mjs`, `tests/tasks.test.mjs`。

**Interfaces:** `resolveSshTarget({alias,hostname,user,port}, {readConfig}) -> {state:'resolved'|'unknown'|'ambiguous', hostname?, user?, port?, reason?}`。`matchDesktopTarget({requested,claudeEnvironments,codexHosts})` は一意の照合結果だけを返す。ファイル取得を注入し、値は実行しない。

- [ ] **Step 1: 失敗するテストを書く。** `same alias with different ports never matches`、`different aliases with one resolved target match`、`dynamic Match and recursive Include are unknown` を追加する。`assert.equal(result.state, 'ambiguous')` または `'unknown'` と `assert.equal(spawnCalls, 0)` を確認する。hostname は小文字、user は大文字小文字を区別し、未指定 port の既定値は22とする。環境 ID は選択アカウントと組で照合する。
- [ ] **Step 2: RED を確認する。** `node --test tests/ssh-targets.test.mjs`。
- [ ] **Step 3: 静的に確定できる定義だけを解決する。** `Host` と `HostName/User/Port`、静的な `Include` を読む。最初の設定値を採用し、動的条件・未対応の展開・循環は推測しない。既存 SSH の実行引数は保持する。
- [ ] **Step 4: GREEN と版の同期を確認してコミットする。** 上記テストと `tests/remote.test.mjs tests/tasks.test.mjs` を実行し、Chrome をビルドする。

### Task 2: リモートの公式 API で空 thread を準備する

**Files:** Create `server/codex-desktop-start.mjs`, `tests/codex-desktop-start.test.mjs`, `tests/codex-desktop-start.integration.mjs`; Modify `server/remote/dispatch.py`, `server/remote/pool.mjs`; Test `tests/remote.test.mjs`。

**Interfaces:** `prepareCodexDesktop({host,cwd,clientRequestId}, {pool,rpc,verify}) -> {state:'prepared'|'uncertain'|'failed',threadId?,hostId,cwd,reason?}`。接続先へ渡す新 mode は `desktop_prepare_codex`、入力は要求 ID と絶対 cwd のみ。接続先の予約は `~/.canban-remote/launches/<clientRequestId>.json` に600で保存する。

- [ ] **Step 1: 失敗するテストを書く。** `retry prepares one thread`、`disconnect after start is uncertain`、`writer closes before opening`、`same UUID on another host is rejected` を追加する。`assert.equal(startCalls, 1)`、`assert.equal(turnStartCalls, 0)`、`assert.equal(result.hostId, requestedHostId)` を確認する。不正要求 ID・相対 cwd・CLI 不在を外部操作前に拒否する。
- [ ] **Step 2: RED を確認する。** `node --test tests/codex-desktop-start.test.mjs tests/remote.test.mjs`。
- [ ] **Step 3: 公式 App Server の接続と永続化を実装する。** `initialize/initialized → thread/start` を使い、現在の CLI で空 thread が永続化されることを隔離 home で確認する。既存統合テストと同様に必要なら `thread/archive` と `thread/unarchive` で永続化する。ID を得た段階と永続化完了を別々に記録し、close 後に新しい接続から ID/cwd を読み戻す。`turn/start`・`codex exec` は使わない。
- [ ] **Step 4: GREEN と隔離した公式 CLI の統合試験を確認する。** 上記テストと `node --test tests/codex-desktop-start.integration.mjs` を実行する。モデル呼出し0回、writer 解放後の読み戻し成功が条件。接続先側の処理が結果不明なら、再試行は記録の確認だけを行う。
- [ ] **Step 5: 版・ビルドを揃えてコミットする。** 実際の登録済み SSH Desktop で下書きが開ける確認は Task 3 に分ける。

### Task 3: 作成ダイアログと Desktop への接続

**Files:** Modify `server/desktop-launch.mjs`, `server/index.mjs`, `server/agents.mjs`, `ui/task-quick-add.js`, `ui/task-quick-add-model.js`, `docs/ui-components.md`; Create `tests/remote-desktop-start.browser.mjs`; Test `tests/desktop-launch.test.mjs`, `tests/tasks.test.mjs`, `tests/task-quick-add.test.mjs`, `tests/direct-session.test.mjs`, `tests/board-smoke.browser.mjs`。

**Interfaces:** `canban_launch_targets` は optional `account` を受け、対象アカウントの環境と `desktopCapabilities` を返す。Codex のリモート開始は Task 2 を経由し、`LaunchResult` に host と thread ID を残す。旧 `newSessionLink('codex',{host:remote})` の拒否は維持し、未対応の呼出しから新規 URL を使わせない。

- [ ] **Step 1: 失敗するテストを書く。** Claude/Codex で同じ接続先・cwd の開始、別アカウントの環境 ID、削除済み接続、重複送信、応答切断を fixture で試す。Claude の URL の host/port/folder、Codex の既存 thread URL の hostId/prompt を検証し、`assert.equal(modelTurns, 0)` を確認する。開けなかった場合に terminal 呼出しが0回であることも確認する。
- [ ] **Step 2: RED を確認する。** `node --test tests/remote-desktop-start.browser.mjs tests/desktop-launch.test.mjs`。
- [ ] **Step 3: 能力を確認した経路だけ開始できるように接続する。** UI の一律禁止を外し、アカウント別の環境を読み直す。選択を変更しても本文・画像を保持する。準備済み thread の再利用と `uncertain` の案内を表示し、CLI 実行や Cloud への暗黙の代替を行わない。
- [ ] **Step 4: 自動検証と実機確認を行う。** `npm test`、`node --test tests/remote-desktop-start.browser.mjs tests/board-smoke.browser.mjs`、Chrome ビルド、1280×800のライト/ダークとボード/時間軸を確認する。実際の登録済み SSH Desktop では、対象 host・cwd・未送信の本文を確認し、送信しない。成立しなければ対象能力を有効にしない。
- [ ] **Step 5: 版・検証結果を揃えてコミットする。** ローカル/fixture/実機の確認結果を区別する。

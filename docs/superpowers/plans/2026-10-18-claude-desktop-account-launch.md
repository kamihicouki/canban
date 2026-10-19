# Claude Desktopのアカウント選択と会話継続 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans。ユーザーはNativeでの実装・実アカウントの試験・ローカル反映まで承認済み。初回ログインと検証会話の送信だけユーザーが行う。

**Goal:** Canbanから毎回Desktopアカウントを選び、認証を保持して元の会話を継続する。
**Architecture:** 既存のプロフィール切替・永続起動・ゲスト共有を拡張する。CLI選択からDesktop選択を分離し、初回接続は通常切替gateから独立させる。
**Tech Stack:** Node ESM、既存MCP/UI bridge、macOS Claude Desktop。
**Spec:** この計画の「承認済み要件」および2026-10-18のユーザー提示計画。旧設計の実機確認前の初回接続禁止より今回の明示要件を優先する。

## Global Constraints
- 日本語、Codexはgpt-6.1-solのみ、Nativeで実装。認証値のコピー・CLI設定変更・強制終了・モデルへの自動送信なし。
- Desktopは1つ。保存・終了をユーザーが行った後、自動続行。待機取消し・入力/画像保持・同IDの二重実行禁止。
- 同じ会話ID/CLI履歴/cwdで別アカウントへゲスト共有。BUSY_KEYSの会話は元アカウントで整理するまで拒否。
- 既存SourceRef/remote/Codex/未確認環境gateは維持。各実装コミットで版3箇所・変更履歴2箇所同期。

## Review Focus
1. 初回接続が未確認gateで再び隠れる循環と、登録だけでOAuth有効扱いにする誤表示。
2. 退避した正本と初期移行の複製の競合、書戻し先の移動、同IDの所有者衝突。
3. 準備中の取消し・切替後の取消し・複数開始・再起動による二重open。
4. Desktop選択をCLI実行設定へ混ぜること、別アカウントのMCP権限の混入。
5. app更新/実機未確認/保存状態不明でも可能と表示し、再ログイン0を試験なしで主張すること。

## 承認済み要件
- カードの既存Desktop起動と作成ダイアログで起動アカウントを表示・選択する。前回Desktop選択、なければ現在ログイン中を既定にする。
- 初回接続・復元はUIから利用でき、未接続/確認中/利用可能/再確認を表示する。通常切替は実機の保持確認後だけ有効にする。
- 終了確認→前回ゲスト書戻し→バックアップ→プロフィール切替→アカウント確認→ゲスト配置→同じ会話を開く。
- 実機A/Bを3往復、初回以外再ログイン/ログアウト0。専用会話でユーザーが各1回送信し継続と書戻しを確認。CLI/下書き/Dockも確認後、有効化し登録済み拡張へ反映する。

### Task 1: 接続・保持確認のサービスと入口
**Files:** server/desktop-account-setup.mjs、server/desktop-capabilities.mjs、server/index.mjs、関連tests。
**Interfaces:** 既存canban_desktop_account_commandの初回接続/cancel/recoverはUI許可のみで実行可能。DesktopAccountViewにactiveAccount/lastAccount/setup状態を返す。保持確認のtrial開始/切替/観察確認をUI専用操作として提供し、実体の一致と実際の確認を記録した後だけbuild-bound receiptを作る。
- [ ] RED: gate=falseでもenroll/begin/finish/cancel/recover可能、未許可の通常switchは不可能、試験途中はreceiptなし。
- [ ] 実装→対象試験GREEN。初回接続と試験の待機は同要求で再確認し、cancel/recoverを表示する。
- [ ] 版を同期して日本語commit。

### Task 2: 登録プロフィールをまたぐ正本探索とゲスト書戻し
**Files:** server/claude-desktop-guests.mjs、server/claude-desktop-open.mjs、roots、関連tests。
**Interfaces:** guestPathsのdataDirを使い、登録済みアカウントの正本はそのprofile内だけ、未登録は従来の標準ツリー。元pathはゲスト配置後の切替まで動かさず、書戻しが失敗/競合したら切替禁止。共有CLI履歴はsourceのnativeID/realpathを照合する。
- [ ] RED: A parked/B activeでAの会話をBへゲスト配置、正本へ進捗を戻す、古い複製を無視、busy/衝突はopenなし。
- [ ] 実装→既存ゲスト/切替試験含めGREEN、版同期commit。

### Task 3: 既存会話の永続Desktop再開
**Files:** server/desktop-launch.mjs、server/claude-desktop-resume.mjs、server/index.mjs、関連tests。
**Interfaces:** canban_open_sessionにdesktopAccount/clientRequestId/allowDesktopSwitch/uiTokenを追加。Desktopアカウント指定のClaude再開を共通永続サービスへ渡す。開始入力にoperation:'resume',cardId、targetにnativeID/DesktopID/sourcePath/owner/cwdをサーバーから固定。newは後方互換。
- [ ] RED: CLI設定と異なる選択、終了後再開、同IDで1open、切替先改変/元履歴改変/busy/queued/取消し/不明結果で二重実行なし。
- [ ] 実装→既存new/SourceRef/remoteテスト含めGREEN、版同期commit。

### Task 4: 共通Desktop選択UI・実機受入れ・ローカル反映
**Files:** ui/desktop-accounts.js、既存card-overlay/resume/task-quick-add/accounts/keyboard、docs、browser tests。
**Interfaces:** Desktopアカウントピッカーを共有。選択はCLI設定と独立、最後に成功したDesktop選択を永続化。起動の結果とwait/cancelは既存カード/作成画面内に表示。初回接続は既存accountsポップオーバーへ案内する。
- [ ] RED: 未確認でも接続入口、全アカウント選択、CLI変更なし、wait/cancel/閉じて再開で本文画像保持。
- [ ] 実装→全npm/Chrome smoke/1280x800 light,dark board,timeline。
- [ ] 全体独立レビュー1回、ImportantをRED→GREENで1修正パス。
- [ ] 実機バックアップ/初回接続/3往復/専用会話でのユーザー送信/書戻し/認証保持/Dock/CLIを確認。有効化は実証後のみ。
- [ ] 他チャットの更新状態確認、最新main統合、npm run update:local、登録Chrome再読み込み・実表示の版確認。承認済み実機の人手操作が残る場合、未達を明示し完了にはしない。

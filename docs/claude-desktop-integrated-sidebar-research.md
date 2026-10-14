# Claude Desktop 統合サイドバー起動の検証

調査日: 2026-10-14（JST）。対象は `/Applications/Claude.app` version `2.37337.1`。app.asar の配布 JavaScript を展開して読み、実データの session metadata と `~/.claude/projects` を読み取った。Desktop の停止・起動、ファイルの書き込みは行っていない。

## 目的

| 状況 | Canban の操作 |
| --- | --- |
| ボード | 全アカウント・全セッションを常に表示する |
| Desktop 起動中・別アカウント | 起動を拒否する |
| Desktop 起動中・同じアカウント | そのセッションを開く |
| Desktop がどれも起動していない | 全アカウントのセッションをサイドバーに統合して起動する。終了後は各アカウントに分離し、進めた内容は元のセッションに残す |

Desktop のネイティブな取り込み（`claude://resume`・別プロフィールからの import）は新しい ID の複製を作り、元のアカウントへ反映しないため使わない。

## Desktop の実装で確認したこと

| 論点 | 確認内容 | 統合起動への影響 |
| --- | --- | --- |
| サイドバーの保存先 | `loadSessionRecords()` は `userData/claude-code-sessions/<現在のaccountId>/<現在のorgId>` を `readdir` し、`local_*.json` を `stat`・`JSON.parse` して読み込む。所有アカウントの照合はない | ゲスト（他アカウントの JSON のコピー）を置けば一覧に載る見込み |
| session JSON | アカウント・組織の項目を持たない（`sessionId`・`cliSessionId`・`cwd`・`title`・`lastActivityAt` など） | コピーをそのまま置ける |
| 会話の本体 | 再開は `resume: cliSessionId` で同じ transcript を使う。`priorCliSessionIds` が増えるのは `/clear` のとき | 続きは元の transcript に追記される |
| ネイティブの import | 同じアカウントのセッションだけを対象にし、他アカウントは `not-a-candidate`。symlink の account/org dir は `symlink-not-followed` で無視する | 共有には使えない。symlink 方式も避ける |
| 削除 | 削除は `deleted_<id>` の tombstone を書き、transcript に `.desktop-released.json` を付けて、条件により transcript を削除（reap）する | **ゲストを削除すると元アカウントの transcript が消え得る**。対策が必須 |
| 横断走査 | `CliSessionDiscovery` は同じ userData の全 account dir の `local_*.json` を走査して所有済み ID を集める | 別プロフィール（別 userData）の原本は見えない |

## 実データで確認したこと

- `main`（cb1e）の 52 件、`Claude-ppb`（50e8）の 2 件とも、transcript はすべて共通の `~/.claude/projects` にある。アカウントが違っても同じ会話ファイルに到達する。
- 削除済みセッションの tombstone と、同じ ID の `.desktop-released.json` が実在する。削除による解放は実際に起きている。

## 設計への反映

1. 起動前（Desktop 停止中）に、起動アカウントの dir へゲストをコピーし、台帳（コピー元・ハッシュ・時刻）を `~/.canban` に保存する。タイトルに `🔗 <アカウント名> ·` を付ける。
2. ゲストの transcript は APFS clone（`cp -c`）で退避する。容量はほぼ増えず、hard link と違ってリンク数も増えない。
3. 終了を検知したら、ゲストの進行項目を元の JSON へ書き戻し、タイトルの印を外し、アカウント固有の項目（リモート MCP・Chrome・bridge ID など）は原本の値を残す。ゲストと tombstone を削除する。
4. ゲストが削除されていた場合は、原本を削除しない。transcript が消えていれば退避分から戻し、ユーザーに知らせる。
5. Canban の起動時にも台帳を見て、残ったゲストを同じ手順で片付ける。

## 実機で確認したこと（2026-10-14）

| 確認項目 | 結果 | 根拠 |
| --- | --- | --- |
| ゲストがサイドバーに載る | 確認 | main（cb1e）のフォルダ 53 件に対し、main.log は `Loaded 49 persisted sessions … (4 archived deferred)`。49 + 4 = 53 でゲストを含む。`claude://code/continue` で開くと、ゲストの `lastFocusedAt` が更新された |
| ゲストのターンが元の会話に追記される | 確認 | ゲスト（ppb の会話）で 1 ターンが実行され、元の transcript に追記された。`cliSessionId` は変わらなかった |
| 終了後、元アカウントに分離され進行が残る | 確認 | 書き戻し後に Claude-ppb で起動すると `Loaded 2 persisted sessions`（ゲストなし）。原本は `completedTurns`・`lastActivityAt` などが更新され、タイトルの印は外れ、`remoteMcpServersConfig` は原本の値のまま。cb1e 側にゲストや tombstone は残らない |
| 画面での見た目 | 未確認 | launchd からの `screencapture` は壁紙しか写らなかった（画面収録の権限がない） |

**見つかった問題**：ユーザーが ⌘Q した時点で、ゲストの会話は作業中だった。Desktop はその会話に `interruptedByQuitAt` を付けて保存し、統合起動時に「The app was quit while you were working」として**起動アカウント（cb1e）で自動再開した**。追記と書き戻しは正しく動いたが、ユーザー操作なしに別アカウントの利用枠でターンが走った。対策として、`interruptedByQuitAt`・`interruptedAwaitingPerson`・`lastTurnCutShort` が付いた会話はゲストにしない（元のアカウントで再開させる）。`scripts/desktop-integrated-trial.mjs` の `BUSY_KEYS` に追加済み。

## 実機検証の記録

`scripts/desktop-integrated-trial.mjs`（status / switch / prepare / restore。`--apply` なしでは書き込まない）を、launchd のジョブから順に実行する。ジョブは Desktop を終了しても止まらない。

- 1 回目（2026-10-14 16:06）：両セッションの無操作を確認してから AppleScript で終了を要求した。main.log には `beforeQuit: vetoed by before-quit interceptor` と `[updater-guard] restart deferred; 1 local or SSH session(s) still running` が記録された。**セッションのプロセスが残っている間、Desktop は終了の確認を求めて外部からの終了を拒否する**。ゲストの配置前に中止したため、変更はない。
- 統合起動の終了は、この確認をユーザーが行う前提にする（強制終了しない）。Canban の実装でも「Desktop の終了はユーザーの ⌘Q を待つ」とする。
- launchd のジョブは `~/Documents` 配下のファイルを読めない（TCC、exit 127）。ジョブの実体は `~/.canban/desktop-integrated/trial/` に置く。
- 2 回目（16:14〜16:22）：ユーザーの ⌘Q を待ってから、切替・配置・起動・終了・書き戻し・Claude-ppb での再起動まで完走した。結果は上の表のとおり。

## 実装（ピュア構成、0.29.0）

ピュア構成では全アカウントの会話が同じ `Claude/claude-code-sessions` にあるため、ゲストの複製と書き戻しは同じ保存先の中で完結する。プロフィールの切替は使わない。実装は `server/claude-desktop-guests.mjs`。

| 状況 | 「Claude で開く」の動き |
| --- | --- |
| ログイン中のアカウントの会話 | そのまま開く |
| ほかのアカウントの会話・Desktop 停止中 | ほかのアカウントの開いている会話をすべてゲストとして置き、その会話を開く（Desktop が起動する）。監視プロセスを切り離して起動する |
| ほかのアカウントの会話・Desktop 起動中（統合中のゲスト） | ゲストの会話をそのまま開く |
| ほかのアカウントの会話・Desktop 起動中（統合していない） | 開かない。既定はターミナルで再開し、Desktop を終了してから開けばまとめて開けると案内する |

- **ゲストにしない会話**：アーカイブ済み、作業途中で終了された会話（`BUSY_KEYS`）、会話記録が見つからないか複数あるもの、置き先に同じ ID があるもの。
- **台帳**：`~/.canban/desktop-integrated/ledger.json`（データフォルダの中）。ゲストを 1 件置くたびに先に台帳を書くので、途中で止まっても追跡できないゲストは残らない。原本の JSON と会話記録は `backup/<id>/` に APFS clone で退避する。
- **書き戻し**：監視プロセス（`node server/claude-desktop-guests.mjs watch`）が Desktop の終了を待って行う。台帳がある間に Canban が起動したときも、Desktop が止まっていれば片付け、起動中なら監視を付け直す。手動では `node server/claude-desktop-guests.mjs restore`（`plan`・`status` は読むだけ）。
- **ボード**：統合中は同じ会話の記録が 2 か所にあるが、台帳にあるゲストは元のアカウントの会話として 1 枚に表示する。進行はゲスト側の新しい値を使い、ログイン中のアカウントからも届くものとして扱う（`desktopReach`）。
- **未確認**：同じ保存先に同じ `sessionId` が 2 つある状態での Desktop の動き（前回の検証は別の保存先に置いた）。Desktop の読み込みはログイン中のアカウントのフォルダだけなので、表示には影響しない見込み。初回の統合起動で、サイドバーの表示・続きの追記・⌘Q 後の書き戻しを確かめる。

## グループ（0.29.2、Codex と検討）

- 手動グループは会話の記録ではなく `claude_desktop_config.json` の `preferences.epitaxyPrefs["dframe-group-scopes"]["<account>/<org>"]`（`groups`・`assignments`（`code:<sessionId>` → `cg-…`）・`order`）にある。グループ ID はアカウントごとに違う。サイドバーの `dframe-code-sections` の `members` は `assignments`/`order` から作られる派生状態。
- 実データでは kamihicouki（cb1e）だけが手動グループを持つ。ppb（50e8）の「canban」は作業フォルダによる自動のまとまり。
- Desktop は起動時に設定ファイルを IPC で読み、変更のたびに書く。`code:local_*` の割り当てはサーバー同期（`/api/claude_code/organizations/<org>/user_settings`）の対象外。
- Desktop は localStorage の `dframe-store` にも同じ状態を持ち、起動時に設定ファイルと混ぜる。同じキーは cache が勝ち（`{...prefs, ...cache}`）、設定ファイルから消した割り当ても cache から戻る。
- そのため、統合時に割り当てを足すだけにし、書き戻しでは消さない。足す先は、元の手動グループの名前、なければ作業フォルダの名前（`projectName`）と一致するログイン中のアカウントのグループ（一意のとき）。既に割り当てがあれば触らない。cache に古い値があればそちらが表示される。
- 残った割り当ては、会話がなければ表示されない。ただし `order` に残り、同名グループの選択・空グループの一時保持・統計の件数に数えられる（Codex による配布コードの確認）。
- 設定ファイルは MCP の設定も含むため、書くのは Desktop の停止中（`ps` の失敗は起動中扱い）、読み書きで1バイトも変わらないとき、ログイン中のアカウントのグループ以外が同一のときだけ。書き換え直前にハッシュを再確認する。

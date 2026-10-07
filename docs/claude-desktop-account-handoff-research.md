# Claude Desktop で実行アカウントを維持する引き継ぎ

調査日: 2026-10-07（JST）

## 結論

CLI の `CLAUDE_CONFIG_DIR` を替えるだけでは、Claude Desktop の実行アカウントは切り替わらない。Desktop は自身のログインから取得した OAuth を embedded Claude Code に渡す。選択したアカウントで Desktop を使うには、Desktop 自身のログイン済みプロファイルを選ぶ必要がある。

この Mac には `Claude Profiles.app` と、既にログインを分離した `Claude-Profiles/main`・`ppb` がある。既存の `~/Library/Application Support/Claude` の symlink は `main` を指す。Desktop が停止しているときに、この既存 symlink の行き先だけを選択済みプロファイルへ替えれば、通常の Desktop 起動でもそのプロファイルを継続できる構造である。データのコピー・移動・認証書き換えは不要。ただし、実際の別アカウント起動とモデル応答は本調査では行っていない。

既存の Desktop セッションは、この環境では両プロファイルから共有履歴を参照できる。従って、切替先から同じ session metadata に到達することを検証できる場合は、元の Desktop セッションの continue link が第一候補になる。CLI セッションの UUID を Desktop に import する経路は、Desktop が探す `projects` 配下に元 transcript がある場合の別の入口である。

## 公式資料が保証する範囲

- CLI の `/desktop` または `claude --desktop --resume <session-id>` は、CLI 会話を Desktop に渡す。`--desktop` での `--resume` は UUID のみで、名前や transcript 絶対パスには対応しない。アカウント・Desktop プロファイルを指定するフラグも説明されていない。[Use Claude Code Desktop / Coming from the CLI](https://code.claude.com/docs/en/desktop#coming-from-the-cli), [CLI reference](https://code.claude.com/docs/en/cli-reference)
- Desktop で `/resume` を使うとローカル CLI セッションを選べる。公式は同じ会話の継続として説明している。稼働中の CLI 会話は Desktop へ移さない。[Use Claude Code Desktop](https://code.claude.com/docs/en/desktop#coming-from-the-cli)
- Desktop の認証は通常 OAuth であり、CLI 向けの `apiKeyHelper`・API key 等を指定しても、Desktop の通常ログインを切り替える入口にはならない。[Authentication / Credential management](https://code.claude.com/docs/en/authentication#credential-management)
- 同じメールアドレスに紐づく個人・Team・Enterprise の切替は Claude のアカウントメニューにある。別メールアドレスの Desktop プロファイルを外部アプリから指定する手順は、確認した公式資料にはない。[Log in to your Claude account](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account)

## インストール済み Claude Desktop の実装

確認対象は `/Applications/Claude.app`、version `2.26454.0`、bundle ID `com.anthropic.claudefordesktop`。認証情報や cookie の中身は読まず、[app.asar](/Applications/Claude.app/Contents/Resources/app.asar) の配布 JavaScript と Info.plist を読んだ。これは現在の配布物の実装根拠であり、公開 API の長期保証ではない。

| 論点 | 配布物で確認した実装 |
| --- | --- |
| 独自 user-data dir | `.vite/build/index.pre.js` は packaged build で `CLAUDE_USER_DATA_DIR` を削除する。開発用の署名付き harness 条件が通る場合を除き、後段の `app.setPath("userData", ...)` まで値は残らない |
| 診断文言 | `index.chunk-BXhe7L9V.js` は独自 dir を無視したとき `signed builds ignore it` と診断する |
| `--user-data-dir` | 独自の対応実装は確認できなかった。Electron の通常フラグが一部のディレクトリを動かすかは実起動未検証。Desktop は通常ディレクトリからの移動を `localPairingDisabledReason = "userData relocated"` として扱うため、正規の profile 切替として採用しない |
| resume deep link | `index.chunk-C31r7VW_.js` の `case Wu.Resume` は `?session=` の UUID を読み、`importCliSession()` を呼ぶ。アカウントや profile の query を読む処理はない |
| import の所属 | `index.chunk-AgchhrPF.js` の `adoptCliSession()` は、その時点の `currentAccountId`・`currentOrgId` を使う。import の途中でアカウントが変わると拒否する |
| embedded CLI の認証 | `getBaseQueryConfig()` が Desktop の OAuth を取得し、セッション環境へ注入する。CLI config dir のログインだけを替えて Desktop の実行アカウントを替える構成にはならない |
| embedded CLI の config root | Desktop の `AP()` は起動環境の `CLAUDE_CONFIG_DIR`、未設定なら `~/.claude` を使う。この値は transcript や設定の参照先になり得るが、Desktop の cookie/login profile を替えるものではない |

アプリを複製して bundle ID を変える、署名を外す、開発用 gate を回避する方式は調査・実装しない。既存の実プロファイルを通常データパス経由で使う方式に限定する。

## CLI transcript の到達先

`index.chunk-S9pfUe-G.js` の `resolveProjectDirForSession()` は、`join(AP(), "projects")` を走査する。通常の新規起動では `~/.claude/projects` が root であり、すべての Canban 登録済み Claude account dir を横断検索するわけではない。

`claude://resume?session=<UUID>` で、profile や transcript の絶対パスを渡す分岐は確認できなかった。従って custom account dir にしか存在しない transcript は、通常の Desktop の UUID import では見つからない。Desktop の起動プロセスに `CLAUDE_CONFIG_DIR` を渡した場合には resolver root が変わる実装だが、既起動アプリへの deep link ではその環境は変わらない。この追加起動方式は実機未検証であり、今回の引き継ぎの既定にはしない。

Desktop source の `local_*` session と CLI の UUID import は別の経路である。元の Desktop metadata が切替先の account/org ディレクトリにあるなら、その metadata を使う continue link を維持する。metadata がないのに「同じアカウントで同じ会話を Desktop に開ける」と扱わず、到達先・transcript・所有情報を検証して拒否する。

## 既存 Claude Profiles の方式

確認したインストールは `/Applications/Claude Profiles.app`、version `1.7.0`、build `36`、bundle ID `dev.local.ClaudeProfiles`。これは Anthropic 公式機能ではなく、既存の第三者 switcher である。公開ソースの確認 commit は `4f5b0b7ccc7da8a627bdab2b2653450ddc0a433e`。

- `claudeprofiles://switch/<name>` が Desktop 切替の入口。`switch-cli/<name>` は別の CLI 選択操作である。[ClaudeProfilesApp.swift:99](https://github.com/ajipurn/claude-profiles/blob/4f5b0b7ccc7da8a627bdab2b2653450ddc0a433e/Sources/ClaudeProfiles/ClaudeProfilesApp.swift#L99)
- Desktop 切替は quit → profile の symlink 選択 → shared history の relink/merge → relaunch の順。入口を呼ぶとアプリ停止や共有履歴整理も伴うため、「停止時に symlink の行き先だけを替える」操作より変更範囲が広い。[AppState.swift:234](https://github.com/ajipurn/claude-profiles/blob/4f5b0b7ccc7da8a627bdab2b2653450ddc0a433e/Sources/ClaudeProfiles/AppState.swift#L234)
- `activeProfile()` は default symlink の実際の行き先から選択名を読む。`pointClaudeDir()` は実ディレクトリを削除・上書きせず symlink を選び直す。[ProfileManager.swift:109](https://github.com/ajipurn/claude-profiles/blob/4f5b0b7ccc7da8a627bdab2b2653450ddc0a433e/Sources/ClaudeProfilesCore/ProfileManager.swift#L109), [ProfileManager.swift:446](https://github.com/ajipurn/claude-profiles/blob/4f5b0b7ccc7da8a627bdab2b2653450ddc0a433e/Sources/ClaudeProfilesCore/ProfileManager.swift#L446)
- shared history は `claude-code-sessions` と `local-agent-mode-sessions` を `_shared-sessions` に集約し、各 account/org を単一 master へリンクする。認証用の cookie や token を移す操作ではない。[README / How it works](https://github.com/ajipurn/claude-profiles/blob/4f5b0b7ccc7da8a627bdab2b2653450ddc0a433e/README.md#L148), [ProfileManager.swift:195](https://github.com/ajipurn/claude-profiles/blob/4f5b0b7ccc7da8a627bdab2b2653450ddc0a433e/Sources/ClaudeProfilesCore/ProfileManager.swift#L195)

この Mac の read-only 検査でも、`main` と `ppb` は上記 2 種類の履歴 tree を同じ `_shared-sessions` へリンクしている。各 account/org のリンクも単一 master に到達する。このため、切替先から元の Desktop metadata を参照できる可能性を、一般論にとどまらずファイル単位で検証できる。

`~/.config/claude-switcher/config.json` には別の旧 switcher の選択値が残っていたが、default symlink の実際の行き先と一致しない。現在の Desktop プロファイルの判定にはその値を使わない。また default symlink が示す profile と、既に稼働中の Desktop が読み込んだ profile は一致を確認する必要がある。

## 実装に使う条件

1. 同じ Desktop profile を開くだけの場合も、選択アカウントの identity と対象 metadata の到達先を確認する。
2. profile を替える場合は Desktop が停止していることを条件とする。稼働中に symlink を替えない。
3. 既存 default symlink が既知の profile root を指し、切替先も既存のログイン済み profile であることを確認する。実ディレクトリや未知のリンクは書き換えない。
4. default symlink だけを atomic に替える。profile 内の認証や会話をコピー・移動・merge しない。これで次回の通常 Desktop 起動も同じ選択を使う。
5. 共有 metadata の実ファイルを切替先 account/org から参照できるなら、同じ native Desktop session を開く。CLI import が必要な場合は `AP()/projects` で実際に解決できることを確認する。
6. 不一致・未ログイン・metadata 未到達・稼働中の場合は明示的に停止し、元のアカウントへ勝手に戻して再開しない。

## 証拠と検証の境界

配布 `app.asar` SHA-256: `9564e806afde6391f5666646827f14ea0ccfabc244ed6fad7dae4329cba9cb17`。主な確認位置は `index.pre.js` の `$Z`/`iQ`、`index.chunk-C31r7VW_.js` の `Zj`/`hR`、`index.chunk-S9pfUe-G.js` の `resolveProjectDirForSession`、`index.chunk-AgchhrPF.js` の `adoptCliSession`/`getBaseQueryConfig`。アプリ更新後はこれらの契約を再確認する。

今回行ったのは公式資料、公開 switcher ソース、配布 app.asar、Info.plist、既存 symlink の読み取り。Desktop の停止・起動、アカウント切替、deep link の送信、認証コピー、モデルへの prompt 送信は行っていない。ファイル構造からの到達可否と、実際の UI 表示・選択アカウントでのモデル応答は別の確認事項である。

## 実装（0.24.2）

- 実行先のCLI home ID・期待するアカウントIDを共有SQLiteの `cards[sessionId].claudeExecution` に保存する。引数を省略した再開と送信でも保存値を使う。CLIプロフィールのログインが変わった場合は実行を拒否する。
- 実行アカウントの選択時、対応する既存Desktopプロフィールがある場合は `server/claude-desktop-profile.mjs` が通常保存先のリンクを原子的に選び直す。同じ保存先であってもDesktop起動中は拒否する。稼働中のプロセスが以前のプロフィールを読み込んでいる可能性を、リンクだけから排除できないためである。
- 対象プロフィールがない・複数ある・通常保存先が移動の必要な実ディレクトリの場合は、CLIの選択だけを保存して理由を表示する。Desktopを開く操作は未確認のアカウントを使わない。
- 既存リンクだけを置換し、データ移動・認証コピー・アプリ終了は行わない。Canbanの同時切替をファイルシステムロックで拒否し、DB保存などの失敗時は、アプリが停止したままかつ外部の切替がない場合にリンクを戻す。
- 元Desktopセッションのmetadataは選択プロフィールのaccount/org配下で実際に読み、native IDが一致することを確認する。CLI importは通常Desktopの `~/.claude/projects` に同じ実ファイルがある場合だけ使う。continue linkでも通常Desktopの参照先が最新のsource transcriptと同じ実ファイルかを確認し、別homeにある新しい会話を古いコピーで再開しない。元会話への到達を確認できなければDesktop起動を拒否する。

カードの「再開」→「実行アカウント」（Alt+a / ⌘K）から選択する。Desktop全体のプロフィール選択は後の操作が優先するため、別カードやClaude Profilesで切り替えた場合は、その選択が通常起動に適用される。セッションごとのCLI選択は独立して残る。

隔離したプロフィールで、通常パスから読み直した選択、同時切替の拒否、起動中の拒否、失敗時の復元、会話metadata/transcript到達確認、DB再接続後の実行先保持をテストした。ブラウザーはdry-runで選択保存・再読み込み・ターミナル再開・送信を検証する。実アカウントでのDesktop起動・OAuth認証・モデル応答、通常mainと登録済みChrome拡張への反映は未実施。

## 0.24.3 の不具合診断（2026-10-07）

このMacは `Claude-Profiles/ppb` と旧 `Claude-ppb` が同じアカウントIDを保持していた。0.24.2は2候補として拒否したが、通常保存先は既に `Claude-Profiles/main` を指している。使用中の同じプロフィール構成内に一致する一意な `ppb` がある場合に限って、それを優先するよう修正した。同じ構成内にも複数候補があれば従来どおり拒否する。旧フォルダーは削除・移動しない。

実ファイルの読み取りで、添付画像にある `Kanban card UI/UX design` の会話metadataと元transcriptを切替先から解決できることを確認した。この検査だけではDesktopの実起動・実行アカウント・モデル応答の成功は示さない。

実データへの適用では、元の `Kanban card UI/UX design` カードのCLI実行先を保存し、停止中の通常保存先リンクを既存 `Claude-Profiles/ppb` へ切り替えた。通常パスを読み直して同じアカウントIDとプロフィールを確認した。認証・履歴を移動せず、旧 `Claude-ppb` も残している。Macがロック中のため、実際のDesktop画面の起動・認証表示・モデル応答は未確認。

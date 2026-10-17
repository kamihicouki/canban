# ローカル配置の契約

このMacの通常repoは `/Users/d/Documents/repo/canban` の1つとする。Codex・Claudeのworktreeは各エージェントの管理場所でよい。アプリが管理するインストールコピーとOS所定の登録ファイルは、それぞれの管理領域を使う。

| repo配下 | 用途 |
|---|---|
| `scripts/` | バージョン管理する起動・ビルド・更新処理 |
| `dist/codex-plugin/` | Git管理ファイルだけから作るCodexプラグインの導入元 |
| `dist/chrome/` | Chrome Main Testに登録する固定ビルド |
| `.local/config.json` | このcheckoutの保存先設定 |
| `.local/data/` | 開発用データ、または既存共有データへの参照 |
| `~/.canban/`（repo外） | 通常ユーザーのSQLite DB、検索索引、実行ログ、アカウントデータ |
| `<Canban保存先>/prompt-images/` | プロンプトの添付画像・アップロード状態。通常は `~/.canban/prompt-images/`。開発・テストは明示した `.local/` 配下 |
| `<Canban保存先>/cache/claude-summaries.json` | Claude の会話ログの要約（題名・最初の依頼・件数・読み終えた位置）。起動時に増えた分だけ読むための控えで、消しても次の一覧で作り直す。会話の本文は保存しない |
| `<Canban保存先>/agent-bridges/` | Codex内のCanban MCPへ接続する一時的な探索レコード。会話・認証情報は保存しない |
| `.local/chrome-main-test/` | 拡張の公開鍵・ID、ビルド記録、更新ロック |
| `.local/backups/` | 配置移行・設定変更前の控え |

`.local/` はGitとMCPBパッケージから除外する。認証情報・実データ・ローカル設定をcommitや配布物に含めない。旧cloneの履歴・未追跡資料・worktreeの作業状態を保持する。

## 保存先

画像添付も各クライアントが接続するCanban保存先に保存する。Chrome・Codex・Claudeの間で別の画像保存先を使わない。SSH接続先で画像のファイル参照が必要な操作は、接続先の `~/.canban-remote/prompt-images/` に画像を転送する。画像を入力欄から外しても保存済みファイルは自動削除しない。

`.local/config.json` は次の内容を使う。相対パスはこの設定ファイルのあるディレクトリを基準に解決する。

```json
{ "dataDirectory": "data" }
```

Chrome拡張だけを使う通常ユーザーのデータも `~/.canban/` に保存する。通常Chrome Native Hostは `CANBAN_CLIENT=canban-chrome` を設定し、保存先は `CANBAN_DATA_DIR`、`~/.canban/` の順で解決する。Git checkoutから起動しても開発設定の `.local/config.json` は読まない。

開発checkoutは `CANBAN_DATA_DIR`、`.local/config.json`、`~/.canban/` の順とする。設定済みファイルが不正な場合は起動を失敗させ、別の空DBへ切り替えない。アプリ管理のインストールコピーはcheckoutの設定を使わず、明示指定がなければ `~/.canban/` を使う。

このMacでは既存の共有実データを `~/.canban/` の実ディレクトリに置き、repoの `.local/data` をそこへの参照リンクにする。旧版の起動中プロセス・アプリ管理のインストールコピー・Codex・Claude・Chromeも同じ実データを使う。隔離した開発・テストデータが必要な場合はrepoの `.local/` 配下に別の保存先を明示する。実ユーザーデータをコピーして複数の稼働DBを作らない。`~/plugins/canban` は通常repoへの互換リンクとし、既存Chrome登録やエージェントの履歴に残るパスを維持する。これらのリンク内に独立したデータやrepoを置かない。新しい設定にはrepoの正規パスを使う。

Codex・Claude・Chromeの保存先を別々に変更しない。保存先を移すときはSQLiteの整合したバックアップを取得し、書き込み中のプロセスを保護してDB・WAL・SHM・ログを一緒に移す。旧JSONは自動で再importしない。移行後にDBの整合性と同一実体への接続を確認する。

データ移動前にSQLiteの整合したバックアップを `.local/backups/` に取り、対象データを開くCanbanプロセスを一時停止する。DB・WAL・SHMを同じディレクトリごと移動し、inodeと整合性、各クライアントの参照先の一致を確認して再開する。失敗時は配置を戻し、停止したプロセスを再開する。

## Claudeのマルチアカウント

Canbanから追加するClaudeアカウントは `<Canban保存先>/accounts/claude/<プロフィールID>/` に専用の設定フォルダーを持つ。ログイン・送信・ターミナルでの再開は、そのフォルダーを `CLAUDE_CONFIG_DIR` に指定する。親プロセスのAPIキー・認証トークン・接続先の指定は引き継がない。認証はClaude CLIの設定フォルダー内の認証ファイル、macOSでは設定フォルダーごとに分かれたKeychain項目に保存し、ボードのSQLiteには保存しない。

認証更新はClaude Code 2.1.285と共通の `<設定フォルダー>/.oauth_refresh.lock` と `<設定フォルダーの実パス>.lock` を、保存は `.storage-write.lock` を使って直列化する。別アカウントのフォルダーは並行して使える。同じフォルダーの別名・別Canbanプロセス・Claude CLIは共通のロックに従う。待機中はロックを奪わず、取得後に認証を読み直す。所有権を失った処理は保存せず、更新された認証情報で古い取得結果を上書きしない。

ロックは認証情報を含まない一時ディレクトリで、処理中に更新し、終了時に自分が所有するものだけを外す。Claude CLIの失効判定と同じ時間を過ぎたロックは回収する。既存のプロフィール、保存先、Keychainの項目は更新処理で統合・移動しない。通常のClaude CLIも専用アカウントを使う場合は、同じ `CLAUDE_CONFIG_DIR` を指定する。

Claude のセッションごとの実行先は共有SQLiteのカード属性 `claudeExecution` にCLI home IDとアカウントIDだけを保存する。Chrome・Codex・Claudeからの再開と送信はこの選択を使い、認証情報は保存しない。キューは追加時の実行先を保持する。標準の `~/.claude` を選ぶ場合は `CLAUDE_CONFIG_DIR` を外し、通常の `~/.claude.json` と標準Keychain項目を使う。明示的な設定フォルダーでは従来どおり同変数を指定する。0.24.3以降は実行前に公式 CLI の `auth status --json` を同じ認証環境で読み、未ログイン・メールや組織の不一致を拒否する。

macOS の Desktop はCLIとは別のログインを使う。このMacの Desktop は素の構成（ピュア構成）にする。保存先は `~/Library/Application Support/Claude` の実ディレクトリ1つだけで、アカウントごとの会話はその中の `claude-code-sessions/<accountId>/<orgId>/` に実ファイルとして置く。同時に操作するログインは1つとする。認証保持の実機確認が完了した構成では、停止中に登録済みの保存先を入れ替え、通常切替でのログアウト・再ログインを不要にする。未確認の構成では標準の保存先を維持する。`Claude-Profiles`・`Claude-*` のプロフィール、保存先のリンク、アカウント間の共有リンクは使わない。Claude Profiles.app も使わない。移行と戻し方は [claude-desktop-pure-layout-plan.md](claude-desktop-pure-layout-plan.md) と `scripts/desktop-pure-migrate.mjs` を参照。

ほかのアカウントの会話は、Desktop を終了した状態で Canban から開くと、ログイン中の Desktop にまとめて表示する（統合サイドバー、`server/claude-desktop-guests.mjs`）。ほかのアカウントの記録を `🔗 <アカウント> · ` を付けたゲストとしてログイン中のアカウントのフォルダへ複製し、ユーザーの ⌘Q の後に元の記録へ進行を書き戻してゲストを消す。台帳と会話記録の退避（APFS clone）は `~/.canban/desktop-integrated/` に置く。仕組みと実機検証は [claude-desktop-integrated-sidebar-research.md](claude-desktop-integrated-sidebar-research.md) を参照。

旧来のプロフィール切替（0.24.2〜0.27）は廃止した。0.29以降の管理下切替は、同一ファイルシステムの実ディレクトリ・停止確認・共通ロック・バックアップ・台帳・実機受け入れのすべてを満たす場合だけ使用する。リンクの切替はしない。Desktop で開くのはログイン中のアカウントの会話だけで、それ以外は理由を返し、CLI での実行かログインの切り替えを案内する。起動中の Desktop は、ログイン中の保存先を開いていることを確認できた場合だけ使う。ボードは保存先内の全アカウントの会話を表示する。

0.24.4以降、実行アカウント一覧はアプリバー・サイドバーと同じアカウントID単位にまとめ、CLI設定フォルダーは各アカウントの「接続設定を指定」に残す。保存済みhome IDは受動的な表示や同じアカウントの再選択で変更しない。

### Desktop のアカウント対応表（0.29.24、起動経路への接続前）

`server/claude-desktop-accounts.mjs` は、このMacの標準Desktop保存先をアカウントIDと対応付ける。対応表は `<Canban保存先>/desktop-accounts/claude/registry.json`（600）、管理ディレクトリは700で保存する。登録には標準保存先の実ディレクトリ・所有者・同一ファイルシステム・ログイン中アカウントの一致が必要で、認証情報は対応表へコピーしない。CLIの認証・履歴・キュー・Keychainを変更しない。読取り専用の `server/claude-desktop-roots.mjs` は切替サービスやCLIアカウントのモジュールに依存しない。

この段階では登録サービスを通常のUIやDesktop起動へ接続せず、保存先の入替えも行わない。既存の起動経路と上記ピュア構成の契約は維持する。切替機能の有効化には、別途、復元・同時実行・実機の認証保持の検証が必要となる。

0.29.25 の内部サービスは、明示した切替要求だけを受け、停止確認後に同じファイルシステム内で exclusive rename する。Node.js の通常の rename による空ディレクトリの上書きを避けるため、`server/desktop-files.py` のOS標準APIを使い、未対応OSでは停止する。操作前の `switch.json`（600）に実パス・device/inode・段階を記録し、元に戻すか切替済みの状態を確定する。外部で作られた保存先は消さない。切替とゲストの配置・書戻し・watcherは `<Canban保存先>/desktop-accounts/claude/lifecycle.lock` を共有する。新しい開始要求はロックを取り直し、処理内部のゲスト復元だけが既に取得した権限を再利用する。この内部処理も、通常の開始経路へはまだ接続していない。

0.29.26 では初回接続の候補を `registry.pending` に保持し、期待アカウント・元のプロフィール・操作IDだけを記録する。候補は登録済みプロフィールではなく、Desktopが想定したアカウントでログインしたことを確認してから登録する。取消しは候補を退避して元のプロフィールを戻し、候補のデータを消さない。初回接続中も、登録済みの退避プロフィールから元のカードIDと所有者を読み取る。対応表の変更は世代を確認して即座に読み直し、古いパスのキャッシュだけで会話を別アカウントへ付け替えない。同じCLI会話IDに異なるDesktop所有者がある場合は、Desktopでの再開を止めて確認を案内する。

Desktop起動の子プロセスには `CANBAN_*` に加えてCLIの認証・接続先の上書き（`ANTHROPIC_*`・`OPENAI_*`・`CLAUDE_CODE_OAUTH_TOKEN`・`CLAUDE_CODE_USE_*`・`CODEX_ACCESS_TOKEN`・`CODEX_API_KEY`）、`CLAUDE_CONFIG_DIR`・`CODEX_HOME` を渡さない。親CLIの環境・認証ファイル・キューは変更しない。対応表の保存先に `.local/data` のような参照を使う場合は実パスへ解決して共通ロックを取得する。Desktopの標準保存先と管理下の子ディレクトリのsymlinkは禁止のままとする。

## ローカルmainとChrome更新


Claude Desktop の拡張は `update:local` では更新されません。通常mainから `npm run pack:mcpb` で `dist/canban.mcpb` を生成し、Desktopの拡張設定で既存のCanbanを更新します。MCPBも `dist/codex-plugin/` のコミット済みGit管理ファイルだけを使い、`.local/` と未追跡資料を含めません。インストールコピーのmanifestと保存先を読み戻し、更新を確認します。アプリ管理キャッシュを手編集しません。

```sh
cd /Users/d/Documents/repo/canban
npm run update:local
```

更新元はcommit済みのlocal `main`。`npm run build:plugin` は `git archive` から `dist/codex-plugin/` を作り、Codexはこの配布物をコピーする。通常repoをプラグインのコピー元へ直接指定しない。`.gitignore` だけではCodexのコピーから `.local/` を除外できないため、Git管理ファイルだけを配布物へ入れる。personal marketplaceのCanbanの導入元は `./Documents/repo/canban/dist/codex-plugin`（marketplace rootは `/Users/d`）とする。`update:local` はプラグイン配布物、Chromeビルド、プラグインの再導入を順に実行する。remote mainへの取込みは別操作とし、このコマンドではpullしない。`.local/chrome-main-test/config.json` に保存した `publicKey` と `extensionId` を維持し、接続先は `com.kamihicouki.canban_main_test` とする。Main Testの保存先はcheckoutの設定から解決して `CANBAN_DATA_DIR` で明示する。

完了条件はpackage・MCP manifest・Codex plugin・登録先Chrome manifestのバージョン一致、ソースとビルドの一致、拡張IDとNative Hostの維持。Chromeで再読み込みする。インストール済み旧版MCPプロセスが残る場合は、次回そのホストを再接続したときに更新される。アプリのキャッシュを開発repoとして編集しない。

## Chrome Native Hostの実行ファイル

Codexが保持中のセッションの履歴操作は、Codexから起動されたCanban MCPがApp Toolsに実行を依頼する。MCPはCodexが指定した署名済みNodeを優先し、`CODEX_APP_TOOLS_PIPE_PATH`・`CODEX_MCP_NODE_PATH`・`CODEX_THREAD_ID`を引き継ぐ。Chrome Native Hostはこの接続口へ直接アクセスせず、同じCanban保存先の`agent-bridges/`から選択したCodex homeと一致するCanban MCPを探す。ブリッジはアーカイブ・復元だけを受け付け、対象を本体で確認して実行中・入力待ちを拒否する。削除は所有者によるアーカイブの後にCodexの削除APIを呼ぶ。

探索レコードは権限600、Unixソケットは権限700の一時ディレクトリに権限600で作り、MCPの終了時に除去する。終了異常による古いレコードは接続確認で無視する。プラグイン再導入後も旧MCPが動作している場合は、CanbanのMCP接続を再接続する。保持されていないセッションと追加アカウントの履歴には、選択したhomeで起動するCodex App Serverを使う。

macOSのDocuments保護により、Chromeの子プロセスはDocuments内のrepoを読み取れない場合がある。ホストはrepoを直接起動せず、macOSでは `~/Library/Application Support/Canban/native-hosts/<host名>/`、Linuxでは `${XDG_DATA_HOME:-~/.local/share}/canban/native-hosts/<host名>/` のアプリ用配布物を起動する。OSのアクセス権を広げる必要はない。

Main Testの更新はcommit済みmainを `git archive` でコミット別ディレクトリへ配布し、そのランチャーを登録する。`.git`、`.local`、未追跡資料は配布しない。旧コミットの実行ファイルは起動中プロセスのため保持する。拡張の登録先は引き続きrepoの `dist/chrome`。ビルド記録に実行ファイルの保存先も記録する。

ストア版は既存の `com.kamihicouki.canban` を使い、Main Testとは別の実行ファイル・登録を持つ。通常版の `npm run install:chrome-native-host -- --extension-id <拡張ID>` も実行ファイルを配布し、以降の更新時は再実行する。Gitのない連携ソフトではプログラムに必要なファイルだけをコピーする。両ホストのデータは同じ `~/.canban/` を参照し、Main Testへの明示した保存先は維持する。追加の旧テストホストは有効なworktreeを参照する限り保持する。

## 個人用Slackの認証情報

0.24.0以降、個人用Slackの認証情報は同じCanban保存先の `slack/credentials.json` に保管する（0600、親ディレクトリ0700）。通常Chromeは `~/.canban/slack/credentials.json`、明示した `CANBAN_DATA_DIR` がある場合はその配下を使う。SQLiteには認証情報を入れない。ビルド・Git管理ファイル・共有UI状態に含めない。開発・テストは `.local/` またはテスト用の隔離ディレクトリに保存し、通常利用の認証情報をコピーしない。設定は [Slack接続手順](slack-setup.md)を参照する。

### アカウント保存先の識別と移動（0.24.6）

Canbanで追加した接続設定は管理UUID（設定レコード、または既存の管理マーカー）で識別し、保存先を移動しても実行先の選択を保持する。その他の接続設定はエージェントと絶対パスのハッシュで識別する。旧名が一意であれば読み取り時に互換解決し、同名が複数ある旧IDは選び直す。Claudeの管理保存先移動では保存済みの一意な旧IDも同じDB更新でUUIDへ移す。

Codexの管理保存先を移動した後は旧パスから新パスへの互換リンクを残す。既存のstate DBやrolloutの絶対パスを変更せずに読むため、リンクを削除しない。複数回移動しても過去のパスを辿れる。DBへの保存失敗時は今回のリンクを除去してフォルダーを元へ戻す。

CLIの選択保存とDesktopへの適用は別の結果として返す。Desktop起動中・切替中・適用不可でもCLIの選択は保存される。適用待ちはDesktopを終了した後の再開操作で適用する。起動中のDesktopには、開いているファイルのinodeと保存先が一致するプロフィールを確認できた場合だけ同じアカウントの再開を許可する。

## セッションの開始結果（0.29.9）

開始リクエストの重複防止記録は、各クライアントが選んだCanban保存先の `launches/<clientRequestId>.json` に権限600で保存する。通常Chrome・MCPは `~/.canban/launches/`、明示した `CANBAN_DATA_DIR` ではその配下、テストは隔離ディレクトリを使う。認証情報は含めず、依頼の指紋と起動結果を記録する。OSへの依頼前に記録を予約し、プロセス終了や応答切断で結果が不明な場合も自動で再起動しない。タスクカードを伴わない開始でもこの記録を使う。

### Desktop の実機受け入れとバックアップ

試行は `scripts/desktop-account-trial.mjs plan` でアカウント・操作・復元先を先に確認する。`apply --apply --plan <保存した計画>` と `rollback --apply --plan <保存した計画>` は人が承認した計画でだけ実行する。自動終了・強制終了はしない。停止した実プロフィールを `<Canban保存先>/desktop-backups/<要求ID>-<生成値>/`（700）へコピーし、`backup.json`（600）へ元の保存先を記録する。KeychainとCLIは動かさない。`verify` は読取り専用で、アカウントIDの一致をOAuth有効性の証明にしない。

`desktop-capabilities.json` は実機の受け入れ記録で、ツールから書き込めない。アプリのbuild署名と、3往復・再ログイン0回・ログアウト0回・CLI/Desktopの会話と下書き保持を確認した記録が一致する場合だけ、通常UIの切替を有効にする。fixtureの成功だけでは作成しない。アプリ更新で記録が古くなれば再び無効にする。

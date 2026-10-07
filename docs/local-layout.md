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

Claude のセッションごとの実行先は共有SQLiteのカード属性 `claudeExecution` にCLI home IDとアカウントIDだけを保存する。Chrome・Codex・Claudeからの再開と送信はこの選択を使い、認証情報は保存しない。キューは追加時の実行先を保持する。

macOS の Desktop はCLIとは別のログインを使う。0.24.2以降、ログイン済みの `Claude-Profiles/*` / `Claude-*` と通常の `Claude` 保存先リンクがある場合、そのリンクだけをアプリ停止中に原子的に切り替える。フォルダー・認証・履歴は移動・統合しない。通常の Desktop 起動はこのリンクを参照するため選択が残る。切替はDesktop全体へ適用され、別のカードでの選択や外部プロフィール切替は後の選択が優先する。保存先が通常のディレクトリ、対象プロフィールがない、複数ある場合はCLIの選択だけを保存して理由を返す。Desktop の会話を開く操作は、不一致・未確認を拒否する。

## ローカルmainとChrome更新

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

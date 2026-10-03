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

## ローカルmainとChrome更新

```sh
cd /Users/d/Documents/repo/canban
npm run update:local
```

更新元はcommit済みのlocal `main`。`npm run build:plugin` は `git archive` から `dist/codex-plugin/` を作り、Codexはこの配布物をコピーする。通常repoをプラグインのコピー元へ直接指定しない。`.gitignore` だけではCodexのコピーから `.local/` を除外できないため、Git管理ファイルだけを配布物へ入れる。personal marketplaceのCanbanの導入元は `./Documents/repo/canban/dist/codex-plugin`（marketplace rootは `/Users/d`）とする。`update:local` はプラグイン配布物、Chromeビルド、プラグインの再導入を順に実行する。remote mainへの取込みは別操作とし、このコマンドではpullしない。`.local/chrome-main-test/config.json` に保存した `publicKey` と `extensionId` を維持し、接続先は `com.kamihicouki.canban_main_test` とする。Main Testの保存先はcheckoutの設定から解決して `CANBAN_DATA_DIR` で明示する。

完了条件はpackage・MCP manifest・Codex plugin・登録先Chrome manifestのバージョン一致、ソースとビルドの一致、拡張IDとNative Hostの維持。Chromeで再読み込みする。インストール済み旧版MCPプロセスが残る場合は、次回そのホストを再接続したときに更新される。アプリのキャッシュを開発repoとして編集しない。

## Chrome Native Hostの実行ファイル

macOSのDocuments保護により、Chromeの子プロセスはDocuments内のrepoを読み取れない場合がある。ホストはrepoを直接起動せず、macOSでは `~/Library/Application Support/Canban/native-hosts/<host名>/`、Linuxでは `${XDG_DATA_HOME:-~/.local/share}/canban/native-hosts/<host名>/` のアプリ用配布物を起動する。OSのアクセス権を広げる必要はない。

Main Testの更新はcommit済みmainを `git archive` でコミット別ディレクトリへ配布し、そのランチャーを登録する。`.git`、`.local`、未追跡資料は配布しない。旧コミットの実行ファイルは起動中プロセスのため保持する。拡張の登録先は引き続きrepoの `dist/chrome`。ビルド記録に実行ファイルの保存先も記録する。

ストア版は既存の `com.kamihicouki.canban` を使い、Main Testとは別の実行ファイル・登録を持つ。通常版の `npm run install:chrome-native-host -- --extension-id <拡張ID>` も実行ファイルを配布し、以降の更新時は再実行する。Gitのない連携ソフトではプログラムに必要なファイルだけをコピーする。両ホストのデータは同じ `~/.canban/` を参照し、Main Testへの明示した保存先は維持する。追加の旧テストホストは有効なworktreeを参照する限り保持する。

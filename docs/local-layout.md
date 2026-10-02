# ローカル配置の契約

このMacの通常repoは `/Users/d/Documents/repo/canban` の1つとする。Codex・Claudeのworktreeは各エージェントの管理場所でよい。アプリが管理するインストールコピーとOS所定の登録ファイルは、それぞれの管理領域を使う。

| repo配下 | 用途 |
|---|---|
| `scripts/` | バージョン管理する起動・ビルド・更新処理 |
| `dist/codex-plugin/` | Git管理ファイルだけから作るCodexプラグインの導入元 |
| `dist/chrome/` | Chrome Main Testに登録する固定ビルド |
| `.local/config.json` | このcheckoutの保存先設定 |
| `.local/data/` | 共有SQLite DB、検索索引、実行ログ、アカウント保存先 |
| `.local/chrome-main-test/` | 拡張の公開鍵・ID、Native Hostランチャー、ビルド記録 |
| `.local/backups/` | 配置移行・設定変更前の控え |

`.local/` はGitとMCPBパッケージから除外する。認証情報・実データ・ローカル設定をcommitや配布物に含めない。旧cloneの履歴・未追跡資料・worktreeの作業状態を保持する。

## 保存先

`.local/config.json` は次の内容を使う。相対パスはこの設定ファイルのあるディレクトリを基準に解決する。

```json
{ "dataDirectory": "data" }
```

保存先の優先順位は `CANBAN_DATA_DIR`、Git checkoutの `.local/config.json`、`~/.canban` の順とする。設定済みファイルが不正な場合は起動を失敗させ、別の空DBへ切り替えない。

このMacでは `~/.canban` をrepoの `.local/data/` への互換リンクにする。旧版の起動中プロセス・アプリ管理のインストールコピーも同じ実データを使う。`~/plugins/canban` は通常repoへの互換リンクとし、既存Chrome登録やエージェントの履歴に残るパスを維持する。これらのリンク内に独立したデータやrepoを置かない。新しい設定にはrepoの正規パスを使う。

Codex・Claude・Chromeの保存先を別々に変更しない。保存先を移すときはSQLiteの整合したバックアップを取得し、書き込み中のプロセスを保護してDB・WAL・SHM・ログを一緒に移す。旧JSONは自動で再importしない。移行後にDBの整合性と同一実体への接続を確認する。

## ローカルmainとChrome更新

```sh
cd /Users/d/Documents/repo/canban
npm run update:local
```

更新元はcommit済みのlocal `main`。`npm run build:plugin` は `git archive` から `dist/codex-plugin/` を作り、Codexはこの配布物をコピーする。通常repoをプラグインのコピー元へ直接指定しない。`.gitignore` だけではCodexのコピーから `.local/` を除外できないため、Git管理ファイルだけを配布物へ入れる。personal marketplaceのCanbanの導入元は `./Documents/repo/canban/dist/codex-plugin`（marketplace rootは `/Users/d`）とする。`update:local` はプラグイン配布物、Chromeビルド、プラグインの再導入を順に実行する。remote mainへの取込みは別操作とし、このコマンドではpullしない。`.local/chrome-main-test/config.json` に保存した `publicKey` と `extensionId` を維持し、接続先は `com.kamihicouki.canban_main_test` とする。保存先は上記の共通設定から解決する。

完了条件はpackage・MCP manifest・Codex plugin・登録先Chrome manifestのバージョン一致、ソースとビルドの一致、拡張IDとNative Hostの維持。Chromeで再読み込みする。インストール済み旧版MCPプロセスが残る場合は、次回そのホストを再接続したときに更新される。アプリのキャッシュを開発repoとして編集しない。

ストア版は既存の `com.kamihicouki.canban` を使う。両ホストの起動先は正規repoを参照し、データは共有する。追加の旧テストホストは有効なworktreeを参照する限り保持する。

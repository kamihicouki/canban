# 配置と共有データ

- このMacの通常repoは `/Users/d/Documents/repo/canban` に集約する。Codex・Claudeのworktreeは各エージェントの管理場所を使う。
- 更新処理は `scripts/`、ビルドは `dist/`、開発・テスト用の設定・データ・バックアップはGit管理外の `.local/` に置く。
- Chrome拡張だけを使う通常ユーザーのデータは `~/.canban/` に保存する。通常Chromeはcheckoutの `.local/config.json` を使わず、明示した `CANBAN_DATA_DIR` のみ優先する。このMacの共有実データも `~/.canban/` に置き、repoの `.local/data` から参照する。
- 配置・導入・保存先・更新手順を変更するときは `docs/local-layout.md` の契約を読み、各クライアントの参照先と実データの一致まで確認する。

# バージョンとローカル拡張

- 軽微な修正を含め、変更ごとに `x.y.z` のバージョンを上げる。
- `package.json`、`manifest.json`、`.codex-plugin/plugin.json` の番号を同じ変更で揃え、`CHANGELOG.md` と `CHROMEWEBSTORE.md` を更新する。
- 変更を検証し、日本語のコミットメッセージでコミットする。
- ローカル `main` への取り込みを依頼された場合は、その checkout からChrome登録済みの`npm run update:local` でGit管理ファイルのみのプラグイン配布物と `dist/chrome` を更新し、Codexへ再導入する。拡張IDとテスト用Native Messaging接続先を維持する。
- 完了前に、登録済みフォルダーのmanifestの番号とソース・ビルド内容の一致を確認する。別worktreeでのビルドだけではローカル拡張への反映は完了していない。

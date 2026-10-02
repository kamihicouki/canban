# バージョンとローカル拡張

- 軽微な修正を含め、変更ごとに `x.y.z` のバージョンを上げる。
- `package.json`、`manifest.json`、`.codex-plugin/plugin.json` の番号を同じ変更で揃え、`CHANGELOG.md` と `CHROMEWEBSTORE.md` を更新する。
- 変更を検証し、日本語のコミットメッセージでコミットする。
- ローカル `main` への取り込みを依頼された場合は、その checkout からChrome登録済みの固定フォルダーへ再ビルドする。拡張IDとテスト用Native Messaging接続先を維持する。
- 完了前に、登録済みフォルダーのmanifestの番号とソース・ビルド内容の一致を確認する。別worktreeでのビルドだけではローカル拡張への反映は完了していない。

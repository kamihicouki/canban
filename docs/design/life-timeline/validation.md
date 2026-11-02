# 保存資料の検証

2026年10月30日。今回の変更はスケッチ・用語・実装提案の保存と、リポジトリ規約に従った0.29.54への番号更新であり、lifeの実行コードやDB移行は追加していない。

- 保存したPNG6枚は、生成原画像とSHA-256が一致した。原寸・原内容を保持している。
- Markdownのローカルリンクと画像参照は存在確認済み。`git diff --check`は成功した。
- `package.json`、`manifest.json`、`.codex-plugin/plugin.json`、検証用Chrome manifestは0.29.54で一致した。検証用 `board.js` は同版の `boardHtml()` から組み立てた内容と一致した。
- `npm test` は716件中714件成功、2件失敗。`source-model.test.mjs:73` のカード取得と、`tools-list.test.mjs` の終了時の一時ディレクトリ削除（ENOTEMPTY）が失敗した。
- この2ファイルだけを再実行すると12件中11件成功。tools-listは通過し、source-modelだけが同じエラーになった。
- 変更前HEADを `.local/life-timeline-review/baseline/` へ展開して同じ2ファイルを実行した結果も12件中11件成功で、source-modelの同じ失敗を再現した。fixtureは9月の固定時刻、通常ボードの既定期間は30日であり、10月30日時点では対象カードが表示範囲から外れる。今回の資料保存とは独立した既存の失敗として残した。

検証用ビルドは `.local/life-timeline-review/chrome/` に分離した。通常ビルドが一度固定登録先 `dist/chrome/` を書き換えたため、登録台帳にある0.29.52のスナップショット `a707be150e30bbb0b6fa3f1ab8ad852a202902c7` から固定登録先を再生成して戻した。公開鍵からの拡張ID一致とテスト用Native Messaging接続先を確認した。Chromeのリロード、プラグインの再導入、mainへの取り込みは実行していない。

UIの実装変更がないため、新機能のブラウザースモークや性能受け入れは今回の検証に含めていない。構想画は実装済み画面のスクリーンショットではない。

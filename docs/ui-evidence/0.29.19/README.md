# 手順の開始番号を維持

1280×800、隔離Chrome、架空の63メッセージ。本文は「3. 変更内容を確認する / 4. 検証結果を読んでから反映する」です。

変更前は1・2、変更後は3・4。ユーザー本文と応答本文の開始番号、原文、下書き、読む位置、i/Esc、閉じて開く操作、タスク説明の原文保持を確認しました。

- npm test: 509成功、失敗0。
- node --test tests/board-smoke.browser.mjs: 成功。
- tests/markdown-preview.browser.mjs: 成功。
- 既存レイヤー2の本文表示のみ。新しい操作・キー・設定・権限はありません。

`metrics.json`の本文利用可能までの値は各経路1回の観測です。キャッシュや同時負荷が異なるため、改善速度の評価には使用しません。

登録済み拡張の更新・reloadやストア公開の証拠ではありません。Playwrightの導入先をCANBAN_PLAYWRIGHT_PACKAGE、撮影先をCANBAN_MARKDOWN_SHOTSに指定してブラウザー試験を再実行できます。

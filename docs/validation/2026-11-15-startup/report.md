# 起動前のカテゴリ参照エラーと検証工程の修正

対象: ユーザーが報告した登録拡張0.29.90の `Cannot read properties of null (reading 'directories')`。修正版0.29.91。基点origin/main `0c913f3`。productionの変更は含めない。

## 担当と不足していた証拠

前回の実装・コードレビューはCodex、設計と画像によるUI評価はFable 5.2。Fableは登録Chromeを操作したと主張していない。Codexが単体・操作試験・ファイル一致を確認して配布物を更新した一方で、初回取得前の操作と生成Chrome拡張全体の起動を合格条件にしていなかった。

- [従来smoke](https://github.com/kamihicouki/canban/blob/0c913f3/tests/board-smoke.browser.mjs#L687)は、カードと時間の帯が出るまで待ってから操作していた。
- [従来dev-host](https://github.com/kamihicouki/canban/blob/0c913f3/tests/dev-host.mjs#L63)は、インラインUIにwindow.openaiを加える経路。生成したboard.jsを拡張として読み込む経路ではなかった。
- [従来Chrome試験](https://github.com/kamihicouki/canban/blob/0c913f3/tests/chrome-extension.test.mjs#L14)はビルドのmanifest・CSP等とservice-worker単体を確認し、board.js全体の初期化は実行していなかった。
- [従来CI](https://github.com/kamihicouki/canban/blob/0c913f3/.github/workflows/test.yml#L23)は `*.test.mjs` のみ。ブラウザ操作試験はローカル手動確認に留まった。

テスト件数、CI成功、登録ファイルの一致を、登録Chrome上での起動操作の確認と同じものとして扱わない。担当モデルの名称ではこの不足を解決できない。

## 再現と修正

初回の `state.board=null` のまま、表示名クリックまたはp→scopePicker→directoryItems→b.directoriesで同じTypeErrorになる。キャッシュされたカードのカテゴリ変更にも同じ前提があった。未取得と取得失敗は既存toastで案内し、データに依存するピッカーを作らない。正常な空ボードでは従来どおり操作できる。

追加で、更新の失敗がcatchされて通常resolveされるため、rと更新クリックが成功通知を出す不整合を確認した。loadは最新要求の結果をtrue/falseで返し、失敗理由を保持する。取得済みボードのDOMと入力を維持し、成功時だけ成功通知を出す。古い要求の応答を無視し、throwOnErrorは維持する。

提供画像のboard.js:1556は現在の生成物では別の位置だった。元のエラーの記録時刻・読み込み版は画像だけで確定しない。現在ソースで同じエラーを再現したことと分けて扱う。

## 新しい合格条件

実装担当Codexとは別担当のCodexがコードをレビューした。レビュー担当はコードを編集せず、未取得・失敗・空・古い応答・throwOnError・DOM保持を確認し、関連26件を独立実行した。Fableの画像評価はUX評価として位置づける。

生成MV3拡張を隔離Chrome for Testing 157で読み込み、Native Messagingの応答だけを架空の応答に置き換える試験を追加した。実データ・実Native Host・通常Chromeプロフィールは使わない。拡張のHTML/JS/CSSとCSPはビルド出力そのもの。初回応答保留・失敗・再試行・正常空・更新中・更新失敗をクリックとキーで検証し、例外と未処理の拒否を失敗にする。

CIではこの起動試験と従来のboard smokeを必須ジョブで動かし、ブラウザ不在・拡張起動不可をskip成功にしない。リポジトリのAGENTS.mdにも担当区分とゲートを記載した。新しいページ・キー・設定は追加しない。

## 検証記録

- 未取得ピッカーの単体: 修正前3件失敗（同じdirectories TypeError）、修正後4件成功。
- load/更新通知の単体: 修正前4件失敗、修正後5件成功。
- npm test: 922件成功。
- 既存Chrome操作試験: 成功。
- 生成拡張起動試験: 登録済み0.29.90のコピーではクリック／p両方で同じ例外を再現して失敗（2.6秒）。修正後は成功（5.7秒）、未処理例外とconsole.errorは0。主担当も最終生成物を実行し成功した（11.8秒）。所要時間は環境の異なる製品速度比較ではない。
- 独立レビューで、試験コピーのmanifestへ必ずテスト用キーを設定することと、実DOMに一致するピッカー検査を追加修正した。登録先のID・ファイルはこの試験では変更しない。
- [実行条件と生成物SHA256](startup-metrics.json)、[取得中](pending-light.png)、[初回失敗](failed-dark.png)、[更新失敗で画面保持](refresh-failed-light.png)、[回復したボード](recovered-board-dark.png)、[時間軸ライト](recovered-timeline-light.png)、[時間軸ダーク](recovered-timeline-dark.png)。全撮影1280×800、架空データ。
- 初回の必須browser CIは失敗して配布を止めた。setup-chromeのstable指定はLinuxでは通常Chromeのdebを取得し、拡張起動フラグを使えなかった。ローカルと同じCFT157.0.8103.78の具体版指定へ修正し、実行対象を揃える。異常系試験のskipや成功扱いへの変更はしない。
- CIと登録先照合の最終結果は、PRと最新チェックポイントに記録する。

ローカル登録先のビルドとNative読取りの照合は登録Chromeの画面確認とは別。登録済み画面の観測ができない場合は未確認のまま記録する。

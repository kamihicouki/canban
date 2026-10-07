# Claude の別アカウントでの同一セッション再開

調査日: 2026-10-07。公式ドキュメントと、この Mac にインストール済みの Claude Code 2.1.285 の `--help` / `--version` を確認した。認証・会話ファイルは変更せず、モデルへのプロンプトも送信していない。

## 結論

別アカウントでローカル会話を再開する際に、以前の組織の思考だけが利用できなくなることは想定された動作である。添付画像の通知だけでは、認証の切替失敗や会話の再開失敗とは判断できない。原本の会話を改変せず、選択した認証で同じ transcript を `--resume` する方法を優先する。

公式の [Preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking#thinking-blocks-stay-with-the-account-that-produced-them) は、Sonnet 5.5 の思考を別アカウントが送信した場合、そのブロックを API が除外し、リクエスト自体は成功すると説明している。思考の再利用範囲が変わるので、次の応答では再推論に時間やトークンが必要になり得る。ユーザー・assistant の本文やツール履歴、ディスク上の原本を消す必要はない。組織 ID や署名を偽装する方法は採用しない。

同ページは Claude Code / Agent SDK がリクエストを組み立てる場合には独自対応が不要とも説明している。独自に transcript の一部分だけを書き換えると、別途 prefix binding の不整合を引き起こす可能性がある。

## 再開コマンドの意味

[CLI reference](https://code.claude.com/docs/en/cli-reference#cli-flags) の現在の仕様では、`--resume` は session UUID / 名前に加え、会話 `.jsonl` の絶対パスを受け取る。`--fork-session` は新しい ID に分岐する指定なので、同一 ID が要件なら付けない。`--session-id` だけでは履歴をロードする操作の代わりにならない。

設計上の推奨コマンドは、会話が最後に使った cwd で、選択済み CLI 設定ディレクトリを指定し、原本 transcript の絶対パスを `--resume` に渡す形である。会話中に main から worktree へ移った場合、最初の cwd に戻すと最新ブランチと作業フォルダーが食い違う。認証を上書きする API キー・OAuth 環境変数が残っている場合は除外し、起動前の `claude auth status` で選択アカウントを照合する。パスから session ID を確実に復元することと、その後の保存先が同じ会話へ継続することは、実装側で別々に確認する。

[Settings](https://code.claude.com/docs/en/settings#settings-files) によると `CLAUDE_CONFIG_DIR` は認証以外にも settings・履歴・plugins の格納先を変える。したがって、別アカウントの設定ディレクトリに切り替えて UUID だけで検索すると、元の履歴が見つからない／別コピーを拾うリスクがある。全設定や全履歴のコピー・移動ではなく、実行アカウントと正規の transcript の参照を分離する。

## Desktop と CLI

[Desktop の CLI 比較](https://code.claude.com/docs/en/desktop#coming-from-the-cli) は、CLI の会話を `/desktop` または `claude --desktop --resume <session-id>` で Desktop に移せると説明している。会話とコンテキストを引き継ぎ、同じセッションとして継続するため、その後 CLI の `--resume` からも見つかる。ただし `--desktop --resume` に使えるのは UUID だけで、名前・transcript 絶対パスは使えない。また別 terminal で開いている／background で実行中の会話は移行できない。

Desktop に session を渡す前に、選択 Desktop アカウントと CLI アカウントを照合し、既存 worker が停止しているか確認する。Desktop の通常起動後にも選択アカウントが維持される既存対策は、会話 ID の保証とは別の検証項目になる。独自の `claude://` URL を成功判定にせず、公式コマンドの対応条件・終了結果と、実際に開いた session UUID / cwd を確認する。

現在の公式 Desktop 文書は、Desktop から別 surface へ移す「Open in」には Cloud への要約移行も示している。要約で新しいクラウド会話を作る経路は、今回の「同じローカル ID・履歴・ディレクトリ・ブランチ」の代替にはしない。

## 実装の推奨

1. 正規 session ID、cwd、原本 transcript、選択アカウント・CLI 設定の組を起動計画として固定する。ID が重複した履歴を検出したら、最新らしさだけで選ばず参照先を明示する。
2. 起動前の auth status で実行アカウントを確認する。別 worker が同一会話を実行していたら、同時 writer を増やさず停止・終了を待って再開する。
3. CLI は絶対 transcript パスで `--resume`。Desktop は正規の UUID を公式再開コマンドへ渡す。どちらも `--fork-session` や新規 session 生成を避ける。
4. 組織 bound thinking の通知を失敗や使用量限界と同一視しない。明示的な API エラー・最終 result・現在の進行状態を根拠に成否を表示する。
5. 完了確認では、選択アカウント、同じ session UUID / cwd、ユーザー・assistant・tool 履歴の引継ぎ、新しい応答が同じ原本に追記されること、再起動後も同じ会話が開くことを確認する。自動テストや認証表示だけで実モデルの再開成功を宣言しない。

## 参考となる旧不具合と限界

公式リポジトリの [Issue #16103](https://github.com/anthropics/claude-code/issues/16103) と [Issue #27978](https://github.com/anthropics/claude-code/issues/27978) には、旧バージョンで `CLAUDE_CONFIG_DIR` と resume の検索先が一致しない報告がある。これは利用者の一次報告で、現在の 2.1.285 で同じ不具合がある証拠ではない。グローバルな設定・認証ファイルを削除して symlink に差し替えるという報告中の回避策は、今回の実装方針にしない。

公式 API 文書は思考 block の別アカウント動作を保証するが、Canban が独自に管理する複数 CLI 設定ディレクトリ・Desktop プロファイルの組み合わせまで保証するものではない。そこは起動計画のテストと、ユーザーの実セッションでの再開結果で検証する。

## 実セッションと owning source の確認

添付画像の撮影後も原本 transcript には応答が続いている。実装担当が原本を読み取り確認し、2026-10-07 08:52:40 UTC の組織思考通知後、08:57:09 UTC まで新しい assistant / tool 応答が同一 session UUID に記録され、`end_turn` に至ったことを確認した。したがってこの実セッションでは別アカウントでの応答は成功しており、通知は再開を妨げていない。ユーザーの会話本文・認証情報は本書に転載しない。

別の実不具合として、[Claude source 読み込み](../server/sources/claude.mjs) の `foldSummary` は最初の cwd を採用しながら git branch は最後の値を採用していた。会話が main から既存 worktree へ移った際、Canban の再開計画が古い cwd と最新 branch を組み合わせてしまう。実装は最新の有効な cwd を session の作業先にし、ローカルとリモートの読み込みで同じ規則を適用する必要がある。会話 ID を変更せず、現在作業中の worktree とブランチで再開することが今回の保持要件である。

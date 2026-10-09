# Changelog

## 0.26.6 — 2026-10-09

- Codexが保存したクラウド情報から、dotが作成・関連するセッションを識別し、カード・時間軸・詳細に表示します。dot本体・内部処理・非表示指定の会話は取り込みません。
- dotのセッションは初期状態で非表示。「除く／含める／dotだけ」を絞り込み・保存ビュー・共有UI状態に対応させ、Shift+Vと⌘Kで切り替えられるようにしました。紐づけたタスクカードは非表示にしても残ります。
- クラウドカードはCodexで会話を開けます。状態未取得と保存済み情報の更新時刻を示し、CanbanからのCLI再開・指示送信・キュー・履歴操作は行いません。クラウドへの直接同期や会話本文の取得は追加していません。

## 0.26.5 — 2026-10-09

- **レイアウトの復元**: Trello・定番・レール・オムニバー・ライブ HUD の5種類を「レイアウトと色」と⌘Kから選べるようにしました。選んだ配置は共有 UI 状態の `layout` に保存します。0.26.0以降に保存から失われた選択は自動復元できず、残っている値を再利用します。
- 寿命ごとのカード密度、時間の帯、ボード／時間軸、スレッド型カード詳細を維持します。レイアウトの切替は取得済みカードを再描画し、カードの移動・再取得・既読化を行いません。
- 活動の時間軸は設計プレビュー3案を用意しました。履歴収集・実データ移行はまだ実装していません。
- カードに紐づけたSlack資料が、閉じた「詳細」パネルに入って見えなくなっていた退行（0.26.0）を直しました。タスクカードでは「説明」の下に、セッションでは入力欄の直上に置き、「依頼文に追加」をすぐ使えるようにしました。
- Slack取り込みのブラウザ試験を、0.25以降のカード詳細と0.26.4の接続画面（接続済みでは「ワークスペースを追加・トークンを入れ直す」を開いて入力）に合わせました。

## 0.26.4 — 2026-10-08

- **Slack接続の手順**: 管理「Slack接続」を4ステップの案内にしました。「Slackでアプリを作る」で設定（manifest）入りの作成画面を開き、Slackのどのメニューで何をコピーするかを各ステップに示します。開けないときは設定をコピーして貼り付けられます。
- **トークンの確認**: 入力中に形式を確かめ、Botトークン（xoxb-）や欄の入れ違いをその場で知らせます。逆の欄に貼ったトークンは正しい欄へ移します。接続に失敗したときは、どちらのトークンが、どうして通らなかったか（invalid_auth など）を日本語で示します。
- **接続後の案内**: 接続できたら「読む会話を選ぶ」をすぐ開きます。ワークスペースの状態（受信中・再接続待ち）と次にすることを表示し、接続後は追加用の手順を畳みます。タイムラインの未接続表示から「Slackを接続する」で管理パネルを開けます。
- **DMの相手の名前**: 会話の一覧・タイムラインのDMと送信者を、ユーザーIDではなく名前で表示します（`users:read` を manifest に追加。名前は6時間ごとに1度だけ取得）。権限のない既存のアプリではIDのまま表示し、権限を足して再インストールする手順を案内します。会話の絞り込みはIDでも探せます。
- 「読む会話を保存」で `workspace.trackDrafts is not a function` になり保存後の表示が更新されない不具合を直しました。
- **リンクを開くブラウザ**: Slack接続の「リンクの開き方」で、外部リンク（Slackアプリの設定・PR など）を開くブラウザを選べるようにしました。OSの既定、Chrome（プロファイル指定）、Safari から選べます。開けなかったときは URL をコピーします。

## 0.26.3 — 2026-10-08

- Claude の会話ログ（このMacでは 322MB・59本）を、サーバーの起動のたびに頭から読み直していました。要約と「読み終えた位置」を保存先の `cache/claude-summaries.json` に残し、増えた分だけ読むようにしました。初回の Claude 一覧は 1,028ms から 43ms になりました（0.26.2 と同じ結果）。Codex・Claude Desktop・Chrome がそれぞれサーバーを起動するたびに効きます。
- 要約の控えには会話の本文を入れません。読み取りの層（`server/sources/`）は書き込みを持たないまま、保存は `server/summary-cache.mjs` が受け持ちます。

## 0.26.2 — 2026-10-08

- カードを開いたときの左右の余白の比率の調整（`Alt+[` / `Alt+]`）、キーの案内の移動（`Alt+m`）、初期化（`0`）をやめました。余白はウィンドウの幅で決まり、保存しません。
- キーの案内は右余白の上端に、カードと同じ地のパネルで表示します。ボードの色に関係なく読めます。
- カードが表示領域より広くならないようにしました。1280px の画面で右端がフェードし、閉じるボタンが隠れていた問題を直しました。

## 0.26.1 — 2026-10-08

- 約30万バイト・4,500行の `ui/board.html` を、ページの骨組み（5,643バイト）と責務ごとの部品（`bridge`・`state`・`load`・`board-render`・`popover`・`card-overlay`・`requests`・`realtime`・`lanes`・`sidebar`・`analytics`・`task-detail`・`status`・`resume`・`settings`・`drag`・`search`・`app-bar`・`keyboard`・`boot`・`base.css`・`board.css`）に分けました。組み立て後のコードは、見出しのコメント1行と、作成ボタンの登録位置を除いて同一です。画面と動作は変わりません。
- テストは `ui/board.html` の生の文字列ではなく、組み立て後のページを読むようにしました。骨組みが12,000バイトを超えると失敗します。

## 0.26.0 — 2026-10-08

ムリ・ムダ・ムラを省き、1つの見た目に「時間・空間・情報の寿命」を足しました。検査と評価は [docs/audit-0.26.md](docs/audit-0.26.md)。

- **寿命**: カードは「動いている → 新しい → 今週 → 休眠中（7日以上動きなし）」と段階を移ります。カードの密度は寿命で決まり、動いているカードは計画・「アプリで答える」まで、休眠中は1行で表示します。タスクカード・優先度・期限のあるカードは休眠しません。
- **休眠の折りたたみ**: 休眠中のカードを各リストの末尾に「休眠中 N」として畳みます。動きがあれば自動で上に戻ります。カードの移動・アーカイブはしません。
- **時間の帯**: ボードの上に、寿命ごとの件数・日ごとの棒・休眠の境・期間（7日・30日・90日・全期間）を置きました。段階や日を押すと、その時間のカードを照らします（`Esc` で解除、棒は `←` `→`）。期間の入口はここだけにし、サイドバーの「期間」とアプリバーの「30日以内」チップを外しました。
- **時間軸**: 受信トレイを、同じカードを「要対応・実行中・今日・昨日・今週・今月・それ以前」に並べる表示にしました。アプリバーの切り替えか `i` でボードと行き来します。
- **1つの見た目**: レイアウト5種とコンポーネントのスタイル8項目、カードの高さの選択をやめ、Trello 基調の1種類にしました。「レイアウトとテーマ」は「色」（ライト・ダーク・システム）になりました。レーン内のリストの高さは、サイドバーの「レーン」に移しました。
- **カード詳細の統一**: タスクカード詳細もセッションと同じスレッド型（説明・紐付いたセッション・新しいセッションの開始、属性は詳細パネル `d`）にしました。カード内の部品の並べ替え・列幅・高さ・開閉は撤去し、カードの幅と高さだけを種類ごとに共有します。
- **初回表示**: 応答しない SSH リモートを最大 1.5 秒だけ待ち、届いた時点でボードを描き直します（従来は最大20秒待っていました）。
- **Chrome**: ツールバーのボタンで、開いているボードのタブを前面に出します（タブが増えないように）。権限は追加していません。
- **狭い幅**: Codex のサイドバーを細くしたとき（幅 390〜480px）にアプリバーがはみ出さないよう、表示の切り替え・絞り込みのチップ・実行状況・既読・再読み込みも ⋯ に畳むようにしました。
- `npm run bench` を SQLite の保存先に対応させました。
- `tests/board-smoke.browser.mjs` を追加しました。追加のパッケージなしで Chrome を操作し、ボード・時間の帯・時間軸・カード・シートでページのエラーが出ないことを確かめます。

## 0.25.3 — 2026-10-08

- スレッド詳細の詳細パネルを開くボタンを、アイコンだけから「変更 `f`」「詳細 `d`」の文字とキーを表示したボタンにしました。開いている方は強調します。パネル内の同じ切り替えは外し、入口をヘッダーの1か所にしました。
- カードを開いている間のキーの案内（右余白）を広げました。案内を置く側の余白は表示時に最低216px（狭い画面では幅の32%まで）を確保し、案内は最大240px幅・560px高さまで使います。保存した余白の比率は変えません。

## 0.25.2 — 2026-10-08

- 要素の整理: 「リッチ」カードの「内容を見る」（その場返信と同じ入口）は、その場返信を使わない設定のときだけ表示します。スレッド詳細の詳細パネルの ✕ を外し、ヘッダーの同じボタンで開閉します。
- カードの「最後の返事」から Markdown の記号（見出し・箇条書き・太字・コード・リンク）を取り除いて1行にします。
- 「リッチ」のフッターは折り返して、右端で途切れないようにしました。「コンパクト」はエージェント名の文字を色付きのマーカー（名前はツールチップ）にして、タイトルの幅を広げました。
- 受信トレイの右ペインは、返事を段落・リスト・コードに整形して読めるようにしました（極端に長い返事は途中まで）。

## 0.25.1 — 2026-10-08

- スレッド詳細の先頭に「null」と表示される不具合と、折りたたみ表示のツール要約が空になる不具合を修正しました。
- その場返信を開いたカードで、返信ボタンとタイトルが重ならないようにし、下端のキーのヒントと「カードを開く」を折り返して右寄せにしました。
- レイアウトテーマ5種（Trello・定番・レール・オムニバー・ライブ HUD）で、新しいカードとカード詳細を確認しました。

## 0.25.0 — 2026-10-07

- カードのUI/UXをCodex・Claudeのデスクトップアプリに近づけました。重複する見た目は消さず、「レイアウトとテーマ」の「コンポーネントのスタイル」で、コンポーネントごとに新旧を選べます（⌘Kからも切り替え可）。選んだ値は共有UI状態に保存します。
  - ボードのカード: 現行 / コンパクト / 標準 / リッチ。状態は先頭の記号（実行中は回転、入力待ちは点滅）、実行中の動きは光る1行、変更は +/− で示します。
  - カードのその場返信: カードで `Space` を押すと、開かずに最後のやりとりを読み、返信・キュー追加ができます（`r` で入力欄へ、`Esc` で閉じる）。入力待ちはCanbanから答えられないため、アプリで開く操作を案内します。
  - ボードの表示: ボード / 受信トレイ（要対応・実行中・最近の一覧と、右に会話。`j`/`k` で移動、`Enter` でカードを開く）。
  - カード詳細: スレッド（会話を主役に、属性は右の詳細パネル。`d` で詳細、`f` で変更）/ モジュール（現行）。
  - 会話の表示: 折りたたみ（ツール呼び出しを1行にまとめ、「7m 24s 作業しました」で区切り、編集したファイルを1枚の要約カードに）/ 現行。
  - 入力欄: チップ（添付・スキル・権限・送信を1つの入力欄に。`⌥Enter` でキュー）/ 現行。
  - タスクカード詳細: スレッド（タスクの隣に、選んだセッション1件。上のスレッドの帯で切り替え）/ 現行。
  - 変更のレビュー: 会話の右に、作業フォルダの未コミットの変更（ファイルごとの +/− と差分）。読み取り専用で、ローカルのセッションだけが対象です。
- 新しいツール `canban_get_changes`（UI用）を追加しました。ボードのカードに最後の返事（`last`）と、実行中のセッションのGit変更行数（`git.added` / `git.removed`）を載せます。
- 設定メニューのボタンの選択状態が分かるように、選択中を強調しました。
- 実行中に Codex の許可待ちを Canban から承認する機能はありません（アプリ側でのみ答えられます）。
- 変更の「元に戻す」は、作業フォルダを書き換える操作のため入れていません。
## 0.24.6 — 2026-10-07

- Claude の会話コピーは本文の最新時刻とファイル更新時刻で選び、Desktop の共通時刻で古い履歴を優先しないようにしました。
- 管理する接続設定は不変UUID、その他はパス由来IDで識別します。移動・同名フォルダーの並べ替えで保存した実行先が変わりません。一意な旧IDは互換解決し、曖昧な旧IDは選び直しを求めます。
- Codex の保存先移動は旧パスを互換リンクで維持し、元DBの会話参照を保持します。保存失敗時は移動を戻します。
- 選択した Claude 接続設定の組織で認証を照合し、Codex の再開・指示・ログイン・使用量取得で別アカウントの認証環境を除去します。
- Desktop 起動中でも CLI の選択を保存し、Desktop の適用待ちを既存の再開欄に表示します。起動中の同一プロフィールは開いているファイルの識別情報で確認できる場合に再開できます。
- Desktop の放棄ロックを回収し、生存中の操作は保護します。使用量はアカウントごとの最新サンプルを選び、不明件数はローカルの絞り込み対象と一致させます。
- 操作の入口・キー・レイヤー・Chrome権限は変更しません。修正計画と回帰テストを追加しました。

## 0.24.5 — 2026-10-07

- Claude の会話が途中で worktree へ移動した場合、再開・指示の実行先に最後の作業フォルダーとブランチを使います。ローカルとSSHの読み取りを揃え、子エージェントの作業先は親会話に混ぜません。
- 別アカウントへの引き継ぎ時、過去の思考を再計算する通知が出ても会話履歴を継続できることを再開欄に表示します。会話ID・本文・思考の署名は変更しません。
- Claude Desktop 用 MCPB は通常mainのコミット済みGit管理ファイルから生成し、ローカルの設定・実データ・未追跡資料を配布物に含めません。

## 0.24.4 — 2026-10-07

- Claude の実行アカウントをアプリバー・サイドバーと共通のアカウントIDでまとめます。同じアカウントのCLI設定フォルダーが複数あっても、候補は1件だけ表示します。
- メールとエージェント・対応Desktopプロフィールを短く表示し、設定フォルダーは「接続設定を指定」にまとめます。保存済みの設定・通常Desktopの選択を維持し、元のCLI設定にも戻せます。
- 候補行が縮んで文字が重なる問題を修正し、詳細を開いたポップオーバーもアプリバーの下の画面内に収めます。入口は既存のレイヤー4、Alt+a / ⌘Kです。

## 0.24.3 — 2026-10-07

- Claude の実行アカウント候補と選択ボタンに、エージェント・設定フォルダー・対応する Desktop プロフィールを表示します。同じアカウントの候補も区別して検索できます。
- 標準 CLI の再開で認証領域が変わる問題を修正しました。再開・送信前に CLI の実際のログイン先を確認し、未ログインや別アカウントでの実行を拒否します。
- 現在使っている Claude-Profiles 内の一意な切替先を優先し、同じアカウントの旧 Claude-* フォルダーが残っていても Desktop を切り替えられます。

## 0.24.2 — 2026-10-07

- Claude の実行アカウントをセッション単位で保存し、Chrome・Codex・Claude の再表示と指示送信で共有します。保存後に CLI のログイン先が変わった場合は実行を止めます。
- macOS のログイン済み Desktop プロフィールがある場合、停止中の通常保存先リンクを切り替え、通常起動でも選んだアカウントを維持します。起動中は切り替えず、認証情報・履歴は移動しません。
- 切替先の元会話 metadata または通常 CLI の同一 transcript を確認して Desktop で再開します。到達できない会話は理由を表示し、ターミナルで引き継ぎます。
- 既存の「実行アカウント」ピッカー（レイヤー4・Alt+a / ⌘K）に統合しました。実アカウントでの起動・応答、登録済みChrome拡張への反映は未実施です。

## 0.24.1 — 2026-10-07

- Claude Code の会話・作業フォルダ・ブランチを保ったまま、実行アカウントを選んで再開できます。カードの「再開」にある実行アカウントから選びます。
- 同じ選択をターミナル再開・指示の即時送信・キューに使います。キューに追加したアカウントが変わった場合は実行を止めます。
- CLI の会話ファイル指定とアカウント別設定フォルダを使い、認証情報や会話をコピーしません。実行中・入力待ちの再開とAPI認証の上書きを拒否します。
- 実行アカウントの選択はレイヤー4のピッカー。カード内の Alt+a とコマンドパレットからも開けます。
- 実アカウントのモデル応答・登録済みChrome拡張への反映・ストア申請は未実施です。

## 0.24.0 — 2026-10-06

- 個人用Slackの複数ワークスペースから、選んだ会話をボードのSlackタイムラインに表示できます。タイムラインだけを隠して復帰できます。
- メッセージや返信1件から、内容を編集してタスクカードを作成できます。既存のタスク・セッションカードにも資料を追加できます。
- 紐づけたメッセージの観測した編集・削除を履歴に残します。Slackで削除された保存済み本文も保持し、カードのタイトル・説明は上書きしません。
- 確認した本文・出典・添付リンクを、送信前に依頼文へ明示的に追加できます。取り込みだけではエージェントは起動しません。
- 同期はCanbanサーバーの稼働中のみ。リーダー1つがSocket Modeを受信し、初回・期限切れの取得は1回の確認で2会話までに制限します。
- タスク追加の「作成して開く」が存在しない関数を呼ぶ不具合を修正しました。
- 個人用Slackアプリの設定手順と読み取り専用のアプリmanifestを追加しました。実Slackへの接続・登録済み拡張への反映・ストア申請は別工程です。

## 0.23.9 — 2026-10-06

- Codexデスクトップが閉じたセッションの書き込み権限を保持していても、デスクトップ自身のApp Toolsでアーカイブ・復元できるように修正しました。ChromeはCodexから起動されたCanbanプラグインを経由します。
- 削除で競合した場合は、所有するデスクトップが正規のアーカイブ操作で書き込み権限を解放し、Codexの削除APIを再実行します。削除に失敗した場合は元の未アーカイブ状態へ戻し、戻せない場合はその状態を伝えます。
- 保持中の書き込み権限を再現するCodex実機テストと、連携・実行中の拒否・失敗時の復元の回帰テストを追加しました。

## 0.23.8 — 2026-10-05

- アカウントの週間枠に、リセットからの経過時間に応じた目安線と「順調・使いすぎ・余裕あり」の差分を追加。基準は1日約14.3%、差±5ポイント以内を順調とします。
- 経過日数・残り日数を表示し、5時間枠は独立して維持。リセット不明・期限切れ・古い値・取得失敗時は判定を保留します。

## 0.23.7

- セッションのアーカイブ・復元・削除をCodex App Serverの実操作へ接続。削除成功後にCanbanの属性とタスクの紐付けを整理します。
- 「隠す」と隠したカードの表示条件を撤去。アーカイブ状態はエージェント本体の情報のみを使います。
- 削除確認で会話履歴・関連情報・子セッションが永久削除されることを明示します。
- Claudeとリモート、実行中・入力待ちでは利用できない操作の理由を表示し、Canbanだけのアーカイブ・削除は行いません。


## Slack設計ブランチ 0.23.8 — 2026-10-06

- 個人向けSlack連携の設計に、会話の選択、編集してからのカード作成、返信の取り込み、タイムラインだけの非表示、紐づけたメッセージの履歴保存を反映しました。
- Slackメッセージをカードの資料として扱い、削除後の本文を保持する判断をADRに記録しました。機能の実装は未着手です。

## Slack設計ブランチ 0.23.7 — 2026-10-06

- Slack連携の設計要件に、複数ワークスペース、タスク・セッションへのメッセージ紐づけ、変更履歴、読み取り専用の初期範囲、非表示の要件を追加しました。機能の実装は未着手です。

## Slack設計ブランチ 0.23.6 — 2026-10-06

- Slackタイムラインからのカード取り込みに向け、確定した要件と未決の設計項目、用語集を文書化しました。Slack連携機能は設計中です。

## 0.23.5 — 2026-10-05

- 開いているセッション・タスクカードのパンくずに、左右の隣のリストへ移動するボタンを追加しました。`Shift+←` / `Shift+→` と⌘Kからも操作できます。
- リストの端では停止し、入力中・配置調整中はショートカットを無効にします。移動中の重複操作を防ぎ、移動後もカードと入力途中の文章を保持します。

## 0.23.4 — 2026-10-05

- Claudeのアカウント別保存先を、ログイン・送信・ターミナル再開で一貫して指定し、親プロセスの認証情報やAPI接続先の混入を防ぐよう修正しました。
- Claude CLIと互換の認証更新・保存ロックを導入し、同じプロフィールの別プロセスによる更新を直列化します。異なるアカウントは並行して利用できます。
- 別プロセス・保存先の別名・期限切れロック・所有権の変更・複数アカウントの同時更新を検証しました。

## 0.23.3 — 2026-10-05

- Claude のアクセストークンが期限切れ、または失効したとき、保存済みの更新用トークンで認証を更新して使用量を取得するよう修正しました。更新した認証情報は元の Claude CLI の Keychain／認証ファイルへ保存し、拡張の再読み込み後も利用します。
- 認証更新後の通信失敗でも更新用トークンを失わず、途中のアカウント変更や別のログイン情報の上書きを検知します。

## 0.23.2 — 2026-10-05

- 既定リストの「新しいセッションはここに入ります」をリスト見出しのツールチップと読み上げ用の説明へ移し、各リストの最初のカードの上端が揃うよう修正しました。

## 0.23.1 — 2026-10-05

- カード詳細を「カードボード」の表示領域内で横移動する構成にしました。初期の左右余白と表示領域は1:8:1で、左右の境界を別々にドラッグして調整できます。カードが先に続く右端にはフェードを表示します。
- ショートカットマップを右余白に縦並びで表示し、見出しのドラッグで左右の余白内の任意の場所へ移動できるようにしました。余白と案内の位置を共有UI状態に保存し、カードのスクロールや入力中の文章を保持します。
- `Alt+[` / `Alt+]`で余白境界、`Alt+m`でキー案内にフォーカスし、矢印で調整できます。`0`で初期比率と位置に戻せます。これらは⌘Kからも操作できます。

- 0.23.0の2列カードと統合し、既存の `[` `]`（横のカード）・`m`（リスト移動）を保持しました。`j` / `k`は同じ表示リスト内で端に止まり、関連セッションを閲覧対象へ切り替える際も下書きを保持します。

## 0.23.0 — 2026-10-05

- セッション・タスクの詳細を、余白で区切るフラットな2カラムに整理しました。左は会話・説明と入力、右はパンくず・見出し・状態と属性を既定にし、見出しとパンくずも列間移動・並べ替えできます。
- 会話を左上から広く表示し、Humanは右、Agentは左の吹き出しで区別します。ツールの折りたたみ、Markdown、送信権限の確認、添付・キュー・下書き保持を維持します。
- 6点のつまみは控えめにし、ホバーとフォーカスで強調します。カードの右端・下端・右下から幅と高さを変更でき、種類ごとに共有します（既定幅: セッション1000px / タスク760px、既定高さ860px。画面内に収まる高さで表示）。部品の高さと列幅の変更も引き続き使えます。
- 狭い画面でもカード内の2列を維持します。既定のままの旧配置は新配置へ移行し、カスタム配置・高さと、新しいサイズ範囲内の幅は保持します。カード外の余白・キー案内はカードボードの仕様に従います。
- `npm test`と、1280×800の5レイアウト×ライト・ダーク、可動部品・カードサイズ・下書き保持・タスク横並びを検証しました。

## 0.22.0 — 2026-10-05

- カードを開いたまま、`j` で次のカード、`k` で前のカードへ移れるようにしました。ボードに表示している順（リスト順・レーン順）で進み、端では止まります。閉じたあとは、最後に見ていたカードにフォーカスが戻ります。
- カードを開いている間のキーを足しました。`[` `]` で横に並んだ隣のカード（タスクと紐付いたセッション）へ、`1` `2` `3` で会話の表示（テキスト・プレビュー・要点）、`i` で指示の入力欄へ、`o` で再開、`l` `g` `Alt+m` `h` でラベル・カテゴリ・リスト移動・隠す（ボードで選択中のカードと同じキー）、`?` でキー一覧。
- その画面で使えるキーを、`Esc` のように小さなキーの形で、操作の隣に表示するようにしました。カードのバー（`j` `k` / `[` `]` / `?` / `Esc`、表示の切り替えの `1` `2` `3`）、カード内のボタン（再開 `o`、ラベル `l`、カテゴリ `g`、リスト `Alt+m`、隠す `h`、指示 `i`）、アプリバー（検索 `/` `⌘K`、作成 `c`）です。「キーボードショートカット」の一覧に「カードを開いている間」を追加しました。

## 0.21.0 — 2026-10-05

- サイドバーを上から「ビュー → レーン → 絞り込み」に整理しました。下端に分析・Agent Usage・管理・レイアウトとテーマを置きます。
- レーン（旧スイムレーン）の軸を、サイドバーで選べるようにしました。なし・カテゴリ・AI Apps・マシン・ラベル、⋯ からプロジェクト・Codex セクション・アカウントを選べます。下の一覧を押すとそのレーンへ移動し、▾ で開閉、⌥ で単独表示です。レーンにした軸は絞り込みに出しません。
- AI Apps・期間・状態・カテゴリ・マシン・ラベル・表示する対象（アーカイブ済み・サブエージェント・隠したカード・ピン留めだけ）を、サイドバーの「絞り込み」にまとめました。有効な条件はアプリバーにチップで並び、✕ で1つずつ、「すべて解除」でまとめて外せます。
- アプリバーから AI Apps・期間・「表示」を外しました。カードの高さ・レーン内のリストの高さ・レイアウト・色は「レイアウトとテーマ」にまとめ、サイドバーの下端・レール・ドックから開きます。
- ボード名は、一致する保存ビューの名前を表示します。サイドバーの「管理 › カテゴリ」は、カテゴリの絞り込みの見出しの ⚙ に統合しました。
- オムニバーでは、カテゴリの帯がレーンの一覧になり、レーンと絞り込みはアプリバーの「絞り込み」ボタンから開きます。

## 0.20.0 — 2026-10-04

- ヘッダーとボードバーを1本のアプリバーにまとめました。ボード名（押すとカテゴリ・プロジェクトを切り替え）、検索、作成、AI Apps、期間、表示、実行状況、アカウントが並びます。幅が足りないときは、ロゴの文字、本文検索、ボタンの文字、優先度の低い項目の順に ⋯ へ畳みます。
- 管理（自動化・ラベル・カテゴリ・保存ビュー・マシン・設定）は、サイドバーの項目からだけ開くようにしました。サイドバーのすぐ右に管理パネルが開き、ボードを押し出します。同じ項目をもう一度押すか `Esc` で閉じます。ボードバーの「メニュー」とドロワーのタブはなくしました。
- 分析と Agent Usage を、カードと同じオーバーレイ（ボードが半透明に見える層）で開くようにしました。サイドバーの「見る」、`a` キー、⌘K から開けます。
- カードの高さ、表示する範囲、レイアウトと色を、アプリバーの「表示」1つにまとめました。ヘッダーのテーマ・レイアウトボタン、ボードバーのカテゴリ絞り込みと「揃える / 内容に合わせる」、設定の「表示」タブは、重複していたためなくしました。
- 5種のレイアウトで入口を1か所にしました。レールはすべての場所を並べ、管理パネルはサイドバーの列に出します。オムニバーはドックだけで移動し、カテゴリの帯をアプリバーに置きます。ライブ HUD はボード・分析・Agent Usage をタブで、管理をサイドバーで開きます。
- 部品の呼称と受け持ちを `docs/ui-components.md` にまとめ、`AGENTS.md` の UI の原則を合わせて更新しました。

## 0.19.0 — 2026-10-04

- カードの表示を Trello の標準に戻しました。カードを押すと、ページを切り替えず、リストやホームの上に背景を少し暗くして、カードが1枚浮かびます。`Esc` か背景の押下で閉じます。ヘッダーとボードバーは隠れません。
- タスクカードを押すと、タスクのカードを左端に、紐付いたセッションのカードを右へ横並びで開きます。最大8件を並べ、多いときは横にスクロールします。紐付けの増減は自動で反映します。
- カードの中の配置変更（部品の並び替え・高さ・列幅・開閉）は、これまでどおり使えます。カード幅も右端のドラッグで変えられます。配置と幅は、セッションカード・タスクカードの種類ごとに、同じ種類のカードへ共有します。
- 複数カードの選択と一括表示、固定・自由の配置、付箋、ダッシュボードボタン、階層メーター、サイドバーの「カードダッシュボード」、タスクごとの A / B / C / 自由の表示方式を廃止しました。タスクごとの画面設定の保存 API は互換のため残しますが、画面では使いません。
- 閉じたカードの入力途中の文章は、開き直すまで保持します。リロード後は、開いていたカードを開き直します。

## 0.18.3 — 2026-10-04

- Codex などの埋め込みホストが文書の背景を透過させても、Trello レイアウトの青いグラデーションが表示されるよう修正しました。背景を Canban 自身の画面枠に描き、5種のレイアウトとライト・ダークの配色を保持します。

## 0.18.2 — 2026-10-04

- Chrome Web Store への 0.18.1 の審査申請の記録を CHROMEWEBSTORE.md に追加しました。アプリの動作の変更はありません。

## 0.18.1 — 2026-10-04

- Trello 基調の画面・5種のレイアウトと、カードの指示入力の画像添付・スキル選択、拡張名のバージョン表示を1つにまとめました。指示入力欄は新しいカードの見た目の中でもそのまま使えます。

## 0.18.0 — 2026-10-03

- レイアウトを5種から選べるようにしました。Trello（既定）、定番（サイドバーが上まで通る）、レール（左のレール＋サイドバー）、オムニバー（カテゴリの帯と下のドック）、ライブ HUD（動いているセッションを最上段にタイル表示）です。ヘッダーのレイアウトボタン、設定の「表示」、⌘K から切り替えられます。
- レイアウトと色（ライト・ダーク・システム）は別々に選べます。Trello 以外の4種は、ライト・ダークどちらでも落ち着いた無地の配色になります。選んだ値は画面間で共有します。
- サイドバーのカテゴリに、実行中・入力待ちの件数を表示するようにしました。

## 0.17.0 — 2026-10-03

- `AGENTS.md` に UI の原則（Trello 基調の画面構成、ページはボード1枚で管理系は右のドロワー、カードの構造、テーマ、実装の決まり、完了条件）を追加しました。
- 画面を Trello 基調に作り直しました。上段のヘッダー（ロゴ・検索・作成・実行状況・テーマ・アカウント）と、下段のボードバー（ボード名・ボード / 分析・絞り込み・カードの高さ・メニュー）の2段です。どちらも半透明で、背景のグラデーションが透けます。
- 新しいロゴ（長さの違う3本の列と、動いているエージェントを示す点）に替えました。ボタンとメニューのアイコンを線のアイコン1種類に揃え、絵文字をやめました。
- テーマをヘッダーで「ライト・ダーク・システム」から選べるようにしました。選んだ値は画面間で共有します。
- 左の紺色ナビを外しました。絞り込みサイドバーを、読みやすいワークスペースサイドバー（ビュー・見る・管理・カテゴリ）にしています。
- 自動化・ラベル・カテゴリ・保存ビュー・マシン・Agent Usage・設定は、ボードの上に右から出るメニューで開きます。ヘッダーとボードバーは開いたまま使えます。
- カードを「状態とエージェント → タイトル → 動き → 属性」の4段に作り直しました。既定はすべて同じ高さで、ボードバーの「内容に合わせる」で切り替えられます。リストの高さは中身に合わせます。

## 0.16.11 — 2026-10-04

- Chromeのアドレスバー左側とツールバーの拡張名にバージョンを表示します。ローカルmainテスト版も更新時に番号を反映します。

## 0.16.10 — 2026-10-03

- タスクカードの依頼文とセッションカードの指示入力で、画像の選択・貼り付け・ドロップとスキルの検索・選択に対応しました。`$`・`/`・`@` 入力でもスキル候補を開けます。
- 添付画像と選択したスキルを下書き・実行キュー・履歴に保持します。送信失敗時は入力を残し、再送内容の確認では添付も復元します。画像だけの指示と、ローカル・SSH接続先への送信に対応しました。
- 既存セッションはCodex / Claudeの画像入力を使用します。新規Codexターミナルは画像を添付し、新規デスクトップとClaudeターミナルは依頼文に画像の参照を含めます。画像はPNG・JPEG・WebP・GIF、1枚10MB・8枚までです。
- 送信中の重複操作と日本語IME変換中のショートカット送信を防ぎ、指示入力セクションの初期表示を広げました。

## 0.16.9 — 2026-10-03

- 既存アカウントの再ログインでもブラウザ自動起動・認証URLコピーを選べるようにし、ターミナル認証も残しました。対象アカウントの認証成功後に使用量を更新します。
- 利用枠は取得データに存在するものだけを表示します。週間枠のみのアカウントに余分な「未取得」の枠を表示せず、一枠を全幅に配置します。使用量の未取得時は枠名を推測しません。

## 0.16.8 — 2026-10-03

- Chrome導入手順の旧説明を修正し、Native HostがApplication Support／XDG領域の配布物を起動することと、通常版・ローカルmainテスト版それぞれの更新手順を統一しました。

## 0.16.7 — 2026-10-03

- macOSがDocuments内のrepoへのアクセスをChromeの子プロセスに拒否し、`Native host has exited`で読み込めない問題を修正しました。Native Hostの実行ファイルをアプリ用保存領域へ配布します。
- ローカルmainのテスト版はGit管理ファイルだけをコミット単位で配布し、更新中の既存プロセスとコードが混在しないようにしました。拡張ID・接続先・共有データの保存先は維持します。

## 0.16.6 — 2026-10-03

- Chromeで遅い通常応答が監視応答の直後に返ると直列通信と誤判定し、更新間隔が延びて警告が出る問題を修正。Native Messagingではリアルタイム監視を維持します。
- 並行通信が不明なホスト向けの短い間隔での監視切り替えは維持し、正常な切り替えをエラー警告として記録しません。

## 0.16.5 — 2026-10-02

- 通常Chromeのデータ保存先を `~/.canban/` とし、repoの開発設定が適用されないよう修正。明示したテスト用保存先は維持。
- ユーザーデータとプログラムの配置を区別し、既存共有データの参照・移行契約を更新。

## 0.16.4 — 2026-10-02

- CodexのインストーラーがGit管理外のファイルもコピーするため、導入元をGit管理ファイルのみの `dist/codex-plugin/` に変更しました。DB・認証情報・バックアップをプラグインへコピーしません。
- インストール済みコピーではcheckout用のローカル設定を使わず、共通の保存先へ接続します。
- `npm run update:local` でプラグイン配布物・Chromeビルド・再導入をまとめて更新します。

## 0.16.3 — 2026-10-02

- ローカル設定・共有データ・更新記録をrepo内の `.local/` に集約する配置契約を追加しました。
- Chrome Main Testの更新処理を `scripts/update-local-chrome.mjs` と `npm run update:chrome` に移し、拡張IDと共有保存先を維持します。
- 保存先設定と旧パスの互換リンクを解決し、`.local/` をGitとMCPBパッケージから除外しました。

## 0.16.2 — 2026-10-02

- アカウント追加でターミナル経由のログインと任意ブラウザでの認証を再び選べるようにしました。以前のテスト版の認証処理を現在の専用保存先へ統合しました。
- 認証URLの表示・コピー、Chromeプロファイル／Safariの選択、Claudeの認証コード入力、認証の再表示・取消を復元しました。
- ターミナルを起動できない場合も専用保存先のログインコマンドをコピーして実行できます。既存アカウントの認証情報は上書きしません。

## 0.16.1 — 2026-10-02

- 会話欄の高さにフッターを含め、会話一覧と外側セクションの二重スクロールを解消しました。
- 軽微な修正もバージョンを更新し、Chromeの登録済みフォルダーに同じ番号のビルドを反映する運用を明記しました。

## 0.15.0 — 2026-09-30

- Codex・Claude・Chrome共通のサイドバーを追加。ホーム、カード、利用上限、分析、管理画面を切り替えられます。
- カードダッシュボードを表示領域全体へ拡張。固定カードの高さ、複数行グリッド、内部スクロール、小さな画面のナビゲーションを調整しました。
- 画面切り替え時に未送信のプロンプトとフォームを保持。入力中の共有設定の読み込みを保留します。
- Claude側の複数アカウント対応（PR #5）をSQLiteへ統合。アカウント設定・フィルター・設定フォルダ・送信時の環境指定を維持しました。
- Agent Usageでアカウント上限・セッションのコンテキスト・接続画面を分離。未取得や古い利用上限を残量として表示しません。


## 0.14.0 — 2026-09-30
- **Multiple accounts.** Sessions of every account are on the board together, so switching accounts in Claude Desktop or Codex no longer hides anything.
  - Each session knows its account: Claude from where the desktop app keeps it (`claude-code-sessions/<account>/<org>/`), Codex from `threads.creator_account_id`. Sessions with no record show as アカウント不明.
  - Header **アカウント** menu: accounts per AI App with their e-mail / plan, session count, where they are signed in (desktop profile, CLI config folder) and usage. Click one to filter the board (`account` filter, also in saved views, analytics and the MCP tools); ✎ gives it a display name. Cards carry a 👤 chip when there is more than one account; swimlanes can group by account; analytics adds アカウント別.
  - The Claude desktop app only opens the signed-in account's sessions: another account's session resumes in the terminal by default, and its detail says why.
- **Config folders.** Other `CLAUDE_CONFIG_DIR` / `CODEX_HOME` folders are read too: found under `~/.claude-*`, `~/.claude-profiles/*`, `~/.codex-*` (can be turned off) or added in the menu. Their sessions resume and receive prompts with that folder in the environment, and the live watch follows them.
- **Claude desktop profiles.** Other app data folders beside `Application Support/Claude` (`Claude-*`, `Claude-Profiles/*`) are read as well. Folders shared between accounts through symlinks are read once and belong to their real location; a session visible to the signed-in account through a link is not flagged.
- **Usage per account.** The header shows 5-hour / weekly usage for every account that has a record: Codex rate limits from the logs (now kept per account) and Claude plan usage from each desktop profile's `plan-usage-history.json` (older than an hour: dimmed). New model-visible tool `canban_get_usage`.
- Account files are read only for the account id, e-mail, plan and usage; tokens are never read into anything Canban returns.
- **One-row header.** The header no longer wraps. When it does not fit, button labels go first (icons stay), then items move into a new ⋯ menu from the lowest priority up (本文 → 自動化 → ビュー → ラベル → マシン → 分析 → 表示 → 期間 → 📁 → AI Apps → 実行状態). The run-state chips are dots with counts; the session totals moved to the Canban title's tooltip.
- **Usage rings.** Usage is one double ring per account on the 👤 button: outer = 5-hour window, inner = weekly, green / orange / red by how full; the center carries the account's initial on its own color and a corner mark says Codex or Claude. In the 👤 menu each account can be left out of the header (checkbox) and given a name, a 1–2 character initial and a color (✎). Card chips use the same initial and color.
- Fix: `h()` now sets CSS custom properties given in `style`.
- Code layout: the account and header UI live in `ui/accounts.{js,css}` and `ui/header.{js,css}`, inlined into `ui/board.html` at `@include` markers by `server/ui.mjs` (the page stays one `<style>` + one `<script>`). Server glue is in `server/accounts-settings.mjs` (settings) and `server/accounts-mcp.mjs` (tools, filter, desktop notes, watch folders); `board.html`, `store.mjs`, `index.mjs` and `board.mjs` keep one-line hooks.

## 0.13.0 — 2026-09-29
- Card details are now **panes** instead of one modal: open several cards at once, like pinned sticky notes (up to 8).
  - A pane never grows taller than the screen; each column of the card scrolls inside it.
  - **Display modes** — テキスト (plain, compact, monospaced feel), プレビュー (the previous look), 要点 (digest: tool calls and thinking are hidden, replies cut to three lines).
  - **Sizes** S / M / L per pane.
  - **Space** — 固定 (packed into a grid, one row or one column, centered) or 自由 (drag anywhere, edges and other panes snap). Fixed panes are reordered by dragging their title. Below 720 px wide the panes stack.
  - **付箋** — fold a pane down to its title and one line of what the session is doing; unfold to get it back.
  - Every setting is a default (bar above the panes) that each pane follows unless it is overridden from that pane (空間 button, 表示 popover). Bulk buttons: すべて付箋に / すべて広げる / すべて固定 / すべて自由 / 全体設定に従う.
  - The parts of a card (conversation, prompt box, labels, memo, plan, edited files, model and permission, context meter, resume, ...) can be reordered by drag and drop or by `↑` `↓` on the grip, inside their own column only. The order is shared by all panes; 部品の並びを初期化 resets it.
  - Open panes, their settings and positions are remembered (per host app, in the UI's local storage).
  - **Dashboard button**: all panes fold into one round button (`D`, or the button itself). The button carries a ring of the cards' states (running / waiting / done), a count badge, and fans the cards out on hover so one can be picked. It can be dragged to any edge of the window and snaps to the nearest one (`Shift`+arrows moves it from the keyboard); the fan opens toward the inside and the position is remembered.
  - Picking cards is easier: while folded, clicking a card adds it to the dashboard without opening it (the 畳んだまま足す switch in the bar; clicking a card that is already in the dashboard opens it).
  - The background always darkens while the dashboard is open, not only for fixed panes; anything laid over the panes (menus) adds another translucent veil, and a depth meter at the bottom shows how far from the home board you are (ホーム / ダッシュボード / メニュー).
- The live watch follows every open pane: `canban_watch` takes `feeds` (up to 8 `{cardId, offset, size, codexItems}`) and returns `feeds` keyed by card. `cardId` / `feed` still work for one card. The live hub watches all focused logs, and presence lists every open card.
- Fix: the filter row's agent buttons no longer share the highlight logic with other segmented controls.

## 0.12.0 — 2026-09-29
- Live signals from the session logs, updated with the realtime board:
  - Context in use after the last reply (Codex: share of `model_context_window`; Claude: tokens, share when the window is known). Cards show `◔ 62%`; any card over 75% / 90% turns orange / red.
  - Plan progress from Claude TodoWrite / Codex update_plan (`☑ 3/7`, steps and the current one in the detail).
  - Files the current turn edited (Edit / Write / apply_patch / FileChange, `✎ 4`), running Claude sub-agents (`🤖 2`).
  - What a waiting session waits for: a question (❓) or plan approval (📋).
  - Model, effort and mode (Claude permission mode / Codex sandbox) in the detail.
  - Codex rate limits (5 h and weekly windows, from `token_count` events) in the header, with the time to reset.
  - Signals are folded per log from its first read and then only from appended lines, so a long turn keeps its edited files after they leave the tail.
- Live git state of running sessions' folders on their cards (`⎇ main ±3 ↑1`: branch, uncommitted + untracked files, ahead / behind) and of any local session in its detail.
  - Read with `git --no-optional-locks status --porcelain=v2` (never takes the index lock); at most 4 git processes, 3 s timeout.
  - The live hub watches the git dirs (HEAD, index) of running sessions, so commits and checkouts show at once; unstaged edits are recounted at most every 10 s while the log grows. Nothing runs until a board is open.
- Presence: a live board leaves a heartbeat in `~/.canban/presence.json` (app from `clientInfo`, the open card; every 30 s or when the open card changes, expiring after 90 s). Other boards show "👁 Codex" / "👁 Claude デスクトップ" in the header and 👁 on the card that board has open. Heartbeats that change nothing a board shows do not end its long poll.
- The dev host takes `CANBAN_DEV_CLIENT` to pose as another app.
- Claude desktop metadata (`claude-code-sessions/**/local_*.json`, `archived-sessions.idx`) is watched too: a rename, archive or status change rebuilds the board at once; rewrites that only touch activity times are ignored. Reloads caused by new sessions or metadata skip the 4 s listing cache.

## 0.11.0 — 2026-09-28
- Realtime board. While a board is open it updates as soon as something changes, instead of re-reading every 15–60 s.
  - The UI keeps one `canban_watch` call open (long poll, up to 20 s). The server watches the session logs (`fs.watch`) and Canban's own files, and answers with only what changed.
  - Cards of sessions whose log grew are patched in place, with no session listing. Running / waiting cards show what the session is doing now (`Bash: npm test`, the first line of the latest message). A status change still rebuilds the board so automations run.
  - The card detail shows the conversation like the agents' own apps: prompts, replies, reasoning (folded), tool calls (spinner, then ✓ / ✗ with the start of the output) and turn ends, streamed line by line from the log. It follows new lines when scrolled to the bottom and shows "↓ 新着" otherwise. The send box sits right under it.
  - Edits made in another app (Codex and Claude Desktop on the same board) show up at once.
- Load: watching starts when a board opens and stops 60 s after it closes; servers without an open board watch nothing. Logs are read from the last offset. Without `fs.watch`, only the watched files are stat-polled (2 s). If a host runs an app's tool calls one at a time, the UI switches to short polling (2.5 s) so clicks are not delayed. `live.watch` has a 50 ms budget. `CANBAN_LIVE=0` turns it off.
- `board.json` edits hold a lock across processes (`~/.canban/board.lock`), so two apps editing the board at once no longer lose an update.

## 0.10.0 — 2026-09-27
- Claude Desktop: Canban can be installed as a Claude Desktop extension. The board opens inside the conversation when you ask for it ("Canban を開いて"); ⤢ switches to fullscreen.
  - `manifest.json` (MCPB 0.3) starts the same server through `scripts/launch.sh`, so it uses a Node.js ≥ 22.13 from PATH, Homebrew or nvm, or the one set in the extension's "Node.js の場所" setting (`CANBAN_NODE`).
  - `npm run pack:mcpb` builds `dist/canban.mcpb`. `.mcpbignore` leaves tests and docs out.
  - A `claude_desktop_config.json` entry works too (README).
  - Both apps share `~/.canban`, so they show the same board, and background work still runs in only one server.
- The server no longer needs `.codex-plugin/plugin.json` to start; it falls back to `package.json` for its version.
- The server records which app started it (`clientInfo`) in its log and in `canban_get_perf`.
- The server instructions tell the model to call `open_canban` to show the board, since Claude Desktop has no sidebar entry.

## 0.9.0 — 2026-09-27
- Terms no longer clash with Codex / Claude Code concepts of the same name (display only; stored data and MCP tool / argument names are unchanged):
  - Directories are now **カテゴリ**. "Directory" means a folder everywhere else, including "作業ディレクトリ" (cwd) in Canban's own detail view.
  - "⚡ ルール" is now **⚡ 自動化**. Codex `.rules` and Claude permission rules decide which commands may run. Codex automation threads are labelled "⏰ Codex オートメーション".
  - The agent filter is now **AI Apps**. "Agent" is kept for agents / sub-agents, as in Codex and Claude Code.
  - Tasks are now **タスクカード**, to keep them apart from Claude Code's Task / TaskCreate and Codex cloud tasks.
  - The UI takes these words from one table (`T` in `ui/board.html`). The README has a terminology table.
- Codex projects: "プロジェクト" is now the Codex app's project (named, several folders; read from `~/.codex/.codex-global-state.json` and the state DB) for threads that belong to one, and the folder name otherwise.
  - Folder names stay available as **フォルダ**: detail, tooltip and a scope filter.
  - A Codex project can be turned into a カテゴリ with its folders ("⇣ Codex" in the sidebar).
  - The app state file (over 1 MB) is parsed once per change and shared with the remote-host list; it used to be parsed on every board load. Warm `allSessions` went from 281 ms to 10 ms.
- Agent metadata:
  - Codex pins come from the Codex app (`pinned-thread-ids`; the DB column is no longer used). Pinned threads show 📌 and can be filtered ("Codex アプリでピン留めしたものだけ").
  - Claude sessions without desktop metadata on disk (common with recent Claude desktop versions) show their archived state as unknown instead of "not archived". The "close it in the app first" hint relies on the transcript's `entrypoint`.
  - Folder and pin filters now also apply to task cards.
- Codex sections (the sidebar headings, e.g. "doing" / "done"):
  - Cards show "§ name". Sections are a scope filter and a swimlane mode.
  - A new automation trigger, "Codex のセクション『…』に入ったら" (`section:<id>`), moves the card when the thread is moved between sections in Codex, so lists and sections no longer have to be kept in step by hand. Threads in a section are tracked even when long idle.
  - Section membership is re-read (about 1 ms, partial index) on every DB change, because moving a thread does not bump `updated_at`. It is in parity with the remote collector.
- Requests are not sent to a Codex thread that has follow-ups waiting in the Codex app's own queue ("⏭ Codex キュー N" on the card), so the two queues never interleave.

## 0.8.0 — 2026-09-27
- Send prompts to existing sessions from the board ("指示を送る" in the session detail) or from the model (`canban_send_prompt`): send now, or queue them to run one at a time when the session is free.
  - Delivered as one headless turn through the agent's own CLI (`codex exec resume` / `claude -p --resume`). The prompt goes on stdin; Canban still never writes agent files itself.
  - Permissions are inherited from the session and never raised: Codex uses the sandbox of the latest turn with approvals turned into failures; Claude Code uses the latest `permissionMode`.
  - Sessions without a sandbox need a confirmation for every prompt, and the model cannot send to them by default.
  - Safety gates: nothing is sent while a session is running, waiting for input or was just written; "send now" checks that the session did not change since you looked. One request per session at a time, guarded by a lock shared by all Canban servers. Failures pause the session's queue.
  - Queue: edit, reorder, cancel, stop and resume. Cards show 📨 queued / ▶ running. Results and run logs are kept per session.
  - Remote hosts are supported through a separate `server/remote/dispatch.py` (the collector stays read-only).
  - Settings: on/off, concurrency (local / per host), model access, model rate limit.
- Performance:
  - Only one Canban server (an elected leader) runs background work. Codex starts one server per thread, and each of them used to index and evaluate rules on its own.
  - The Codex session list is read incrementally. An unchanged database is not queried at all. The full read (about 2.4 s and blocking on a large history) now happens only at startup and every 30 minutes. Warm board loads went from about 1.3 s to about 0.1 s on a 6,000-session history.
  - Built-in timings with budgets (`docs/performance.md`), a "⚠ 遅い処理" indicator with details, and `npm run bench`.

## 0.7.0 — 2026-09-27
- Directories: a Canban-only, single-membership grouping for session and task cards, shown on cards in place of the project.
  - Assign with `g`, from the card detail, by dropping a card on a directory in the sidebar, or by dragging it between directory swimlanes.
  - Folders registered on a directory pull their sessions in automatically; an explicit choice (including "none") wins.
  - Also available as a filter, a swimlane mode, an analytics breakdown, a saved-view field and an MCP argument.
- Sidebar (`b`) listing lanes, directories and projects with counts, live status and new-card badges. Click a lane to jump to it; ⌥-click to show only that lane. Collapse or expand all lanes from here. Works as an overlay on narrow screens.
- Swimlanes:
  - Lane headers stay pinned while scrolling.
  - Lists inside a lane have a height cap (compact / normal / all).
  - Collapsed lanes show card counts per list.
  - "Only this lane" focus mode.
  - `Alt+[` / `Alt+]` step between lanes.
- Keyboard:
  - `/` focuses search (`Esc` clears; `↓` / `Enter` jumps to the first card).
  - ⌘K / Ctrl+K opens a command palette over cards, views, lanes, directories, projects, labels and actions.
  - `?` shows the shortcut overlay.
  - `p` opens the scope filter; `c` adds a card; `a` toggles analytics; `r` reloads.
  - On a focused card: `l` labels, `g` directory, `Alt+m` move to list, `h` hide.
  - Focus returns to the card after a picker or detail dialog closes.
- Every attribute choice uses a keyword-filterable picker: lists, labels (create inline), directories (create inline), projects, machines, tasks, swimlane mode and rule lists. Matching is multi-word and ignores case, width and katakana/hiragana. Long menus (views, labels, machines, rules) get a filter box.

## 0.6.0 — 2026-09-26
- Analytics view: sessions per day (stacked by agent), token usage, per-project and per-machine breakdowns, time spent in lists, cycle time to the last list and weekly completions. Charts have hover tooltips and a table view; the Codex/Claude colours are validated for colour-vision deficiencies in light and dark mode.
- Full-text search over conversations (toggle "本文"): a background FTS5 trigram index in `~/.canban/search.sqlite` (last 90 days, incremental) with highlighted snippets on cards; enabled remote hosts are searched on demand.
- Swimlanes by project, machine, agent or label (drag and drop keeps working across lanes).
- Saved views (filters, search, swimlane, view options) with 1–9 shortcuts.
- Token counts for Claude Code sessions (from message usage) and Codex (`tokens_used`), kept in parity with the remote collector.

## 0.5.0 — 2026-09-26
- Git / PR integration for GitHub (`gh`) and GitLab (`glab`): repos come from Codex's recorded origin, Claude PR links or the folder's `remote.origin.url`; PRs/MRs are matched by branch (with per-branch lookups for older branches) and cached for 5 minutes, all in the background so the board never waits.
- Cards show the PR/MR number with state colour and CI result; the detail lists checks / pipeline and the other sessions on the same branch.
- New rule triggers: PR/MR opened, merged, closed; CI failed, CI passed (fire only on transitions after a baseline, never for old PRs when first seen).
- View option to collapse sessions that share a repo + branch into one card.

## 0.4.0 — 2026-09-26
- Task cards: "+ Add a card" at the bottom of every list (Trello-style, Enter to keep adding). Tasks have a title, description, labels, priority, due date and linked sessions.
- Start a new Codex / Claude Code session from a task (desktop app deep link or terminal, local or on a remote host); the new session is linked to the task automatically once it appears (agent + machine + folder or prompt prefix, within an hour).
- Link existing sessions by dragging a session card onto a task card, or from the session detail. Linked sessions are shown inside the task, and rules move the task card.
- Codex sub-agents are shown on their parent card (🤖 count, running count) and listed in the detail.
- CLI-only Claude Code sessions now open in the Claude desktop app via `claude://resume?session=<id>`.

## 0.3.0 — 2026-09-26
- Keyboard: arrow keys move the focused card (←→ between lists, ↑↓ within a list, Home/End); ⌥ + arrows move focus only.
- Live status for recent sessions (running / waiting for input / completed / aborted) from the tail of each log, locally and on remote hosts (Python collector kept in parity with the JS rules and tested).
- "New" highlight for cards with activity since you last looked, and "mark all as read".
- Automatic-move rules (off by default): fire on status transitions or new activity, evaluated on board load and every 60 s in the background; moved cards are marked ⚡ and can be undone.
- Fixes: concurrent board writes are serialized (no lost updates / tmp-file collisions); remote collector arguments are passed as a JSON string (booleans/null previously broke the Python side); the server flushes stdout before exiting.

## 0.2.0 — 2026-09-26
- Renamed to **Canban** (data now lives in `~/.canban`; an existing `~/.session-kanban/board.json` is read once and never modified).
- Resume sessions from the board: in the agent's desktop app (Codex / Claude) or in a terminal (Ghostty, Terminal.app, iTerm2) as a new window, new tab, split, or in the existing window. Defaults are configurable and every variant has a shortcut.
- Claude Code sessions open in the Claude desktop app (`claude://code/continue`), falling back to a new session in the same folder.
- Remote machines: sessions on SSH hosts registered in the Codex app can be enabled per host and are read over SSH with a read-only Python collector.
- Tests: fixture-based MCP tests, Python/JS parity tests, fake-SSH tests; CI on macOS and Linux.

## 0.1.0
- First version: Codex sidebar app (MCP App with a `global` entrypoint), read-only Codex / Claude Code session readers, Trello-style board with user-defined lists, labels, notes, priority and due dates.

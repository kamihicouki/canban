# Chrome Web Store — Canban

最終更新: 2026-10-07

## ローカル実装版 0.24.5

- Claude の再開と指示の実行先を、会話が最後に使ったworktreeに修正しました。別アカウントの思考に関する通知の意味も既存の再開欄に表示します。会話ID・履歴・アカウント選択を維持し、新しい入口・キー・レイヤー・Chrome権限は追加しません。
- Claude Desktop 用MCPBもGit管理ファイルだけから生成します。Chrome・Codexのローカル更新とは別に、Desktopの拡張更新が必要です。

## ローカル実装版 0.24.4

- アプリバー・サイドバーと共通のアカウントIDを使い、Claude の実行アカウントを1アカウント1候補で表示します。複数の接続設定は「接続設定を指定」で選べます。
- メール・エージェント・対応Desktopプロフィールを表示し、保存した設定フォルダーを再表示・同じアカウントの再選択でも保持します。認証情報や会話の移動・統合はありません。
- 候補の文字重なりと詳細展開時の画面外へのはみ出しを修正しました。入口・キー・レイヤーは従来どおり、Chromeの追加権限はありません。

## ローカル実装版 0.24.3

- 実行アカウントに Claude Code CLI・設定フォルダー・対応する Desktop プロフィールを表示し、同じメールの候補を区別して検索できます。
- 標準 CLI の認証領域を維持し、再開と送信の前に実際の認証先を検証します。旧 Desktop フォルダーがある場合も、使用中のプロフィール構成内の一意な切替先を選べます。
- 入口は既存の実行アカウントピッカー（レイヤー4）、Alt+a / ⌘K。Chrome の追加権限はありません。

## ローカル実装版 0.24.2

- Claude の実行アカウントを保存し、画面の再表示・各クライアントの送信で同じ選択を使います。
- ログイン済み Desktop プロフィールがある場合、停止中の保存先リンクを切り替えて通常起動も同じアカウントへ合わせます。アプリ終了・ログアウトやデータの移動は行いません。
- Desktop が元の会話を開けることを確認し、開けない場合はターミナルで再開する理由を表示します。
- 入口・キー・レイヤーは0.24.1と共通です。Chromeの追加権限はありません。実アカウントの応答・登録済み拡張への反映・ストア申請は未実施です。

## ローカル実装版 0.24.1

- Claude Code のカードから実行アカウントを選んで、同じ会話・作業フォルダ・ブランチを引き継げます。ターミナル再開と指示の送信・キューに共通の選択です。
- 入口はカードの「再開」の実行アカウント。Alt+a / ⌘K に対応します（ピッカーはレイヤー4）。
- ローカルの登録済みCLIプロファイルが対象です。認証情報・会話のコピーや、デスクトップアプリのログイン切替は行いません。
- Chromeの追加権限はありません。実アカウントの応答・登録済み拡張への反映・Chrome Web Store申請は未実施です。

## ローカル実装版 0.24.0

- 個人用Slackアプリを使う読み取り専用の取り込み機能を追加しました。複数ワークスペース、返信の取り込み、既存カードへの紐づけと変更履歴に対応します。
- 認証情報はCanbanのローカル保存先の `slack/credentials.json` に保管します。メッセージのキャッシュ・紐づけた資料と履歴は同じ保存先のSQLiteに保管します。
- 本文・出典・添付ファイルのリンクを保存し、添付ファイル本体はダウンロードしません。エージェントへは利用者が依頼文に追加して送信した資料だけが渡ります。
- Slackへの返信・リアクション・既読の更新はありません。Slackアプリの導入と読み取り権限の付与が必要です。[設定手順](docs/slack-setup.md)を参照してください。
- Chromeの追加host permissionはありません。通信はローカルNative Messagingサーバーが行います。Chrome Web Store申請・Slack Marketplace公開・実Slackでの受入確認は未実施です。

## ローカル検証版 0.23.9

- Codexデスクトップが書き込み権限を保持しているセッションのアーカイブ・復元・削除の競合を修正しました。ChromeからCodex内のCanbanプラグインを経由して操作します。
- 操作の入口・レイヤー・キーは0.23.7と共通です。新しいUI操作はありません。
- Claudeとリモートの履歴操作は引き続き未対応です。ストアへの審査申請は行っていません。

## ローカル検証版 0.23.8

- アカウントの週間枠に経過時間の目安線・ペース判定・差分・残り日数を追加しました。
- アカウントの既存ポップオーバー（レイヤー4）内の表示変更です。新しい操作はありません。
- ストアのアカウント使用量スクリーンショットは更新が必要です。審査申請は行っていません。

## ローカル検証版 0.23.7

- Codex本体のアーカイブ・復元・永久削除に接続しました。削除は会話履歴と関連情報も削除します。「隠す」を撤去し、Claude・リモートの未対応操作には理由を表示します。
- `z`、`Delete`と⌘Kから利用できます。カード操作はレイヤー2、削除確認はレイヤー3です。
- 架空のセッションで1280×800・5レイアウトのライト／ダークを確認しました。キャンセル時の下書き保持、アーカイブ・復元、削除後の再取得、横並びセッションからの⌘K操作を検証しています。

## 設計文書更新 0.23.8

- 個人利用のSlack取り込み要件と、カードの資料・履歴の扱いを文書化しました。Slack連携機能の実装・接続・ストア申請は行っていません。

## 設計文書更新 0.23.7

- Slack連携の設計と用語集を更新しました。機能の実装・接続・ローカル拡張への反映は行っていません。
- この版の Chrome Web Store への審査申請は行っていません。

## 設計文書更新 0.23.6

- Slackメッセージの取り込み設計と用語集を追加しました。Slack連携機能はまだ実装していません。
- この版の Chrome Web Store への審査申請は行っていません。

## ローカル検証版 0.23.5

- カード詳細から左右の隣のリストへ移動できるボタン・`Shift+←` / `Shift+→`・⌘Kの項目を追加しました。
- カード詳細のストア用スクリーンショットは移動ボタンとキー案内が見える内容へ更新が必要です。
- この版の Chrome Web Store への審査申請は行っていません。

## ローカル検証版 0.23.4

- Claudeのアカウント別の保存先・起動環境・認証更新と保存の排他制御を統一しました。
- この版の Chrome Web Store への審査申請は行っていません。

## ローカル検証版 0.23.3

- Claude の保存済みログインの期限更新と永続化を修正し、拡張の再読み込み後も最新の使用量を取得できるようにしました。
- この版の Chrome Web Store への審査申請は行っていません。

## ローカル検証版 0.23.2

- 既定リストの案内を見出しの補足情報へ移し、ほかのリストと最初のカードの位置を揃えました。
- この版の Chrome Web Store への審査申請は行っていません。

## ローカル検証版 0.23.1

- 左右の余白を確保したカードボードを追加しました。初期比率は1:8:1、左右の余白は個別にドラッグ調整できます。
- キー案内は片側の余白に縦並びで表示し、左右いずれかの余白内へドラッグ移動できます。続きがあるカード表示領域の右端をフェードします。
- この版の Chrome Web Store への審査申請は行っていません。

## 0.23.0（ローカル更新）

- カード内をフラットな2カラムに整理し、右側を既定とする可動のパンくず・見出し・状態、左右の会話吹き出し、カードの縦横リサイズを追加しました。
- 1280×800で5レイアウトのライト・ダークを検証しました。既存の送信制御とエージェント環境は保持しています。
- この版のChrome Web Storeへの審査申請・公開は行っていません。


## ローカル検証版 0.22.0

- カードを開いたまま `j` / `k` で前後のカードへ移れるようにし、カードを開いている間のキー（`[` `]` `1`〜`3` `i` `o` `l` `g` `m` `h` `?`）と、使えるキーを操作の隣に小さく示す表示を追加しました。
- この版の Chrome Web Store への審査申請は行っていません。

## ローカル検証版 0.21.0

- サイドバーを「ビュー → レーン → 絞り込み」に整理し、絞り込みをアプリバーのチップで示すようにしました。見え方の好みは「レイアウトとテーマ」にまとめました。
- この版の Chrome Web Store への審査申請は行っていません。

## ローカル検証版 0.20.0

- アプリバーを1本にまとめ、管理はサイドバーの隣のパネル、分析と Agent Usage はカードと同じオーバーレイで開くようにしました。
- この版の Chrome Web Store への審査申請は行っていません。

## ローカル検証版 0.19.0

- カードの表示を、ボードの上に浮かぶ Trello 風のオーバーレイに戻しました（セッションは1枚、タスクは紐付いたセッションと横並び）。複数カードの同時表示と自由配置は廃止しました。
- この版の Chrome Web Store への審査申請は行っていません。下記の掲載・申請記録は 0.18.1 のものです。

## ローカル検証版 0.18.3

- 埋め込みホストで Trello レイアウトの背景が消える問題を修正しました。5種のレイアウトをライト・ダーク、1280×800で検証しました。
- この修正の Chrome Web Store への審査申請は行っていません。下記の掲載・申請記録は 0.18.1 のものです。

## ストア掲載情報

名前: Canban 0.18.1

拡張名はビルド時にバージョンを含め、アドレスバー左側にも表示します。

短い説明（manifest と同一）: Codex / Claude Code のセッションをカンバンで管理します。

カテゴリ: 仕事効率化 / ワークフローと計画

主要言語: 日本語（ja）

単一用途: Codex / Claude Code のセッションをカンバンで一覧表示し、整理・操作する。

詳細説明（ストアに貼り付ける本文）:

```text
Canban は、Codex / Claude Code のセッションを Chrome からカンバンで整理する拡張です。

セッションを一覧表示し、検索、分類、ラベル、メモで作業を整理できます。タスクをすばやく追加し、詳細画面でダッシュボードや進捗を確認できます。会話や実行状態を確認し、複数のセッションを並べて表示できます。Canban を利用している Codex / Claude の画面と、ボードの分類や表示設定を共有できます。

アーカイブされたセッションを指定のリストへ自動で移動できます。保存した自動化は「今すぐ実行」で、現在の条件に一致するカードへまとめて適用できます。

カードの依頼文やセッションへの指示に画像を添付し、利用するスキルを検索・選択できます。画像は選択・貼り付け・ドロップで追加でき、指示のキューにも保持します。

利用には Chrome 拡張に加え、コンピューターへの Canban 連携ソフトの導入が必要です。macOS / Linux と Node.js 22.13 以降に対応します。Chrome 拡張だけをインストールしてもセッションは表示されません。導入手順はサポートサイトをご覧ください。

1. サポートサイトの手順で Canban 連携ソフトを導入します。
2. インストールした拡張の ID を使って、ローカル連携を登録します。
3. Chrome の Canban アイコンをクリックしてボードを開きます。

セッションやメモを Canban 開発者のサーバーへ送信しません。閲覧履歴や一般のウェブページを読み取らず、広告や追跡機能もありません。使用量の更新時はCodex / Claudeの公式サービスと通信します（既定5分の自動更新は変更・停止可能）。アカウント追加はターミナル経由のログイン、または認証URLを任意のブラウザで開く方法を選べます。ChromeのプロファイルやSafariも選択できます。利用者がリモート接続や AI への指示の送信を選んだ場合は、利用者が設定した接続先と通信します。

Canban は MIT ライセンスのオープンソースです。ソース、導入手順、問い合わせ先:
https://github.com/kamihicouki/canban
```

サポート / ホームページ: https://github.com/kamihicouki/canban

プライバシーポリシー: https://github.com/kamihicouki/canban/blob/main/PRIVACY.md

## 画像

| 素材 | サイズ | ファイル / 状態 |
|---|---|---|
| ストアアイコン | 128×128 PNG | `chrome/icons/icon-128.png` |
| ツールバーアイコン | 16×16 / 48×48 PNG | `chrome/icons/icon-16.png`, `icon-48.png` |
| スクリーンショット | 1280×800 または 640×400 | `chrome/store/screenshot-board-0.16.0.jpg` / `screenshot-task-add.jpg`（1280×800、0.16.0 の同一 UI と隔離した MCP 開発ホスト・模擬データで撮影。ストア版インストールの動作証拠ではない） |
| 宣伝用タイル（任意） | 440×280 | 未作成 |

## 権限の説明

| 権限 | 審査向け説明 |
|---|---|
| nativeMessaging | The extension displays and manages the user's local Codex and Claude Code sessions through the Canban companion installed by the user. Native Messaging connects only to `com.kamihicouki.canban` on the same computer. The companion reads session metadata and conversations and stores board organization locally. User-initiated session actions use the installed agent applications. The companion also retrieves subscription usage from the official providers using locally stored account credentials and runs the official CLI for user-initiated account login in a terminal or displays its authorization URL for the user to open in their chosen browser. Browser selection reads only application and profile display names, never browser cookies or credentials. Credentials are not returned to the extension or developer. No browsing history or general website content is accessed. |

host_permissions、content_scripts、tabs、identity、storage 権限なし。リモート配信コードなし。拡張コードはすべて ZIP に同梱し、インラインスクリプトも除外する。

## プライバシー申告

添付画像と選択したスキルの名前・保存場所は利用者のコンピューターに保存します。画像はCanbanの保存先の `prompt-images/` に保持し、送信時に選択したAIへ渡します。SSH接続先に画像が必要な操作では、その接続先の `~/.canban-remote/prompt-images/` にも保存します。スキルの候補は利用者のマシン・プロジェクト・インストール済みプラグインのスキル定義から取得します。開発者への送信はありません。

開発者へのデータ収集・販売・広告利用なし。ローカル連携プロセスへ渡すデータは、会話・メモ・検索条件・作業フォルダー・実行状態など。指示送信や SSH 接続は利用者が設定した外部サービスを使うため、単に「外部通信は一切ない」とは申告しない。

Google の [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) は、ローカルだけで処理・保存するデータも開示が必要としている。ストアのフォームには Personal communications（会話）/ User activity（セッションの操作・実行状態）/ Website content（表示する会話テキストや生成コード）に加え、Authentication information（連携ソフトが使用量取得・ログインに使うローカル認証情報）の扱いを開示し、開発者への送信はないことを PRIVACY.md に記載する。閲覧履歴、決済、健康、位置情報を収集する機能はない。

販売しない、単一用途以外に使用・転送しない、信用情報・融資の判断に使用しない、の各宣言は実装と整合する。

## ストア項目

Publisher ID: `97689f5d-07e8-4c7c-85d6-465f31dc56d4`

ストア用拡張 ID: `kmnkdbmckholannmfhjfmceofmjdbndh`

管理画面: https://chrome.google.com/webstore/devconsole/97689f5d-07e8-4c7c-85d6-465f31dc56d4/kmnkdbmckholannmfhjfmceofmjdbndh/edit

2026-09-30 に 0.14.0 の ZIP をアップロードし、新規ドラフトを作成済み。説明・カテゴリ・日本語・アイコン・ボード画像・ホームページ・サポート URL、および単一用途・権限理由・リモートコード不使用・扱うデータ3種類・プライバシーポリシー URL は下書き保存済み。審査担当者向けの導入手順も保存済み。データ使用に関する3つの宣言はアカウント所有者の承認を受けて確定し、保存後の再読み込みで確認済み。公開連絡先もアカウント所有者が指定し、確認メールを送信済み（確認リンクは1時間有効）。管理画面の「送信できない理由」に残るのは、パブリッシャー連絡先メールの確認のみ。審査申請・公開は未実施。

検証: 本体のローカル未コミット変更を専用 worktree にコピーした状態で144テスト成功。公開 PR はその本体変更を含まない。ZIP の SHA-256 は `170a71343f1d846763795b59eb320729c4ca727fe14b2c8da30deecc0cea7cf0`。ストア版の実動作は未検証。

公開設定の Draft PR: https://github.com/kamihicouki/canban/pull/6 。GitHub の通常テストは Node.js 22/24 × Ubuntu/macOS の4ジョブで成功。配布パッケージの CI は、本体の `scripts/build-chrome.mjs` が未収録のため失敗しており、デプロイは実行されていない。

## 初回登録と継続デプロイ

初回ストア項目の作成、掲載情報、画像、プライバシー申告は Developer Dashboard で行う。API は既存項目のパッケージ更新用であり、新規項目や掲載文面を作成しない。

```sh
node scripts/package-chrome-web-store.mjs
```

成果物: `dist/canban-web-store.zip` と SHA-256。ZIP のルートに manifest.json を配置。ローカル連携ソフトは ZIP に含めない。

GitHub Actions の `chrome-web-store` Environment は作成済みで、Publisher ID とストア用拡張 ID を Variables に登録済み。OAuth Secrets 3件も登録済みで、2026-10-02 に production からの実申請で認証を確認した。初回設定・認証更新には以下を使う。値を文書やチャットに貼らない。

| 種別 | 名前 | 内容 |
|---|---|---|
| Variable | CWS_PUBLISHER_ID | Developer Dashboard の publisher ID |
| Variable | CWS_EXTENSION_ID | ストアで発行された32文字の拡張 ID |
| Secret | CWS_CLIENT_ID | Chrome Web Store API を有効にした Google Cloud の OAuth クライアント ID |
| Secret | CWS_CLIENT_SECRET | 同クライアントの secret |
| Secret | CWS_REFRESH_TOKEN | ストア項目を管理できるアカウントで `https://www.googleapis.com/auth/chromewebstore` を許可した refresh token |

Google 側の設定: https://developer.chrome.com/docs/webstore/using-api

OAuth のトークン更新に失敗した場合、HTTP ステータスと既知の定型エラーコードだけを表示する。`invalid_client` はクライアント ID / secret の組み合わせを確認し、`invalid_grant` は同じクライアントで再認可して新しい refresh token を取得する。`deleted_client` は Google Cloud 側でクライアントの状態を確認する。レスポンス全文や `error_description` は認証情報を含む可能性があるため表示しない。

公式 API 定義: https://chromewebstore.googleapis.com/$discovery/rest?version=v2

認証の作成・同意はアカウント所有者が行う。公式の順序は、Google Cloud で Chrome Web Store API を有効化 → OAuth 同意画面を設定 → Web application の OAuth client を作成（redirect URI: `https://developers.google.com/oauthplayground`）→ OAuth Playground の「Use your own OAuth credentials」に自分の client を設定 → `https://www.googleapis.com/auth/chromewebstore` をストア管理アカウントで認可 → authorization code を交換して refresh token を取得、となる。External / Testing 状態で発行する refresh token は通常7日で失効するため、運用用の OAuth 設定と Google の要件を確認してから認可する。GitHub の secret 登録には `gh secret set NAME --env chrome-web-store` の対話入力を使う。コマンド引数やログへ値を露出させない。

GitLab Flow で `main` を開発用、`production` をリリース用として運用する。PR / main 更新時は4構成のテストと ZIP 作成までで、ストアは更新しない。同じリポジトリの **main → production の PR** を必須チェック成功後にマージすると、production のコミットでテスト・ZIP検証を再実行し、ストアへアップロード・審査申請する。タグの push は公開処理を開始しない。

手動実行は production のみ公開でき、`upload`（アップロードのみ）か `publish`（審査申請）を選択できる。main やタグから手動実行しても公開ジョブは実行しない。GitHub Environment `chrome-web-store` の利用元も production のみに制限する。OAuth が未登録の場合は認証前に失敗し、申請成功とは扱わない。

アップロードには公開済みより新しいバージョンが必要。既存の審査待ちや staged の申請は保持し、先に Developer Dashboard で解決する。失敗時に自動再申請はしない。申請結果が不明な場合も先に状態を確認し、アップロードや申請を繰り返さない。

公開ジョブは ZIP のチェックサムと package.json のバージョンを検証し、`CWS_PACKAGE_VERSION` と `CWS_PACKAGE_SHA256` を渡す。API の読み戻しでは、申請状態に加えて同じバージョンが受理されたことを確認する。Actions の `canban-chrome-web-store-submission` 成果物には、状態・バージョン・production コミット・ZIP の SHA-256・実行 URL を保存する。OAuth の値は含めない。

同じストア項目へのデプロイを直列化する。既存の審査中・公開待ち申請がある場合、警告・ポリシー措置がある場合、アップロードが失敗した場合は停止する。申請後は API で状態を再取得する。`PENDING_REVIEW` は審査待ちであり、公開済みではない。

公開後の確認: ストアの公開 URL、バージョン、ストアからのインストール、ストア ID に対する Native Messaging 登録、ボード表示と基本操作を確認する。開発用拡張 ID を流用しない。

## production からの初回申請の証跡（2026-10-02）

[main → production のリリース PR #22](https://github.com/kamihicouki/canban/pull/22) のマージを起点に、実ストアへ 0.16.0 をアップロードし、審査申請した。最初の認証失敗後、アカウント所有者が OAuth を再認可・Secrets を再登録し、同じ Actions 実行を再実行して成功した。申請直後の API 読み戻しで、対象バージョンと `PENDING_REVIEW` を確認した。

| 項目 | 確認結果 |
|---|---|
| バージョン | `0.16.0` |
| production コミット | `08136c0a0e490031a430aaf9501ce3ddf0a8d20c` |
| Actions | [36951952423](https://github.com/kamihicouki/canban/actions/runs/36951952423) / attempt 2 / success |
| ZIP SHA-256 | `fe0e2bdd5b8c7a89fd1b5f47ed3964e4dd41525cd9602cfe7553268c6cdff2f2` |
| 申請後の状態 | `PENDING_REVIEW`（審査待ち） |
| ストア拡張 ID | `kmnkdbmckholannmfhjfmceofmjdbndh` |

同じ production コミットの Ubuntu/macOS × Node 22/24 の4構成テスト、ZIP 作成・バージョンとチェックサムの検証、実アップロード、審査申請、API 読み戻し、申請証跡の保存がすべて成功した。Actions の `canban-chrome-web-store-submission` 成果物に含まれる JSON と配布 ZIP をダウンロードし、上記バージョン・production SHA・拡張 ID・ZIP の SHA-256 を照合した。

production の保護は、PR 必須・承認0人・管理者にも適用・6つの必須チェック・最新 production を含むこと・強制更新と削除の禁止を確認した。main / 開発 PR で deploy が省略されること、[main 以外を取り込み元にした検証 PR #20](https://github.com/kamihicouki/canban/pull/20) のチェック失敗とマージ拒否、production への直接 push 拒否を実際に確認した。タグの公開トリガーを削除し、Environment の利用元が production ブランチのみであることも設定で確認した。

申請前の公開版は 0.15.0。0.16.0 の審査承認・一般公開・公開後の実機動作確認は、この申請成功の記録には含まない。既存 checkout・未コミット変更・Native Messaging Host は保持した。

## 0.18.1 の申請の証跡（2026-10-04）

[main → production のリリース PR #30](https://github.com/kamihicouki/canban/pull/30) のマージを起点に、実ストアへ 0.18.1 をアップロードし、審査申請した。申請直後の API 読み戻しで、対象バージョンと `PENDING_REVIEW` を確認した。

| 項目 | 確認結果 |
|---|---|
| バージョン | `0.18.1` |
| production コミット | `c0cfc43fcc33be3b3a326a0cb41396cbcc53f363` |
| Actions | [37176095294](https://github.com/kamihicouki/canban/actions/runs/37176095294) / success |
| ZIP SHA-256 | `7c7e15be46339f1da1ff261eb14dceda3ffc8eb0edb95078247e9208ca9fd9fb` |
| 申請後の状態 | `PENDING_REVIEW`（審査待ち） |
| ストア拡張 ID | `kmnkdbmckholannmfhjfmceofmjdbndh` |

同じ production コミットで、Ubuntu/macOS × Node 22/24 の4構成テスト、ZIP 作成、バージョンとチェックサムの検証、実アップロード、審査申請、申請証跡の保存がすべて成功した。Actions の `canban-chrome-web-store-submission` 成果物の JSON をダウンロードし、上記のバージョン・production SHA・拡張 ID・ZIP の SHA-256 を照合した。

画面が Trello 基調に変わったため、ストアの掲載画像は差し替えが必要（Developer Dashboard で手作業）。0.18.1 の審査承認・一般公開・公開後の実機動作確認は、この申請成功の記録には含まない。

## 審査担当者向け導入手順

Node.js 22.13 以降、macOS または Linux、Codex / Claude Code のローカルセッションが必要。Windows のローカル連携は未対応。

```sh
git clone --branch production https://github.com/kamihicouki/canban.git
cd canban
npm run install:chrome-native-host -- --extension-id kmnkdbmckholannmfhjfmceofmjdbndh
```

Chrome の Canban アイコンからボードを開く。認証用の Canban アカウントは不要。セッションがない場合は空の一覧になる。ローカル連携ソフトがない場合は接続エラーと導入方法を表示する。

## バージョン履歴

2026-10-02: 0.16.4。Codexプラグインの導入元をGit管理ファイルだけの配布物へ変更し、ローカル保存データのコピーを防止。Chromeとの版を同期。ストア拡張の権限・外部通信の変更なし。

2026-10-02: 0.16.3。ローカル開発環境の設定・共有データをrepo配下へ集約。固定IDのテスト版更新をrepo管理のコマンドに移行。ストア拡張の権限・外部通信の追加なし。

2026-10-02: 0.16.2。アカウント追加のターミナル経由／任意ブラウザ認証を復元。認証URLのコピー、Chromeプロファイル／Safariの選択、Claudeのコード入力、ターミナル起動失敗時のコマンドコピーに対応。拡張権限は変更なし。ブラウザの一覧取得は名称・プロファイル表示名のみで、Cookieやブラウザの認証情報は読み取りません。認証URLとコードはログやボード設定へ保存せず、公式CLIの認証情報は専用保存先内で扱います。アカウント追加と認証画面の掲載画像は更新対象です。

2026-10-02: 0.16.1。会話欄の高さにフッターを含め、会話一覧と外側セクションの二重スクロールを解消。package / MCP manifest / Codex plugin / Chrome build の番号を同期。権限・データ利用・掲載画像の変更はなし。

2026-10-02（開発中）: アーカイブ変更をきっかけにする自動化と、各ルールの手動実行を追加。権限の追加はなし。自動化画面の画像は公開前に更新する。

2026-10-02: 0.16.0 の公開準備。`origin/main` の `03702abfb06cb402c24883846fc4e93420e6ba11` を基に、公開済み 0.15.0 と重複しないよう package / MCP manifest / Codex plugin の番号を更新。タスクのクイック追加、タスク詳細ダッシュボード、ワークスペース表示と属性継承の改善を含む。権限とデータ利用区分は変わらない。変更前のmain push の4構成テストとパッケージ作成は成功済み。公開版の実機動作確認は別途必要。

2026-10-02: 0.15.0 の一般公開を Dashboard と公開ストアページで確認。パブリッシャー連絡先メール確認・審査申請は完了。公開 URL: https://chromewebstore.google.com/detail/canban/kmnkdbmckholannmfhjfmceofmjdbndh 。

2026-09-30: 0.14.0 のローカル拡張ソースを使った ZIP 作成、ストア用アイコン、プライバシー文書、API v2 デプロイの準備。ストア項目を新規作成し ZIP のアップロードまで実施。審査申請・掲載は未実施。

## 公開前チェック

- [x] GitHub OSS 公開、MIT ライセンス
- [x] Manifest V3、nativeMessaging のみ、ローカル同梱コード
- [x] 個別サイズの PNG、配布ファイルの allowlist、ZIP の整合性確認
- [x] 掲載文面、権限説明、プライバシーポリシーの作成
- [x] 拡張本体の開発変更を main に統合
- [x] Developer Dashboard の本人確認・開発者登録確認
- [x] ストア項目作成、掲載画像・分類・言語、データ種類とテスト手順の保存
- [x] データ使用の3つの宣言の確定と保存後の再確認
- [x] 公開連絡先メールの本人確認
- [x] GitHub Environment の認証設定と実申請での認証確認
- [x] production から 0.16.0 の審査申請と同じバージョンの API 読み戻し
- [ ] 0.16.0 の審査承認・一般公開
- [ ] 0.16.0 の公開ストアからの動作確認
- [x] production から 0.18.1 の審査申請と同じバージョンの API 読み戻し
- [ ] 0.18.1 用の掲載画像の差し替え
- [ ] 0.18.1 の審査承認・一般公開
- [ ] 0.18.1 の公開ストアからの動作確認

## 0.15.0 の統合後の確認（2026-09-30）

- 本体 main: `ec52360c7ac38b717b0404d622b00d6b718d3ef1`。SQLite・Chrome・共通画面の実装コミットを祖先として確認。main の4構成CIは成功。
- 公開設定と最新 main を隔離した worktree で統合し、Node.js 22 の172テストが成功。
- 最新本体から生成した公開用 ZIP: version 0.15.0、SHA-256 `411e011ff7c7408829b728808d2d86237eb8001971329d7b00d47c06a2bc9163`。ルートmanifestと9ファイルのallowlistを確認。
- ストアの下書きには旧0.14.0が残る。最新ZIPのアップロード、掲載画像の更新、mainのプライバシーURLへの変更はこれから行う。
- GitHub Environment のOAuth Secrets 3件は未登録。審査送信ボタンは無効のまま。公開連絡先の確認完了は未確認。
- Native Messaging にストアID `kmnkdbmckholannmfhjfmceofmjdbndh` を追加し、既存の開発用IDを保持して読み戻し確認済み。ストア版のインストール・表示・基本操作の確認は残る。
- 最新UIの掲載画像を1280×800のPNGとして再撮影済み。隔離した実MCP開発ホストと模擬セッションを使い、個人データを含まない。ストア下書きへの反映と実拡張操作は残る。

この記録は審査申請・公開完了の証拠ではない。公開までの追跡は継続する。

公開設定 PR #6 は main `1d151bc2f68dc2d33ca0188aac32d829cac3ac9e` へ統合済み。main の公開用パッケージジョブは成功、プライバシーURLはHTTP 200。通常CIの競合テストで初期接続の競合と厳密な時間判定の失敗が発生したため、書き込み開始の同期とCIのテストファイル直列化を追加して確認する。10クライアント・1,000更新と2秒上限は維持する。SQLite単独11件（Node 24）とlive単独10件（Node 22）は成功。

CI修正 PR #7 は main `46adfb01f6f4c28b4800616cecf975482c59913a` へ統合済み。統合後のUbuntu/macOS × Node.js 22/24の4構成と公開用パッケージジョブはすべて成功。ローカル全体直列再実行では172件中171件成功、1件の時間依存失敗が残る（GitHubの同じテストは4構成で成功）。最新版UIの掲載画像を撮影し、旧版画像を差し替えた。まだ審査申請・公開は行っていない。

掲載画像更新 PR #8 は main `ce1195c8d66b54d2a098550ee7c463c7004340d6` へ統合済み。再生成ZIPのSHA-256は `64cec6dd218c1035d49bfbb44818b205f24dec7a3f9b87e54e0dba4054be6661`。このmainのpackageジョブは成功したが、通常CIでロック後片付けまで含む時間判定が1件失敗。競合書き込みの拒否を受け取った時点で経過時間を記録し、テスト用ロックのROLLBACK・closeの所要時間を除く修正を行った。2,100msの判定閾値は維持する。

時間測定の修正後もmacOS CIで拒否まで約2.24秒かかったため、DB再試行の待機後に残り時間を再確認する修正を追加。単調増加の時計で2秒の予算を測り、250msのSQLite busy timeoutを消費する余裕がない場合は次のDB操作を開始しない。タイマーが遅れて戻る回帰テストは修正前に失敗、修正後に成功。SQLite関連14件が成功した。PR #9で統合前CIを確認する。

PR #9は main `601027ac547d5790ed4a6bcceccf8aee082ae3eb` へ統合済み。最終mainで内部の再試行時間が約2.13秒となる失敗を確認し、SQLiteの設定待機250msにOSの実行遅延分250msを加え、各試行に500msの余裕を確保する修正を追加した。2秒の再試行予算とテストの2,100ms閾値は変えない。遅いネイティブ待機の回帰テストは修正前に失敗、修正後に成功。ローカルSQLite関連15件では14件成功、1,000更新テストの実時間が2,119msとなった1件が失敗。期限確認の回帰・競合拒否の5件は単独で成功。統合前CIで全体を確認する。

PR #10は main `897ee4c69008fecfbb5917ba6b5bac849a66bbc5` へ統合済み。PR head `06a1f506329db8ba81c113a2f69d004326bea4a4` のUbuntu/macOS × Node.js 22/24の4構成CIは成功し、mainとtreeが同一であることを確認した。main自体のCI実行記録が未作成のため、テスト専用workflowに手動実行の入口を追加する。公開APIを呼ぶworkflowとは独立しており、認証情報の登録前でもmainの検証だけを実行できる。

このmainから作成済みの0.15.0 ZIPのSHA-256は `8f95897b88b2b3282c98722d52ce5098e845139ef69b7dcd7fb2de9f97f6a86c`。ストア下書きへの最新ZIP・画像・mainのプライバシーURLの反映は未実施。2026-09-30 14:00 UTC時点ではMacがロックされ、管理画面の最新状態を確認できていない。GitHub EnvironmentのOAuth Secretsは未登録。OAuthは継続デプロイ用であり、Dashboardからの初回申請は連絡先メール確認などの条件が整えば進められる。審査申請・実際の公開・ストアからの動作確認は未完了。

## クイック追加のUI更新（0.16.0 の申請準備）

- 全画面の「＋ タスク」と、列・レーンからの属性継承を追加。2026-10-02 に隔離した模擬セッションでボードとタスク追加フォームの掲載画像を更新済み。
- Chromeの権限追加はなく、タスクの所属情報は従来のローカル保存先に保持する。

2026-10-02: 0.16.5。通常Chromeのユーザーデータは `~/.canban/` に保存し、checkoutの開発設定を適用しない。明示した `CANBAN_DATA_DIR` は優先。拡張の権限・外部通信の変更なし。

2026-10-03: 0.16.6。Chromeで通信の遅れを直列通信と誤判定して警告が出る問題を修正し、リアルタイム更新を維持。拡張の権限・保存先・外部通信の変更なし。

2026-10-03: 0.16.7。macOSのDocuments保護でローカル連携プロセスが終了する問題に対応し、連携ソフトをApplication Supportへ配布して起動する。LinuxはXDGデータ領域を使用。既存の連携ソフトはホスト登録コマンドで更新する。拡張の権限・ユーザーデータの保存先・外部通信の変更なし。

2026-10-03: 0.16.8。Chrome導入手順を配布先ランチャーと現在の更新方式に合わせて修正。拡張の権限・実行処理・保存先・外部通信の変更なし。

2026-10-03: 0.16.9。既存アカウントの再ログインにもブラウザ起動・認証URLコピーを提供し、成功後にそのアカウントの使用量を更新。利用枠は取得データに存在する枠だけを表示し、週間枠のみの場合の余分な未取得表示を解消。拡張の権限・ユーザーデータの保存先・外部通信先の変更なし。

2026-10-03: 0.16.10。カードとセッションの入力欄に画像添付・スキル選択を追加。画像・スキルを下書き、キュー、履歴に保持。画像はローカルのCanban保存先と、必要に応じて利用者が選んだSSH接続先に保存し、指示送信時に選択したAIへ渡す。Chromeの追加権限なし。入力欄のスクリーンショットは更新対象。

2026-10-03: 0.17.0。Trello 基調の画面（2段のヘッダー、ワークスペースサイドバー、右から出るメニュー）、新しいロゴ、線のアイコン、ライト・ダーク・システムのテーマ切り替え、4段構造で高さを揃えたカードに更新。拡張の権限・実行処理・保存先・外部通信の変更なし。

2026-10-03: 0.18.0。レイアウトを5種（Trello・定番・レール・オムニバー・ライブ HUD）から選べるようにし、色のテーマと別々に保存。拡張の権限・実行処理・保存先・外部通信の変更なし。

2026-10-04: 0.18.1。Trello 基調の画面・レイアウトと、指示入力の画像添付・スキル選択、拡張名のバージョン表示を統合。拡張の権限・実行処理・保存先・外部通信の変更なし。

2026-10-04: 0.18.2。0.18.1 の審査申請（PENDING_REVIEW）を記録。拡張の機能・権限・実行処理・保存先・外部通信の変更なし。

0.23.7: Codex本体のアーカイブ・復元・削除に接続。「隠す」を撤去。Claudeとリモートの履歴操作APIは未対応で、操作理由を表示します。

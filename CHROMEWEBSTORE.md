# Chrome Web Store — Canban

最終更新: 2026-09-30

## ストア掲載情報

名前: Canban

短い説明（manifest と同一）: Codex / Claude Code のセッションをカンバンで管理します。

カテゴリ: 仕事効率化 / ワークフローと計画

主要言語: 日本語（ja）

単一用途: Codex / Claude Code のセッションをカンバンで一覧表示し、整理・操作する。

詳細説明（ストアに貼り付ける本文）:

```text
Canban は、Codex / Claude Code のセッションを Chrome からカンバンで整理する拡張です。

セッションを一覧表示し、検索、分類、ラベル、メモで作業を整理できます。会話や実行状態を確認し、複数のセッションを並べて表示できます。Canban を利用している Codex / Claude の画面と、ボードの分類や表示設定を共有できます。

利用には Chrome 拡張に加え、コンピューターへの Canban 連携ソフトの導入が必要です。macOS / Linux と Node.js 22.13 以降に対応します。Chrome 拡張だけをインストールしてもセッションは表示されません。導入手順はサポートサイトをご覧ください。

1. サポートサイトの手順で Canban 連携ソフトを導入します。
2. インストールした拡張の ID を使って、ローカル連携を登録します。
3. Chrome の Canban アイコンをクリックしてボードを開きます。

セッションやメモを Canban 開発者のサーバーへ送信しません。閲覧履歴や一般のウェブページを読み取らず、広告や追跡機能もありません。利用者がリモート接続や AI への指示の送信を選んだ場合は、利用者が設定した接続先と通信します。

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
| スクリーンショット | 1280×800 または 640×400 | `chrome/store/screenshot-board.jpg`（1280×800、同一 UI と隔離した MCP 開発ホスト・テストデータで撮影。ストア版インストールの動作証拠ではない） |
| 宣伝用タイル（任意） | 440×280 | 未作成 |

## 権限の説明

| 権限 | 審査向け説明 |
|---|---|
| nativeMessaging | The extension displays and manages the user's local Codex and Claude Code sessions through the Canban companion installed by the user. Native Messaging connects only to `com.kamihicouki.canban` on the same computer. The companion reads session metadata and conversations and stores board organization locally. User-initiated session actions use the installed agent applications. No browsing history or website content is accessed. |

host_permissions、content_scripts、tabs、identity、storage 権限なし。リモート配信コードなし。拡張コードはすべて ZIP に同梱し、インラインスクリプトも除外する。

## プライバシー申告

開発者へのデータ収集・販売・広告利用なし。ローカル連携プロセスへ渡すデータは、会話・メモ・検索条件・作業フォルダー・実行状態など。指示送信や SSH 接続は利用者が設定した外部サービスを使うため、単に「外部通信は一切ない」とは申告しない。

Google の [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) は、ローカルだけで処理・保存するデータも開示が必要としている。ストアのフォームには Personal communications（会話）/ User activity（セッションの操作・実行状態）/ Website content（表示する会話テキストや生成コード）を選択し、開発者への送信はないことを PRIVACY.md に記載する。閲覧履歴、決済、健康、位置情報を収集する機能はない。

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

GitHub Actions の `chrome-web-store` Environment は作成済みで、Publisher ID とストア用拡張 ID を Variables に登録済み。OAuth secrets は未作成・未登録。以下を設定する。値を文書やチャットに貼らない。

| 種別 | 名前 | 内容 |
|---|---|---|
| Variable | CWS_PUBLISHER_ID | Developer Dashboard の publisher ID |
| Variable | CWS_EXTENSION_ID | ストアで発行された32文字の拡張 ID |
| Secret | CWS_CLIENT_ID | Chrome Web Store API を有効にした Google Cloud の OAuth クライアント ID |
| Secret | CWS_CLIENT_SECRET | 同クライアントの secret |
| Secret | CWS_REFRESH_TOKEN | ストア項目を管理できるアカウントで `https://www.googleapis.com/auth/chromewebstore` を許可した refresh token |

Google 側の設定: https://developer.chrome.com/docs/webstore/using-api

公式 API 定義: https://chromewebstore.googleapis.com/$discovery/rest?version=v2

認証の作成・同意はアカウント所有者が行う。公式の順序は、Google Cloud で Chrome Web Store API を有効化 → OAuth 同意画面を設定 → Web application の OAuth client を作成（redirect URI: `https://developers.google.com/oauthplayground`）→ OAuth Playground の「Use your own OAuth credentials」に自分の client を設定 → `https://www.googleapis.com/auth/chromewebstore` をストア管理アカウントで認可 → authorization code を交換して refresh token を取得、となる。External / Testing 状態で発行する refresh token は通常7日で失効するため、運用用の OAuth 設定と Google の要件を確認してから認可する。GitHub の secret 登録には `gh secret set NAME --env chrome-web-store` の対話入力を使う。コマンド引数やログへ値を露出させない。

PR / main 更新時はテストと ZIP 作成のみ。`chrome-v<package.json の version>` タグを push すると審査申請し、承認後に公開する。手動実行は main のみ、`upload`（アップロードのみ）か `publish`（審査申請）を選択できる。拡張本体 0.15.0 は main に統合済み。OAuth Secrets と公開連絡先確認が揃ってから初回申請する。

同じストア項目へのデプロイを直列化する。既存の審査中・公開待ち申請がある場合、警告・ポリシー措置がある場合、アップロードが失敗した場合は停止する。申請後は API で状態を再取得する。`PENDING_REVIEW` は審査待ちであり、公開済みではない。

公開後の確認: ストアの公開 URL、バージョン、ストアからのインストール、ストア ID に対する Native Messaging 登録、ボード表示と基本操作を確認する。開発用拡張 ID を流用しない。

## 審査担当者向け導入手順

Node.js 22.13 以降、macOS または Linux、Codex / Claude Code のローカルセッションが必要。Windows のローカル連携は未対応。

```sh
git clone https://github.com/kamihicouki/canban.git
cd canban
npm run install:chrome-native-host -- --extension-id kmnkdbmckholannmfhjfmceofmjdbndh
```

Chrome の Canban アイコンからボードを開く。認証用の Canban アカウントは不要。セッションがない場合は空の一覧になる。ローカル連携ソフトがない場合は接続エラーと導入方法を表示する。

## バージョン履歴

2026-09-30: 0.14.0 のローカル拡張ソースを使った ZIP 作成、ストア用アイコン、プライバシー文書、API v2 デプロイの準備。ストア項目を新規作成し ZIP のアップロードまで実施。審査申請・掲載は未実施。

## 公開前チェック

- [x] GitHub OSS 公開、MIT ライセンス
- [x] Manifest V3、nativeMessaging のみ、ローカル同梱コード
- [x] 個別サイズの PNG、配布ファイルの allowlist、ZIP の整合性確認
- [x] 掲載文面、権限説明、プライバシーポリシーの作成
- [ ] 拡張本体の開発変更を main に統合
- [x] Developer Dashboard の本人確認・開発者登録確認
- [x] ストア項目作成、掲載画像・分類・言語、データ種類とテスト手順の保存
- [x] データ使用の3つの宣言の確定と保存後の再確認
- [ ] 公開連絡先メールの確認（確認メール送信済み）
- [ ] GitHub Environment の認証設定
- [ ] 審査申請、承認、公開ストアからの動作確認

## 0.15.0 の統合後の確認（2026-09-30）

- 本体 main: `ec52360c7ac38b717b0404d622b00d6b718d3ef1`。SQLite・Chrome・共通画面の実装コミットを祖先として確認。main の4構成CIは成功。
- 公開設定と最新 main を隔離した worktree で統合し、Node.js 22 の172テストが成功。
- 最新本体から生成した公開用 ZIP: version 0.15.0、SHA-256 `411e011ff7c7408829b728808d2d86237eb8001971329d7b00d47c06a2bc9163`。ルートmanifestと9ファイルのallowlistを確認。
- ストアの下書きには旧0.14.0が残る。最新ZIPのアップロード、掲載画像の更新、mainのプライバシーURLへの変更はこれから行う。
- GitHub Environment のOAuth Secrets 3件は未登録。審査送信ボタンは無効のまま。公開連絡先の確認完了は未確認。
- Native Messaging の既存登録は開発用IDのみ。ストアIDの追加とストア版のインストール・表示・基本操作の確認は公開工程で行う。
- 最新UIの掲載画像と実拡張操作は未確認。Chromeが他の操作と競合しているため、現時点の画像は旧版の参考画像。

この記録は審査申請・公開完了の証拠ではない。公開までの追跡は継続する。

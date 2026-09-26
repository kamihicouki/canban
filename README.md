# Canban

**Canban** は、Codex と Claude Code のセッションを Trello 風のカンバンで管理できる **Codex デスクトップアプリのサイドバーアプリ**です。

![Canban](docs/screenshot.png)

- **このマシン**と、Codex アプリに登録済みの **SSH リモート接続**上のセッションを、ひとつのボードで扱えます。
- リストは自由に追加・改名・並べ替え・削除できます。カードはドラッグ＆ドロップで移動できます。ラベル・メモ・優先度・期限・WIP 制限にも対応しています。
- カードから**ワンクリックでセッションを再開**できます。再開先は、Codex / Claude のデスクトップアプリか、ターミナル（新規ウィンドウ / 新規タブ / 分割 / 既存ウィンドウ）を選べます。
- セッション本体は**一切書き換えません**（読み取り専用）。Canban 側の情報は `~/.canban/board.json` にだけ保存します。

> English summary: Canban is a Codex desktop sidebar app that puts your Codex and Claude Code sessions — local and on SSH hosts registered in Codex — on a Trello-style board. It never modifies agent data (read-only), stores its own state in `~/.canban`, and can resume any session in the agent's desktop app or in your terminal (new window / tab / split / current window). Requires Node.js ≥ 22.13.

## 必要なもの

- Codex デスクトップアプリ（サイドバーアプリ／MCP Apps に対応した版）
- Node.js 22.13 以上（`node:sqlite` を使います。外部依存はありません）
- 任意: Claude Code（CLI）と Claude デスクトップアプリ
- 任意（リモート）: SSH の鍵認証で接続できること、リモート側に `python3` があること

## インストール

1. リポジトリを `~/plugins/canban` に置きます。

   ```bash
   git clone https://github.com/kamihicouki/canban.git ~/plugins/canban
   ```

2. 個人マーケットプレイス `~/.agents/plugins/marketplace.json` に登録します（ファイルが無ければ作成します）。

   ```json
   {
     "name": "personal",
     "interface": { "displayName": "Personal" },
     "plugins": [
       {
         "name": "canban",
         "source": { "source": "local", "path": "./plugins/canban" },
         "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
         "category": "Productivity"
       }
     ]
   }
   ```

3. インストールします。Codex アプリの「プラグイン」画面から入れるか、CLI で次を実行します。

   ```bash
   codex plugin add canban@personal
   ```

4. Codex アプリを再起動します。Explore に出てくる **Canban** をサイドバーにピン留めします。
   チャットで「Canban を開いて」と頼んでも開けます。

## 使い方

### 再開の経路とショートカット

ヘッダの「⚙ 再開」で既定の動作を変えられます。設定できるのは、デスクトップアプリで開くかターミナルで開くか、使うターミナル、開き方の 3 つです。

| 操作 | 動作 |
|---|---|
| ▶（カード右上）／ 詳細の「再開」ボタン | 既定の方法で再開 |
| ⌥ + クリック | デスクトップアプリとターミナルを入れ替えて再開 |
| ⇧ + クリック | ターミナルの新規ウィンドウで再開 |
| ⌘ + クリック | ターミナルの新規タブで再開 |
| ⌃ + クリック | ターミナルの既存ウィンドウで再開 |
| カード選択中に `o` / `d` / `t` | 既定 / デスクトップアプリ / ターミナル |
| カード選択中に `w` / `n` / `s` / `e` | 新規ウィンドウ / 新規タブ / 分割 / 既存ウィンドウ |
| カード選択中に ← / → | 隣のリストへ移動 |
| カード選択中に ↑ / ↓、Home / End | リスト内で上下に移動、先頭 / 末尾へ移動 |
| ⌥ + 矢印 | カードを動かさずにフォーカスだけ移動 |

エージェントごとに、次のリンクやコマンドで再開します。

- **Codex**: `codex://threads/<id>` で開きます。リモートのセッションは `?hostId=<接続ID>` を付けて、手元の Codex アプリから開きます。ターミナルでは `codex resume <id>` を実行します。
- **Claude Code**:
  - Claude デスクトップに記録があるセッションは `claude://code/continue?session=local_…` で開きます。
  - CLI だけで使ったセッションは `claude://resume?session=<id>` で開きます。Claude デスクトップがそのセッションを取り込んで、続きから表示します（取り込みは Claude アプリ側の処理で、Canban はデータに触れません）。
  - Claude の設定で OS からの起動（エントリポイント）が無効になっていると、リンクは無視されます。
- **リモート**: ターミナルで `ssh -t <alias> 'cd <cwd>; <再開コマンド>'` を実行します。
- **対応ターミナル**: Ghostty（1.3 以上、AppleScript 対応版）、Terminal.app、iTerm2。
  - Terminal.app の「新規タブ」は、System Events の操作許可（アクセシビリティ）が必要です。
  - 対応していない開き方を選んだ場合は、新規ウィンドウで開きます。

### タスクカードと新規セッション

各リストの下の「＋ カードを追加」で、セッションに紐づかない**タスクカード**を作れます。Trello と同じく Enter で続けて追加できます。

- タスクの詳細で、エージェント（Codex / Claude Code）・マシン・作業フォルダ・依頼文を選び、新しいセッションを開始できます。
  - 開始先は、デスクトップアプリ（`codex://threads/new?prompt=&path=`、`claude://code/new?q=&folder=`、リモートは `ssh_host` / `ssh_folder`）またはターミナルです。
- 開始したセッションは、エージェント・マシン・フォルダ・依頼文の書き出しが一致すると、**自動でカードに紐付き**ます。
- 既存のセッションカードを**タスクカードの上にドラッグ**しても紐付けられます。セッションの詳細にある「タスク」欄からも紐付けられます。
- 紐付いたセッションは、タスクカードの中に状態付きで並びます。▶ で最新のセッションを再開できます。
- 紐付いたセッションの状態が変わると、自動移動ルールではタスクカードのほうが動きます。
- Codex のサブエージェントは、親カードに「🤖 件数」として表示し、詳細で一覧できます。

### 実行状態と自動移動ルール

カードに、セッションの実行状態が色付きの点で表示されます。

| 状態 | 表示 | 判定のしかた |
|---|---|---|
| 実行中 | 青（点滅） | ターンの途中。15 分間書き込みが無ければ「待機」に戻す |
| 入力待ち | 橙 | エージェントが質問して回答を待っている（`request_user_input` / `AskUserQuestion` など） |
| 完了 | 緑 | 直近のターンが終わった |
| 中断 | 赤 | ターンが中断された |

- 判定するのは、24 時間以内に更新されたセッションだけです。ログの末尾を読み取り専用で読んで判定します。
- ヘッダの集計ボタンを押すと、その状態のカードだけを表示します。
- 前回見たあとに動きがあったカードには「新着」を付けます。「✓ 既読」でまとめて消せます。
- 「⚡ ルール」では「完了したら 進行中 → レビュー」のような自動移動を設定できます。初期状態はすべてオフです。
  - ルールが動くのは、状態が**変わった瞬間**だけです。
  - Codex が起動していれば、ボードを閉じていても 60 秒ごとに評価します。
  - 自動で動いたカードには ⚡ が付き、直後のお知らせから元に戻せます。
  - 直前の状態は、Canban 専用の `~/.canban/status.json` に保存します。

### リモートのセッション

ヘッダの「マシン」に、Codex アプリに登録済みのリモート接続が並びます（`~/.codex/.codex-global-state.json` から読み取り専用で取得します）。

- 読み込むホストを個別にオンにします。初期状態はすべてオフです。
- オンにしたホストには `ssh -o BatchMode=yes <alias> python3 -` で接続し、同梱の読み取り専用スクリプト（[server/remote/collect.py](server/remote/collect.py)）を実行します。
- 結果は 60 秒キャッシュします。応答しないホストがあってもボードは待たされず、エラーとして表示されます。
- ホスト名をクリックすると、そのマシンのセッションだけを表示します。

## データと安全性

| 対象 | 扱い |
|---|---|
| `~/.codex/state_*.sqlite`、`~/.codex/sessions/**` | 読み取り専用（SQLite の read-only モード＋`PRAGMA query_only`） |
| `~/.claude/projects/**`、Claude デスクトップのセッション情報 | 読み取り専用 |
| `~/.canban/board.json`、`~/.canban/status.json` | Canban が書き込むファイル（Canban 専用のディレクトリ） |

詳しくは [SECURITY.md](SECURITY.md) を参照してください。

## しくみ

- Codex の MCP サーバーとして動く **MCP App** です。`open_canban` ツールの `_meta["openai/ui"]` に `{ "entrypoints": [{ "type": "global" }] }` を宣言すると、Codex の Explore とサイドバーに項目が現れます。
  - **これは Codex アプリの実装を調べて見つけた未公開の仕様**なので、将来の更新で変わる可能性があります。
- UI は 1 枚の HTML です（`ui://canban/board.html`、`text/html;profile=mcp-app`）。MCP Apps の postMessage ブリッジを通じて、`canban_*` ツールを呼び出します。

```
server/
  index.mjs            MCP サーバー（stdio / JSON-RPC）
  board.mjs            セッション一覧とカンバン状態を合成
  store.mjs            ~/.canban/board.json（唯一の書き込み先）
  agents.mjs           エージェントごとの再開リンクとコマンド
  launcher.mjs         デスクトップリンクとターミナルの起動
  sources/             Codex / Claude / リモート接続の読み取り専用リーダー
  remote/collect.py    リモートで動く収集スクリプト（Python 標準ライブラリのみ）
  remote/pool.mjs      SSH の並列実行・キャッシュ・タイムアウト
ui/board.html          ボード UI
```

## 開発

```bash
npm test          # フィクスチャを使ったテスト（Node.js のテストランナー）
npm run dev       # http://localhost:4517/direct で UI を確認（起動処理は dry-run）
```

環境変数:

| 変数 | 用途 |
|---|---|
| `CANBAN_DATA_DIR` | データの保存先 |
| `CANBAN_CODEX_HOME` / `CANBAN_CLAUDE_HOME` / `CANBAN_CLAUDE_DESKTOP_DIR` | 読み取り元の差し替え |
| `CANBAN_SSH` | ssh コマンドの差し替え |
| `CANBAN_LAUNCH_DRYRUN=1` | アプリやターミナルを実際には開かず、ログだけ出す |

Issue や PR を歓迎します。

## ライセンス

[MIT](LICENSE)

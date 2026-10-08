# カードUI/UX（0.25.x）の確認画面

1280×800 で撮影。dev サーバー（`tests/dev-host.mjs`）の `/direct?theme=light|dark`。

| ファイル | 内容 |
|---|---|
| `board-light.jpg` / `board-dark.jpg` | ボードの標準カードと、`Space` で開いたその場返信 |
| `thread-changes-light.jpg` | スレッド詳細（折りたたみの会話・チップの入力欄）と、右の変更パネル（差分） |
| `task-thread-light.jpg` | タスクカードの隣に開いたセッションと、スレッドの帯 |
| `task-dark.jpg` | ダークのタスクカード詳細と、隣のセッションのスレッド詳細 |
| `inbox-dark.jpg` | ボードの表示「受信トレイ」。右ペインで返事を整形して読む |

レイアウトテーマ（レール・オムニバー・ライブ HUD）でも、カード詳細とカードが崩れないことを確認した。元のプレビューは `prototypes/card-codex-ux/index.html`。

# ヘッダーなし2列のカードワークスペース

ユーザーの明示依頼により標準のカード詳細を変更し、以前のヘッダー型もビューとして残す。Fable 5.2の比較を受け、ボードでは左に文脈・右に既存会話。ドックでは一覧を活かし、文脈は必要時に開く。

1. paneGlobal.shape=workspace/cardを共有保存。w・⌘K・既存カード表示メニューから切替。配置のfull/split/sheetとは別軸。
2. 新card-workspace.js/cssが既存head/meta/操作/タスクスレッドのノードを左列へ移し、戻す。会話とcomposerを再生成しない。qで文脈、sで起点、eで最新、nで関連。補助パネルとキー体系を維持。
3. 起点は押した時だけincludeOrigin:trueを既存get_sessionへ渡す。bounded read-only origin APIは別Codex workerが担当。fromStartと原文一致時だけ既存位置へ移動、その他は別途取得した起点と中間未取得を明示して既存feedItemで表示。failure/partialを正確に示す。末尾は観測した発言と時刻だけを表示。
4. タスク起点は保存された説明、関連は既存紐付け、現在地は最新追記報告／明示の提案。完了や進捗を推測しない。元の会話/入力/承認状態は保持。
5. アプリバー52→40px、操作28px以上。今回の新ビュー指示は旧『カード詳細1種類』規約より優先。新ページなし、本文レンダラ/入力欄は共通。
6. テスト先行、単体とChrome smoke、1280×800 light/dark、board/timeline/gantt task/session、shape往復のdraft/caret/scroll、起点がtail外/partial/error、live末尾の検証。Fable再評価と独立Codexレビュー→日本語commit/PR/CI/main→既存localmain検証・拡張更新。

実機Chrome、MCP再接続、元アプリ比較、人の受入は別ゲート。source変更ごとに3箇所版と2履歴を揃える。

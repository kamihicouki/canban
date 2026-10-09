# 改善ループと軌道ビューの紹介資料

2026-10-09 / v0.27.0。今回実装した手動補助の改善ループを説明する。公開済み・インストール済みを示す資料ではない。

紹介文: **大きな流れの中で、小さく確かめる。目標を中心に、根拠のある周回を重ねる。**

- [overview.png](overview.png): 配布用の図。3200×2000。
- [overview.svg](overview.svg): 編集可能な原本。1600×1000、タイトルと代替説明付き。
- [overview.pdf](overview.pdf): 印刷用の1ページPDF。
- [orbit-light.jpg](orbit-light.jpg) / [orbit-dark.jpg](orbit-dark.jpg): 軌道シートの実装画面。1280×800。
- [task-light.jpg](task-light.jpg) / [task-dark.jpg](task-dark.jpg): タスク内の小さな軌道。1280×800。
- [task-completed.jpg](task-completed.jpg): デモの周回開始→観測保存→4条件確認→達成の操作証跡。

画面の条件・根拠は専用のQA用デモデータ。製品の性能測定や実プロジェクトの完了を示さない。図の衛星・軌道は概念を示し、縮尺や実際の工数を示さない。

再出力は `node docs/design/loop-engineering/export.mjs /absolute/path/to/node_modules`。`sharp`でPNGを作り、PillowでPDFへ出力する。日本語フォントはHiragino Sans / Noto Sans CJK JPを使用する。Canbanの実行時依存は追加していない。

詳細は[設計と実装](../../loop-engineering-plan.md)、一次資料は[調査ノート](../../loop-engineering-research.md)、確認した範囲は[検証記録](VERIFICATION.md)を参照する。

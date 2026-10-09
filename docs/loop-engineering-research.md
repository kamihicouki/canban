# Loop Engineering の一次資料調査

調査日・取得日: 2026-10-08（日本時間）
対象: AI coding agent の反復・検証・状態継承と、Canban の実装計画への示唆。これは調査資料であり、Canban の実装済み機能を示すものではない。

## 結論

Loop Engineering は、AI に毎回人が次の指示を出す代わりに、仕事を見つけ、実行し、結果を検証し、状態を保存し、次の実行または停止を決める仕組みを設計するという新しい実践用語である。単に AI の実行回数を増やす意味ではない。Addy Osmani の原著は harness の一段上に位置付けている。定義には幅があり、正式な統一規格として扱うべきではない。[Osmani, Loop Engineering（2026-06-07）](https://addyosmani.com/blog/loop-engineering/)

「ほとんどの開発者が何をしているか」を断定できる根拠は今回の一次資料では得られなかった。一方、公開された実践には、検証可能な成功条件、実行のきっかけ、結果の観察、実行をまたいだ状態、予算・停止・人への判断という共通する要素がある。[Lulla ほか, Loop Engineering: Building Blocks, Adoption, and Impact, v2（2026-08-26、査読前）](https://arxiv.org/abs/2608.21884v2)

Canban への設計提案としては、最初に「完了条件 → 小さな実行 → 証拠による確認 → 次の一手」をタスクカードに組み込み、次に同じ契約を使って自動実行を接続する順が妥当である。手動テンプレートだけの段階はループ設計・運用の土台と呼び、自律ループの完成として宣伝しない。

## 1. 用語を切り分ける

以下は一次資料を比較した整理であり、すべての著者に共通する正式分類ではない。

| 用語 | 主な設計対象 | Canban に翻訳したとき |
| --- | --- | --- |
| Prompt engineering | 1 回の指示の書き方 | 実行依頼文 |
| Context engineering | その時点で agent に見せる情報 | 目的・制約・過去の証拠・引継ぎ |
| Harness engineering | agent が行動・検証できる実行環境 | ツール・隔離・テスト・結果取得 |
| Loop engineering | 複数の実行を起動・評価・継続・停止する制御 | 次の作業の選択、検証結果からの分岐、予算、停止、判断依頼 |
| PDSA | 仮説を小さく試し、結果から方法を改善する学習 | 何を変えるか、期待、観察、次に何を変えるか |

Context の意味と持続的なメモの役割は Anthropic の一次解説、harness と複数 run の違いは Osmani の原著を参照した。[Anthropic, Effective context engineering for AI agents（2025-09-29）](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), [Osmani](https://addyosmani.com/blog/loop-engineering/)

ループには少なくとも 2 種類ある。ひとつはテストが通るまで修正する「目標への収束」、もうひとつは CI 失敗や課題を周期的に発見する「継続的な監視・保守」。同じ反復でも成功条件と再開条件が異なる。前者は完了すると止まり、後者は有効なトリガーが来るまで待つ。[Osmani](https://addyosmani.com/blog/loop-engineering/)

## 2. 公開実践で実際に行っていること

### OpenAI: エージェントに結果が見える環境を作る

OpenAI の社内 beta の事例では、人が目的と受入条件を定義し、agent が変更・レビュー・修正を繰り返す。UI を動かす道具、スクリーンショット、ログ・メトリクスを agent に提供し、失敗時には不足するツール・制約・文書を改善している。文書や lint で繰り返し使う知識を仕組みに移すことも含む。これは特定チームの報告であり、記載された生産性や自律性を一般のプロジェクトへそのまま外挿できない。[OpenAI, Harness engineering（2026-02-11）](https://openai.com/index/harness-engineering/)

### Anthropic: 実行をまたいで 1 機能ずつ進める

長時間の開発実験では、初回に環境・機能一覧・進捗ファイルを作り、次の session が Git 履歴と進捗を読んで未完了の 1 機能を選ぶ。開始時に基本動作を確認し、実装後にはブラウザーで利用者と同じ操作を検証して、確認後に状態を更新する。コード変更や単体テストだけで完了を宣言する失敗への対処である。[Anthropic, Effective harnesses for long-running agents（2025-11-26）](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

### Ralph: 1 回に 1 項目、挙動を見て設定を調整する

Geoffrey Huntley の原著は、最小形を Bash の反復としながら、仕様・計画を毎回読む、1 loop に 1 項目を進める、悪い挙動を観察して指示を調整する実践を説明する。「while を書けば正しくなる」という保証ではない。著者の成功例やコスト例は個別報告として扱う。[Huntley, Ralph Wiggum as a software engineer（2025-07-14）](https://ghuntley.com/ralph/)

Anthropic の公式 repository にある Ralph plugin は、現在の session の stop hook で同じ依頼を再投入する実装で、反復上限と completion promise を持つ。原著の方法とこの plugin は同一の実装ではない。完了の文字列を検知できることと、成果物が実際に正しいことも別である。[anthropics/claude-code, Ralph plugin README（取得日現在の main）](https://github.com/anthropics/claude-code/blob/main/plugins/ralph-wiggum/README.md)

### 評価: 「完了と言った」ではなく成果物を調べる

Anthropic の評価解説は、agent の発言を含む記録と、環境に残った成果を分ける。再現性のある code grader を優先し、曖昧な品質には明確な rubric と人による調整を使う。失敗が agent の能力不足か、判定基準や環境の問題かも記録から調べる。同じ結果を出す正当な方法は複数あるので、操作順序だけを厳格に採点しない。[Anthropic, Demystifying evals for AI agents（2026-01-09）](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)

## 3. 多数派・採用率について言えること

2026 年 8 月の探索的研究は、既存の AI 設定研究 dataset に含まれる 36,710 repositories を対象にし、実際に走査できた 36,645 repositories から 256 候補を確認、217 repositories で自律 agent process の運用証拠を確認した。論文内での割合は 0.59%。確認群の 180 は repository event のみ、21 は schedule のみ、15 は両方で、主な event の用途は自動 PR review だった。[Lulla ほか, 本文 §4.1](https://arxiv.org/html/2608.21884v2)

この数字は全開発者の普及率ではない。ローカル cron や tool 内 scheduler、Git に保存されない runtime state を見落としうる。heuristics で候補を絞っており、見つからないものの網羅性は証明されていない。停止条件・予算・状態継承の理想的設計が全確認群に揃っていたという意味でもない。論文は査読前で、自律性と工数・成果の因果関係を測る比較実験は今後の計画である。[同論文 §4.1–4.2](https://arxiv.org/html/2608.21884v2)

したがって「一般にほとんどの人がこの方法を使っている」「自動化すると必ず速く安くなる」とは説明しない。「公開実践で繰り返し現れる設計要素を、初めての利用者が扱いやすくする」が妥当な提案である。

## 4. PDSA との共通点と違い

IHI の Model for Improvement は、達成したいこと、改善をどう知るか、何を変えるかの 3 問と、小規模の実験による PDSA を組み合わせる。検証して終えるだけでなく、結果から次の方法を変える点が Canban の補助線として有効である。[IHI, Model for Improvement](https://www.ihi.org/library/model-for-improvement)

Deming Institute は Study を、予測と実際を比較して理論を見直す段階として重視する。Canban で合否だけを表示すると、この学習部分を取りこぼす可能性がある。一方、PDSA 自体は AI に次の指示を出す実行基盤を提供するものではない。学習の枠組みと自動制御を分けて設計する必要がある。[Deming Institute, PDSA Cycle](https://deming.org/explore/pdsa/)

## 5. Canban への設計提案（調査事実とは区別）

以下は本調査からの提案であり、資料が Canban の UI を検証した結果ではない。

1. **出発点は 3 問。**「何を達成したい？」「何が確認できれば完了？」「まず何を試す？」をタスクカードで短く入力する。長い計画文や loop 用語の理解を前提にしない。
2. **状態と証拠を分ける。** agent の作業終了と検証済み完了を区別する。証拠には対象の成果物 revision・判定方法・時刻・結果を持たせ、別 revision の成功を現在の完了へ流用しない。
3. **未達から次の一手へつなぐ。** 確認した事実、未解決の差、次に変える方法を 1 回の記録にする。同じ失敗を無変更で反復することと、学習に基づく再実行を分ける。
4. **手動から自動へ段階的に。** カードの情報だけで毎回の引継ぎ依頼を作れる状態を先に作る。自動実行は利用者が選び、予算・反復上限・停止・中断・判断依頼を同じ契約に接続する。
5. **ボードは現在の要点、カードは詳細。** 次に行うこと、検証待ち、判断待ちが自然に分かる配置にし、別ページを増やさない。専用の保存ビューは抽出と見通しに使い、実行の意味を変えるグローバル mode と混同しない。
6. **個別 task と仕組みの改善を別に残す。** task を修正する内側の loop に加え、繰り返す失敗を見て完了条件・手順・知識・道具を改善する外側の loop を持つ。学習を共有手順へ昇格するときは、根拠と適用範囲を確認する。
7. **指標は回数ではなく品質と人の負担。** 初回合格、検証後の再開、不変の失敗、判断待ち時間、人が次の依頼を書く回数、検証済み成果あたりの実測コストを見る。token 使用量を取得できない agent では未取得と表示し、推定値を硬い予算保証にしない。

## 6. プロモーション用の表現案

**「やることを書く。確かめる。次へつながる。」**

図の主線は「目的 → 小さく実行 → 証拠で確認 → 完了」。未達の場合だけ「学びを次の一手へ → 小さく実行」へ戻す。外周には「繰り返すつまずき → 手順・道具・条件を改善」を置く。停止・判断依頼・上限は完了とは異なる出口として描く。

段階を明記するなら、「まずカードでループを設計」「次に検証結果をつなぐ」「最後に許可した範囲で自動実行」。未実装の計画図には「構想 / 実装予定」を表示し、回数無制限や完全放置を便益としてうたわない。

## 調査範囲と限界

- 公式の実践記事、用語の提唱者の原著、公式 plugin repository、査読前の一次研究、PDSA の運用組織・Deming Institute を比較した。
- 一般開発者への代表性を持つ普及調査、Canban 利用者のユーザーテスト、Canban 上での自動制御の実測はこの調査では実施していない。
- 各製品の slash command や API の現行動作を記事だけで確定せず、実装時に adapter ごとの能力・権限・停止操作・token 取得可否を確認する。
- 取得日はいずれも 2026-10-08。GitHub の main URL は可変のため、具体的な実装参照を固定するときは commit SHA に固定する。

# Desktop起動・アカウント保持・画像受渡しの内部検証

2026-10-17 / 0.29.35 / `codex/desktop-launch-design`

## 状態

Native方式で内部実装と独立レビューの修正を実施した。CLIの認証・プロセス・キューを維持し、Desktopで同時に操作するアカウントを1つにする。通常切替の目標はログアウト0回・再ログイン0回。実アカウントの受入れは未実施で、この目標を実機で確認済みとは扱わない。

アカウント計画Task5、リモート計画Task3、画像計画Task3は実機受入れ待ち。実データ側の `accountSwitch` / `codexRemote` / `clipboardImages` はすべてfalse。通常main・登録済みChrome・インストール済みプラグインへの反映は未実施。

## 独立レビューと修正

`gpt-6.1-sol`の独立レビュー1回（568cb20..9ddd8ae）はCritical0、Important4、Minor0、判定保留0。4件すべてを採用し、実装者による1回の修正パスで対応した。

| 指摘 | 修正・再現試験 |
| --- | --- |
| 空thread準備中に取消しを受け付けず後でアプリが開く | 準備中も取消マーカーを保存し、成功・応答不明の結果を保持してopenを抑止。再送でも準備し直さない |
| 標準ツリーに混在するB自身の履歴が新しいBプロフィールへ届かない | 対象アカウントの会話サブツリーのみID・内容を保持して引継ぐ。Aの元データを残し、global storage・認証・CLI homeをコピーしない。部分コピーの再開とsymlink拒否も検証 |
| 接続取消し後も確認・取消ボタンに固定される | activeな接続待ちと取消済み候補を区別して再開操作を表示。BとCの候補・下書きを別々に保持 |
| 入れ子のSSH Includeを記述元ファイル基準で読む | ユーザーSSH設定の基準ディレクトリを全階層で使用し、誤ったhostname/userの一致を防止 |

4件はいずれも修正前の失敗を確認してから修正し、成功を確認した。画面確認で新しい再接続操作の横はみ出しも検出したため、境界チェックで再現し、同じ修正パスで折返しを修正した。追加の独立再レビューは実施していない。

## 検証結果

- `npm test`: **571/571成功**（62.2秒）。
- `node --test tests/board-smoke.browser.mjs`: **1/1成功**（34.4秒）。
- `node --test tests/desktop-accounts.browser.mjs`: **1/1成功**（4.1秒）。
- `npm run build:chrome`: 成功。package・MCP manifest・Codex plugin・このworktreeのChromeビルドはすべて0.29.35。
- 1280×800、ライト/ダーク・ボード/時間軸の全4画像を目視確認。再接続と別アカウント接続の操作が枠内に収まることを確認。
- 最終Chrome合同実行の初回はテスト専用Chromeが起動時に応答しなくなり、当該試験の子プロセスだけを停止。タイムアウトや製品の仕様を緩めず、各試験を単独実行して成功した。
- `git diff --check`: 成功。

証跡は `.superpowers/sdd/2026-10-17-prompt-image-handoff/` の `review-*-{red,green}.log`、`review-suite-final.log`、`review-smoke-final.log`、`review-ui-final.log`。1280×800のライト/ダーク・ボード/時間軸の画像は `.local/desktop-launch-tests/review-account-ui/`。

従来の実装検証では、隔離した公式Codex CLIによる空会話準備とwriter解放後の読戻しが成功（モデルターン0）。実SSH Desktopでの下書き表示、実Claudeの認証保持、実クリップボードから両アプリへの画像貼付けは別の受入れ条件である。

## 実機試行の次の操作

具体計画は `.local/desktop-launch-tests/live-acceptance-plan.md`。保存・停止確認後、元プロフィールを700の保存先へバックアップしてから、A→B→Aを3往復し、会話・作業先・保存済み下書き・CLI継続・Dock起動を確認する。不明な状態では待機し、強制終了しない。画像は既知の検証画像を明示的にコピーし、両アプリで1枚・複数枚のサムネイルを確認する。依頼の送信は行わない。

実プロフィールの入替えは、実装計画にある「具体的な計画とバックアップを提示して承認を得た後だけ行う」という条件に従い、承認後に実施する。通常main・登録済み拡張への取込み・公開をこの試行に含めない。

## 実装上の判断（Rulings I made）

各判断と、誤った場合の影響を台帳の順序で以下に残す。内部の能力gateと実機受入れを分けた判断により、安全な実装を先に完了し、実プロフィールの試行承認を最後に扱った。

1. Ruling: Capability gates apply before wiring a capability into normal UI/API. Fixture-only services can be implemented before real-account trial; no live profile mutation until a concrete plan and backup are approved — preserves the spec's data boundary — if wrong, feature remains disabled.
2. Ruling: Keep new directory rename primitive in a small OS adapter using exclusive rename; Node fs.rename can overwrite an empty destination — required to preserve externally recreated profiles — if wrong, switches fail closed.
3. Ruling: withAccount requires allowSwitch:true for a different account; saving a CLI selection must never imply a Desktop switch — follows the approved session-isolation requirement — if wrong, extra explicit switch is needed.
4. Task 2: Ruling: registry paths are canonical; fake test roots now resolve macOS /var -> /private/var before seeding the registry — validation stays strict — cost if wrong: fixture setup only.
5. Task 2: Ruling: top-level account requests pass a null lease to acquire anew; only internal guest operations inherit trusted async context — prevents a second request switching accounts during an open callback — cost if wrong: operations fail busy.
6. Task 3: Ruling: first-login candidates live in registry.pending with expectedAccount, not in registered profiles. Only matching finish-login binds an account; cancellation retains the candidate directory and restores the original — avoids assigning a wrong login to CLI — cost if wrong: connection remains pending.
7. Task 3: Ruling: source discovery is configured with the same Store.dir at server startup; registry inode/mtime generation invalidates parked-root caches — prevents stale account attribution — cost if wrong: conservative read failure rather than opening a guessed account.
8. Task 3: Ruling: runtime keeps the existing read-only claudeDesktopRoots discovery (now backed by the roots module) to retain legacy profile discovery; it never imports the mutation service — avoids unnecessary compatibility changes — cost if wrong: runtime fails closed on an unknown directory.
9. Task 3: Ruling: configured Canban data-root aliases are resolved, while Desktop/managed descendant symlinks stay forbidden — supports the documented .local/data reference — cost if wrong: an explicit owned root is selected; non-owned roots are rejected.
10. Task 3: Ruling: conflicting Desktop ownership drops native metadata/link access rather than choosing the newest owner, preserving the CLI card ID — spec forbids ambiguous merging — cost if wrong: user must confirm the account before Desktop resume.
11. Task 3: Ruling: app child environment also removes inherited CLI auth/provider/home overrides; parent environment is unchanged — Desktop must keep its own login and not receive a CLI account — cost if wrong: a custom CLI override no longer applies to Desktop startup.
12. Task 4: Ruling: cancellation also requires internal UI authority and writes a separate durable marker; it cannot interrupt an issued open intent — prevents model cancellation and record races — cost if wrong: an in-flight app open must be checked in the app.
13. Task 4: Ruling: explicit UI grants may widen a waiting request permission scope without changing its immutable content fingerprint; tokens are never persisted — required to continue the same pending draft from a switch action — cost if wrong: the UI must explicitly grant the switch again.
14. Task 5: Ruling: live capability is an owner-only local receipt tied to installed app builds and explicit acceptance metrics; no MCP tool writes it — fixture success must not expose unverified profile switching — cost if wrong: app updates require fresh acceptance.
15. Task 5: Ruling: finish safe implementation and the remote/image plans before asking for the already-specified live-profile trial approval; Task 5 acceptance stays pending — user approval must cover a concrete reviewable result — cost if wrong: live capability remains disabled meanwhile.
16. Task1: Ruling: unsupported Include glob/expansion and dynamic directives anywhere fail closed; literal static Includes and Host patterns are supported — avoids executing ssh/config commands to infer identity — cost if wrong: those connections need explicit verified configuration.
17. Task2: Ruling: remote Python owns official RPC and its durable reservation; the Node service injects the pool and optional readback verifier rather than a second RPC owner — one owner must close the writer before returning — cost if wrong: alternate transports need a pool adapter.
18. Task3: Ruling: a typed Claude remote must match one account-scoped Desktop environment; explicit Desktop environments retain their own alias/port when no Codex mapping is provable — prevents inferring the same destination from alias alone — cost if wrong: user selects the environment explicitly.
19. Task3: Ruling: dry-run prepares a fictional UUID without contacting SSH; acceptance receipt is written only in disposable test data — existing development mode must never create real remote history — cost if wrong: dry-run proves routing only.
20. Task2: Ruling: cache validated file generations only (max256), not image bytes; a restarted process rehashes once and each subsequent chunk requires the original hash — keeps8x10MB previews bounded without rehashing every128KiB — cost if wrong: an evicted image is revalidated.
21. Final: Ruling: accept all4 Important findings (preparation cancellation, mixed-account history, inactive enrollment UI, nested Include base) for one author fix pass — each changes observable cancellation, resume or target correctness — cost if wrong: extra conservative waiting or refused seeding.
22. Final: Ruling: seed only the selected account conversation subtree, preserving source files and IDs; refuse ambiguous sources and unexpected/symlink files, resume matching partial copies — global auth storage cannot be transferred safely — cost if wrong: live acceptance remains disabled and a source must be confirmed manually.
23. Final: Ruling: retain cancelled enrollment candidates per account instead of reusing one candidate for another account — resumes each saved draft/login independently — cost if wrong: retained private candidate storage grows, bounded32 including registered profiles.

## 保留した軽微な指摘（Deferred minors）

なし。

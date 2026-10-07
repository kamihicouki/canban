# Claude Code のアカウントを替えて同じセッションを再開する

調査日: 2026-10-07（JST）

## 実装と検証（0.24.1）

Canban のセッションカード「再開」に実行アカウントピッカーを追加した。同じ選択をターミナル再開・指示の即時送信・キューに渡す。入口はこのピッカー1か所で、Alt+a / ⌘K からも開ける。選択はCanbanの現在の画面内で保持し、再読み込み後は元のアカウントに戻る。キューに記録した実行先は保持する。

- `npm test`: 330件成功。追加テストはCLIプロファイルの認識、元の会話・認証ファイルの保持、設定による認証上書きの拒否、fake CLIのcwd・会話パス・認証環境の分離、キュー待機後のアカウント変更の拒否を確認。
- `tests/claude-handoff.browser.mjs`: 1280×800、5レイアウト×ライト/ダークの10画像を確認。アカウント選択、再開・送信の実行先、Alt+a / ⌘K、下書き保持、デスクトップ経路の拒否、履歴の更新直後の再開拒否を検証。アプリ起動とモデル応答はdry-run。
- Chromeビルドのバージョンをソースの0.24.1に合わせた。実アカウントの応答、切替後Claude CLIの履歴書き込み先、登録済みChrome拡張への反映、Native Messagingの実機確認は未実施。

## 結論

ローカルの Claude Code セッションは、作業ディレクトリ、git ブランチ、会話を維持したまま、別のログイン済みアカウントで再開できる構成にできる。会話はローカルの transcript、認証は起動時に選ぶ credential であり、別の作業用 worktree を作る必要はない。ただし「稼働中の同じプロセスの認証を交換」する機能ではなく、元の実行を停止したうえで、別アカウントの設定ディレクトリを指定して同じ session ID を再開する実装とする。

公式が直接説明する契約は、アカウントを分ける `CLAUDE_CONFIG_DIR`、ローカル transcript、`--resume` での再開である。この組み合わせから実装可能と判断した。異なるアカウントによる実際のモデル応答まで、本調査では実行していない。

## 一次資料で確認したこと

| 項目 | 確認内容 | 資料 |
| --- | --- | --- |
| 複数アカウント | `CLAUDE_CONFIG_DIR` は設定・履歴・プラグインの保存先を替える。公式は複数アカウントの同時利用を用途として挙げている | [Environment variables](https://code.claude.com/docs/en/env-vars#claude_config_dir) |
| 認証の分離 | 同変数を指定した場合、`.credentials.json` と macOS Keychain のエントリもそのディレクトリ単位で分かれる | [Authentication / Credential management](https://code.claude.com/docs/en/authentication#credential-management) |
| 会話の再開 | `--resume` は session ID、名前、transcript `.jsonl` の絶対パスに対応する。復元時に会話と tool call/result を読み込む | [Manage sessions](https://code.claude.com/docs/en/sessions#resume-a-session), [CLI reference](https://code.claude.com/docs/en/cli-reference) |
| 保存先 | 既定の transcript は `~/.claude/projects/<project>/<session-id>.jsonl`。`CLAUDE_CONFIG_DIR` を指定するとその配下になる | [Manage sessions / Where transcripts are stored](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored), [Settings](https://code.claude.com/docs/en/settings#find-or-create-your-settings-files) |
| 認証の優先順位 | provider、環境の bearer token・API key、`apiKeyHelper`、OAuth token などが、`/login` の subscription OAuth より優先され得る | [Authentication / Authentication precedence](https://code.claude.com/docs/en/authentication#authentication-precedence) |

ローカル CLI の確認結果は `Claude Code 2.1.285`。実行ファイルは `/Users/d/.local/bin/claude`（実体 `/Users/d/.local/share/claude/versions/2.1.285`）。`claude --help` は `--resume`、`--continue`、`--fork-session` を備え、`claude auth status --help` は JSON 出力に対応している。ヘルプとバージョンの読み取りのみ行い、`auth login`・`auth logout`・モデルへの prompt 送信は行っていない。

## Canban の引き継ぎに必要な契約

1. 元の session ID と cwd を固定する。git checkout、branch 作成、worktree 作成を行わない。`--fork-session` は新しい session ID を作るため、この用途では付けない。
2. 元の実行が動いていないことを確かめる。Claude Code 2.1.285 は稼働中 background session の `--resume` を `attach` として扱う。そのままでは元アカウントのプロセスにつながる可能性がある。同一 transcript の二重起動も会話を混在させる。
3. 起動する Claude CLI に対象アカウントの `CLAUDE_CONFIG_DIR` を渡す。既存アカウントに別アカウントの credential を上書きしない。認証をコピー・ログ出力しない。対象アカウントが未ログインなら、ログイン完了まで引き継ぎを進めない。
4. `--resume <元の transcript の絶対パス>` を渡す。これは公式の入口であり、対象アカウントの config dir に同じ session ID が未登録でも、元の会話ファイルを指定できる。今回の実装では transcript をコピーしたり、`projects` のリンクを作ったりしない。元のファイルのパスを保持する。
5. `.credentials.json`、`.claude.json`、Keychain、ユーザー settings 全体は移さない。`settings.json` の `env` や `apiKeyHelper` が選択アカウントを上書きしないかも確認する。
6. 新プロセスの認証が対象アカウントと一致することを `claude auth status` 相当の確認で確かめてから起動する。既存の auth 隔離処理で、親環境の provider/API/OAuth token が混入しないようにする。

停止・二重起動・復元時の設定については [Manage sessions / Resume a running background session](https://code.claude.com/docs/en/sessions#resume-a-running-background-session) と [What a resumed session restores](https://code.claude.com/docs/en/sessions#what-a-resumed-session-restores) を参照。元の起動で `--mcp-config`、`--settings`、`--plugin-dir`、`--add-dir` などに依存していた場合、必要なものを再指定する。停止した tool や background work は再開で自動的に完遂されるものではない。

## 付随ファイルと安定性

Anthropic の公開 Agent SDK 実装は、session の主 transcript と `<project>/<session-id>/subagents/**` を別に読み込む。subagent の `.meta.json` も別ファイルとして扱う。今回の実装はこれらのファイルを移さず、元の保存先を維持する。主会話の復元と、subagent の独立した再開可能性は同一視しない。

確認した公開ソースは `anthropics/claude-agent-sdk-python` の commit `23bb0157f51f83c21a7c47fbed1e5741ad581082`:

- [session_import.py:72](https://github.com/anthropics/claude-agent-sdk-python/blob/23bb0157f51f83c21a7c47fbed1e5741ad581082/src/claude_agent_sdk/_internal/session_import.py#L72): 主 transcript の解決と、付随する subagent transcript・metadata の取り込み。
- [sessions.py:122](https://github.com/anthropics/claude-agent-sdk-python/blob/23bb0157f51f83c21a7c47fbed1e5741ad581082/src/claude_agent_sdk/_internal/sessions.py#L122): `CLAUDE_CONFIG_DIR` を尊重する config/projects ディレクトリの解決。

これは同時点の公開実装の根拠であり、全 CLI バージョンへの保証ではない。公式も JSONL の内部形式は変更され得ると説明するため、Canban が会話の JSON 行や UUID を書き換える方式は避ける。ディレクトリ名も長い cwd では切り詰めとハッシュを使い、`CLAUDE_CODE_PROJECT_DIR_NAME` で変更できるため、単純な文字置換のみで再構築せず、既に判明している transcript の保存先を使う。

## 制限と検証の境界

- `--resume <絶対パス>` を別 config dir から実行した場合の、以後の書き込み先は上記公式資料では明確に規定されていない。CLI fixture で確認できる起動・復元と、モデル応答後の実データ書き込みを分けて記録する。今回の実装では Canban が target の `projects` に履歴をコピーしたり、既存 transcript を上書きしたりしない。起動後の Claude CLI 自身の書き込み挙動は、別途の確認事項である。
- `--desktop --resume` は ID のみに対応し、起動した Desktop が実際にどのアカウントで動くかは Desktop 側のログインに依存する。CLI の config dir を替える処理だけで Desktop のアカウントを替えたとは判断できない。今回の引き継ぎは対象 config dir を渡せる CLI/PTY の実行を使う。
- 対象アカウントで利用可能なモデル、organization の managed policy、MCP 認証は異なる場合がある。会話の持ち越しは、モデル権限や外部サービスの認証を移すことではない。
- 2 アカウントによる推論、利用量消費、実際の認証変更は未実施。調査だけでこれらの実機受け入れを完了としない。

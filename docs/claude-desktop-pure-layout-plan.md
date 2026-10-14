# Claude Desktop をピュア構成へ戻す計画

作成日: 2026-10-14（JST）。棚卸しは読み取りだけで行った。**実行はユーザーの承認後。**

## 目標の形

素の Claude Desktop と同じ構成にする。

```
~/Library/Application Support/Claude/            ← 実ディレクトリ（リンクではない）
  claude-code-sessions/<accountId>/<orgId>/       ← アカウントごとの会話（実ファイル）
  local-agent-mode-sessions/<accountId>/<orgId>/
  scratch-workspaces/<accountId>/<orgId>/
```

ログインは同時に 1 つだけ。別アカウントを使うときは、Desktop でログアウトしてログインし直す。Desktop は、ログイン中のアカウントのフォルダだけをサイドバーに出す。

## 現状（2026-10-14 17:30 時点）

| 場所 | 中身 | ログイン |
| --- | --- | --- |
| `Claude` | `Claude-ppb` へのリンク | — |
| `Claude-ppb`（375M） | 会話 2 件（50e8/604b、実ディレクトリ） | 50e8（ppb202209） |
| `Claude-Profiles/main`（1.2G） | 会話は `_shared-sessions` へのリンク、scratch（cb1e 分） | cb1e（kamihicouki） |
| `Claude-Profiles/ppb`（13G。大半は `claude-code-vm`） | 会話は `_shared-sessions` へのリンク、scratch（cb1e・50e8 分） | cb1e |
| `Claude-Profiles/_shared-sessions` | cb1e/9e88 に実ファイル 52 件（うち 4 件アーカイブ）。50e8/604b は cb1e/9e88 へのリンク、50e8/9e88 は `scheduled-tasks.json` だけ | — |

`local-agent-mode-sessions` も同じ構造で、実体は cb1e/9e88。`skills-plugin/604b`・`skills-plugin/9e88` は cb1e/9e88 へのリンクになっている。

### 共有フォルダ内の会話の持ち主

会話の JSON にはアカウントの項目がない。scratch の場所から、次の 3 件は 50e8 で作られたと判断できる。残り 49 件は cb1e のもの。

| 会話 | 状態 | scratch |
| --- | --- | --- |
| Janus インストール（`local_b95ba536`） | 有効 | 50e8/604b/scratch-2026-09-29-7179fd |
| Serena インストール調査（`local_ad42aa1e`） | 有効 | 50e8/604b/scratch-2026-09-29-34d16e |
| Line Harness セットアップ（`local_df5b054e`） | アーカイブ | 50e8/604b/scratch-2026-10-09-8c226c（もう存在しない） |

### scratch-workspaces の扱い

- 会話の `cwd` は、7 件中 6 件が `…/Claude/scratch-workspaces/…`（リンク経由のパス）で記録されている。scratch を新しい `Claude/scratch-workspaces/` に集めれば、**`cwd` を書き換えずにそのまま有効になる**。今はリンク先によってはパスが切れているが、移行後は常に有効になる。
- `Claude-Profiles/ppb/…` を直接指すのは Line Harness（アーカイブ）1 件だけで、その scratch はすでに存在しない。書き換えはしない。
- **会話記録のフォルダ名は実体パスから作られている**（例：`-Users-d-Library-Application-Support-Claude-Profiles-ppb-scratch-workspaces-…`）。移行後の実体パスと名前が合わなくなるのは 6 件。CLI での再開がそのフォルダを探すため、会話記録（`.jsonl` と同名のフォルダ）を新しい名前のフォルダへ移す。同じ会話記録が 3 か所にある「リモートVPS実装の継続」（`local_95ddfd00`）は、正しい名前の場所にある 1 つを残し、残りはバックアップへ移す。
- 中身が空の `scratch-2026-09-26-1cb346` は main と ppb の両方にある。1 つにまとめる。

## 決めること

1. **実体の `Claude/` にするプロフィール**：推奨は `Claude-Profiles/main`（cb1e）。会話の大半（49 件）と scratch、サイドバーのグループ・ピン留め（ブラウザー側の保存領域）がこちらにあるため。ログインは cb1e が残る。50e8 を使うときはログインし直す。
2. **50e8 で作られた 3 件**：推奨は 50e8/604b へ移すこと。50e8 でログインしたときに表示される。
3. **Claude Profiles.app**：推奨は、起動せず、ログイン項目にも入れないこと（今は入っていない）。確認が済んだら削除する。

## 手順（すべて Desktop と Claude Profiles.app の停止中に行う）

0. **事前確認**：Desktop が停止している、`Claude` が `Claude-ppb` か `Claude-Profiles/*` を指している、会話の件数が棚卸しと一致する。どれかが違えば中止する。
1. **バックアップ**：`~/.canban/backups/desktop-pure-<日時>/` に、`Claude`（リンク）、`Claude-ppb`、`Claude-Profiles`、移す会話記録を **APFS clone**（`cp -c`）で複製する。容量はほぼ増えない。目録（パス・件数・ハッシュ）も保存する。
2. **実体化**：リンク `Claude` を外し、`Claude-Profiles/main` を `Claude` へ移動（rename）する。
3. **会話を集める**（`claude-code-sessions`）
   - `Claude/claude-code-sessions`（リンク）を外し、`_shared-sessions/claude-code-sessions` を移動して実ディレクトリにする。
   - リンク `50e8/604b` を外して実ディレクトリを作り、`Claude-ppb` の 2 件と `scheduled-tasks.json`、決定 2 の 3 件を移す。
   - `50e8/9e88`（`scheduled-tasks.json` だけ）はバックアップへ移す。
   - `archived-sessions.idx` は持ち主が変わる会話を含むので、バックアップへ移す。Desktop は次回起動時に全件を読み直して作り直す。
4. **`local-agent-mode-sessions`**：手順 3 と同じ。`skills-plugin` 内のリンクは外す。604b は `Claude-ppb` の実ディレクトリを使い、9e88 は Desktop に作り直させる。
5. **scratch**：`Claude-Profiles/ppb/scratch-workspaces` の中身を `Claude/scratch-workspaces/` の同じ相対位置へ移す（空の重複は 1 つにまとめる）。
6. **会話記録のフォルダ名を合わせる**：上の 6 件を、移行後の実体パスから作った名前のフォルダへ移す。重複分はバックアップへ移す。
7. **旧フォルダを退避**：残った `Claude-ppb`・`Claude-Profiles` を、`~/.canban/backups/desktop-pure-<日時>/retired/` へ移す（rename。削除はしない）。`Application Support` に残すと、Desktop の取り込み候補や Canban の探索に出てくるため。
8. **Canban の切替を止める**：`server/claude-desktop-profile.mjs` の切替を無効にし、案内だけを返すようにする。実体ディレクトリでは既存の判定でも切り替えないが、コードでも止める。あわせて `docs/local-layout.md` を更新する。

## 確認

- Desktop を起動し、main.log の `Loaded N persisted sessions from …/Claude/claude-code-sessions/cb1e…/9e88…` が 49 件（アーカイブの保留分を含む）になる。
- scratch の会話（Codex Cloud…、Mac ディスク…）を開き、作業フォルダと過去のやり取りが表示される。
- 50e8 でログインし直すと、5 件（`Claude-ppb` の 2 件と決定 2 の 3 件）が表示される。ログインし直すかどうかはユーザーが決める。
- Canban のボードで、全アカウントの会話が重複なく 1 回ずつ出る。Desktop の別アカウント起動は案内になる。

## 戻し方

Desktop を停止し、新しい `Claude` を退避する。バックアップの clone を元の場所へ戻し、`Claude` リンクを作り直す。移した会話記録も目録どおりに戻す。この手順はスクリプトの `rollback` として用意し、実行前に計画表示で確認できるようにする。

## このあと（2. Canban の作り直し）

- ボードは全アカウント・全エージェントを混在表示する。Claude の読み込みは `claude-code-sessions/*/*` を走査済みなので、ピュア構成でもそのまま両アカウントが出る（`owner` = フォルダのアカウント）。
- Desktop で開くのは、ログイン中のアカウントの会話だけにする。それ以外は CLI で実行するか、「ログインの切り替えが必要」と案内する。
- 統合サイドバー：ゲストのコピーと書き戻しは同じ `Claude/claude-code-sessions` の中で完結する。Desktop の `CliSessionDiscovery` は同じ保存先の全アカウントの記録を所有済みとして集めるので、削除による会話記録の誤削除の危険は下がる見込み（要検証）。検証済みの知見（⌘Q を待つ、作業途中で終了された会話は除く、launchd は `~/Documents` を読めない）を引き継ぐ。

## 実施方法（2026-10-14 承認）

- 決定：土台は `Claude-Profiles/main`（cb1e）。50e8 で作られた 3 件は 50e8/604b へ移す。Claude Profiles.app は使わない。
- `scripts/desktop-pure-migrate.mjs`：`plan`（表示だけ）、`apply --apply`、`verify`、`rollback --apply [--dir]`。すべての変更は rename かリンク解除で、手順ごとに `journal.json` へ記録する。`rollback` はその記録を逆順に戻す。偽のホームで、移行、移行後の確認、途中で失敗したときの戻し、戻したあとの完全一致（ファイル・リンク・ハッシュ）を確かめた。
- 同じ会話記録が複数の場所にある場合は、更新が最も新しいものを残す。「リモートVPS実装の継続」は `Claude-Profiles/ppb` 側の記録（10/7）が最新。
- 実行は launchd のジョブ（`~/.canban/desktop-pure/`）で行う。ユーザーの ⌘Q を待ち、移行、確認、Desktop の起動、この会話の再開までを順に行う。失敗した場合は `rollback` してから Desktop を起動する。
- Canban：`server/claude-desktop-profile.mjs` から切替を外した。ログイン中のアカウントだけを Desktop で開き、それ以外は `desktop_unavailable` で案内する。`docs/local-layout.md` も更新した。

## 実施記録（2026-10-14 19:08〜19:09）

- 19:08:37 にユーザーの ⌘Q で Desktop が終了したことを確認し、移行の 46 手順を実行した。失敗はなく、rollback は使っていない。記録とバックアップは `~/.canban/backups/desktop-pure-2026-10-14T10-08-39/`（`journal.json`、`clone/`、`moved/`、`retired/`）にある。
- 移行後：`Application Support` の Claude 関連は実ディレクトリの `Claude` だけになった。`claude-code-sessions` と `local-agent-mode-sessions` の中にリンクは 0 件。ログインは cb1e。会話は cb1e/9e88 に 49 件、50e8/604b に 5 件（Claude-ppb の 2 件と、50e8 で作られた 3 件）。
- `verify`：問題なし。参考として、移行前から作業フォルダが存在しない会話が 7 件ある（リモートの `/home/ubuntu/...` と、削除済みの worktree）。
- Desktop を起動すると、main.log に `Loaded 46 persisted sessions from …/Claude/claude-code-sessions/cb1e…/9e88… (3 archived deferred, …; hint absent)` が記録された。46 + 3 = 49 で全件が読み込まれている。`hint absent` は、退避した `archived-sessions.idx` を Desktop が作り直す状態。起動直後のエラーはない。
- 残っている確認：画面での見た目、scratch の会話を開いたときの表示、50e8 でログインし直したときの 5 件の表示、Canban のボードでの重複なし表示。旧フォルダ（`retired/`）と clone の削除は、これらの確認が済んでから行う。

# Changelog

## 0.16.2 — 2026-10-02

- ローカル設定・共有データ・更新記録をrepo内の `.local/` に集約する配置契約を追加しました。
- Chrome Main Testの更新処理を `scripts/update-local-chrome.mjs` と `npm run update:chrome` に移し、拡張IDと共有保存先を維持します。
- 保存先設定と旧パスの互換リンクを解決し、`.local/` をGitとMCPBパッケージから除外しました。

## 0.16.1 — 2026-10-02

- 会話欄の高さにフッターを含め、会話一覧と外側セクションの二重スクロールを解消しました。
- 軽微な修正もバージョンを更新し、Chromeの登録済みフォルダーに同じ番号のビルドを反映する運用を明記しました。

## 0.15.0 — 2026-09-30

- Codex・Claude・Chrome共通のサイドバーを追加。ホーム、カード、利用上限、分析、管理画面を切り替えられます。
- カードダッシュボードを表示領域全体へ拡張。固定カードの高さ、複数行グリッド、内部スクロール、小さな画面のナビゲーションを調整しました。
- 画面切り替え時に未送信のプロンプトとフォームを保持。入力中の共有設定の読み込みを保留します。
- Claude側の複数アカウント対応（PR #5）をSQLiteへ統合。アカウント設定・フィルター・設定フォルダ・送信時の環境指定を維持しました。
- Agent Usageでアカウント上限・セッションのコンテキスト・接続画面を分離。未取得や古い利用上限を残量として表示しません。


## 0.14.0 — 2026-09-30
- **Multiple accounts.** Sessions of every account are on the board together, so switching accounts in Claude Desktop or Codex no longer hides anything.
  - Each session knows its account: Claude from where the desktop app keeps it (`claude-code-sessions/<account>/<org>/`), Codex from `threads.creator_account_id`. Sessions with no record show as アカウント不明.
  - Header **アカウント** menu: accounts per AI App with their e-mail / plan, session count, where they are signed in (desktop profile, CLI config folder) and usage. Click one to filter the board (`account` filter, also in saved views, analytics and the MCP tools); ✎ gives it a display name. Cards carry a 👤 chip when there is more than one account; swimlanes can group by account; analytics adds アカウント別.
  - The Claude desktop app only opens the signed-in account's sessions: another account's session resumes in the terminal by default, and its detail says why.
- **Config folders.** Other `CLAUDE_CONFIG_DIR` / `CODEX_HOME` folders are read too: found under `~/.claude-*`, `~/.claude-profiles/*`, `~/.codex-*` (can be turned off) or added in the menu. Their sessions resume and receive prompts with that folder in the environment, and the live watch follows them.
- **Claude desktop profiles.** Other app data folders beside `Application Support/Claude` (`Claude-*`, `Claude-Profiles/*`) are read as well. Folders shared between accounts through symlinks are read once and belong to their real location; a session visible to the signed-in account through a link is not flagged.
- **Usage per account.** The header shows 5-hour / weekly usage for every account that has a record: Codex rate limits from the logs (now kept per account) and Claude plan usage from each desktop profile's `plan-usage-history.json` (older than an hour: dimmed). New model-visible tool `canban_get_usage`.
- Account files are read only for the account id, e-mail, plan and usage; tokens are never read into anything Canban returns.
- **One-row header.** The header no longer wraps. When it does not fit, button labels go first (icons stay), then items move into a new ⋯ menu from the lowest priority up (本文 → 自動化 → ビュー → ラベル → マシン → 分析 → 表示 → 期間 → 📁 → AI Apps → 実行状態). The run-state chips are dots with counts; the session totals moved to the Canban title's tooltip.
- **Usage rings.** Usage is one double ring per account on the 👤 button: outer = 5-hour window, inner = weekly, green / orange / red by how full; the center carries the account's initial on its own color and a corner mark says Codex or Claude. In the 👤 menu each account can be left out of the header (checkbox) and given a name, a 1–2 character initial and a color (✎). Card chips use the same initial and color.
- Fix: `h()` now sets CSS custom properties given in `style`.
- Code layout: the account and header UI live in `ui/accounts.{js,css}` and `ui/header.{js,css}`, inlined into `ui/board.html` at `@include` markers by `server/ui.mjs` (the page stays one `<style>` + one `<script>`). Server glue is in `server/accounts-settings.mjs` (settings) and `server/accounts-mcp.mjs` (tools, filter, desktop notes, watch folders); `board.html`, `store.mjs`, `index.mjs` and `board.mjs` keep one-line hooks.

## 0.13.0 — 2026-09-29
- Card details are now **panes** instead of one modal: open several cards at once, like pinned sticky notes (up to 8).
  - A pane never grows taller than the screen; each column of the card scrolls inside it.
  - **Display modes** — テキスト (plain, compact, monospaced feel), プレビュー (the previous look), 要点 (digest: tool calls and thinking are hidden, replies cut to three lines).
  - **Sizes** S / M / L per pane.
  - **Space** — 固定 (packed into a grid, one row or one column, centered) or 自由 (drag anywhere, edges and other panes snap). Fixed panes are reordered by dragging their title. Below 720 px wide the panes stack.
  - **付箋** — fold a pane down to its title and one line of what the session is doing; unfold to get it back.
  - Every setting is a default (bar above the panes) that each pane follows unless it is overridden from that pane (空間 button, 表示 popover). Bulk buttons: すべて付箋に / すべて広げる / すべて固定 / すべて自由 / 全体設定に従う.
  - The parts of a card (conversation, prompt box, labels, memo, plan, edited files, model and permission, context meter, resume, ...) can be reordered by drag and drop or by `↑` `↓` on the grip, inside their own column only. The order is shared by all panes; 部品の並びを初期化 resets it.
  - Open panes, their settings and positions are remembered (per host app, in the UI's local storage).
  - **Dashboard button**: all panes fold into one round button (`D`, or the button itself). The button carries a ring of the cards' states (running / waiting / done), a count badge, and fans the cards out on hover so one can be picked. It can be dragged to any edge of the window and snaps to the nearest one (`Shift`+arrows moves it from the keyboard); the fan opens toward the inside and the position is remembered.
  - Picking cards is easier: while folded, clicking a card adds it to the dashboard without opening it (the 畳んだまま足す switch in the bar; clicking a card that is already in the dashboard opens it).
  - The background always darkens while the dashboard is open, not only for fixed panes; anything laid over the panes (menus) adds another translucent veil, and a depth meter at the bottom shows how far from the home board you are (ホーム / ダッシュボード / メニュー).
- The live watch follows every open pane: `canban_watch` takes `feeds` (up to 8 `{cardId, offset, size, codexItems}`) and returns `feeds` keyed by card. `cardId` / `feed` still work for one card. The live hub watches all focused logs, and presence lists every open card.
- Fix: the filter row's agent buttons no longer share the highlight logic with other segmented controls.

## 0.12.0 — 2026-09-29
- Live signals from the session logs, updated with the realtime board:
  - Context in use after the last reply (Codex: share of `model_context_window`; Claude: tokens, share when the window is known). Cards show `◔ 62%`; any card over 75% / 90% turns orange / red.
  - Plan progress from Claude TodoWrite / Codex update_plan (`☑ 3/7`, steps and the current one in the detail).
  - Files the current turn edited (Edit / Write / apply_patch / FileChange, `✎ 4`), running Claude sub-agents (`🤖 2`).
  - What a waiting session waits for: a question (❓) or plan approval (📋).
  - Model, effort and mode (Claude permission mode / Codex sandbox) in the detail.
  - Codex rate limits (5 h and weekly windows, from `token_count` events) in the header, with the time to reset.
  - Signals are folded per log from its first read and then only from appended lines, so a long turn keeps its edited files after they leave the tail.
- Live git state of running sessions' folders on their cards (`⎇ main ±3 ↑1`: branch, uncommitted + untracked files, ahead / behind) and of any local session in its detail.
  - Read with `git --no-optional-locks status --porcelain=v2` (never takes the index lock); at most 4 git processes, 3 s timeout.
  - The live hub watches the git dirs (HEAD, index) of running sessions, so commits and checkouts show at once; unstaged edits are recounted at most every 10 s while the log grows. Nothing runs until a board is open.
- Presence: a live board leaves a heartbeat in `~/.canban/presence.json` (app from `clientInfo`, the open card; every 30 s or when the open card changes, expiring after 90 s). Other boards show "👁 Codex" / "👁 Claude デスクトップ" in the header and 👁 on the card that board has open. Heartbeats that change nothing a board shows do not end its long poll.
- The dev host takes `CANBAN_DEV_CLIENT` to pose as another app.
- Claude desktop metadata (`claude-code-sessions/**/local_*.json`, `archived-sessions.idx`) is watched too: a rename, archive or status change rebuilds the board at once; rewrites that only touch activity times are ignored. Reloads caused by new sessions or metadata skip the 4 s listing cache.

## 0.11.0 — 2026-09-28
- Realtime board. While a board is open it updates as soon as something changes, instead of re-reading every 15–60 s.
  - The UI keeps one `canban_watch` call open (long poll, up to 20 s). The server watches the session logs (`fs.watch`) and Canban's own files, and answers with only what changed.
  - Cards of sessions whose log grew are patched in place, with no session listing. Running / waiting cards show what the session is doing now (`Bash: npm test`, the first line of the latest message). A status change still rebuilds the board so automations run.
  - The card detail shows the conversation like the agents' own apps: prompts, replies, reasoning (folded), tool calls (spinner, then ✓ / ✗ with the start of the output) and turn ends, streamed line by line from the log. It follows new lines when scrolled to the bottom and shows "↓ 新着" otherwise. The send box sits right under it.
  - Edits made in another app (Codex and Claude Desktop on the same board) show up at once.
- Load: watching starts when a board opens and stops 60 s after it closes; servers without an open board watch nothing. Logs are read from the last offset. Without `fs.watch`, only the watched files are stat-polled (2 s). If a host runs an app's tool calls one at a time, the UI switches to short polling (2.5 s) so clicks are not delayed. `live.watch` has a 50 ms budget. `CANBAN_LIVE=0` turns it off.
- `board.json` edits hold a lock across processes (`~/.canban/board.lock`), so two apps editing the board at once no longer lose an update.

## 0.10.0 — 2026-09-27
- Claude Desktop: Canban can be installed as a Claude Desktop extension. The board opens inside the conversation when you ask for it ("Canban を開いて"); ⤢ switches to fullscreen.
  - `manifest.json` (MCPB 0.3) starts the same server through `scripts/launch.sh`, so it uses a Node.js ≥ 22.13 from PATH, Homebrew or nvm, or the one set in the extension's "Node.js の場所" setting (`CANBAN_NODE`).
  - `npm run pack:mcpb` builds `dist/canban.mcpb`. `.mcpbignore` leaves tests and docs out.
  - A `claude_desktop_config.json` entry works too (README).
  - Both apps share `~/.canban`, so they show the same board, and background work still runs in only one server.
- The server no longer needs `.codex-plugin/plugin.json` to start; it falls back to `package.json` for its version.
- The server records which app started it (`clientInfo`) in its log and in `canban_get_perf`.
- The server instructions tell the model to call `open_canban` to show the board, since Claude Desktop has no sidebar entry.

## 0.9.0 — 2026-09-27
- Terms no longer clash with Codex / Claude Code concepts of the same name (display only; stored data and MCP tool / argument names are unchanged):
  - Directories are now **カテゴリ**. "Directory" means a folder everywhere else, including "作業ディレクトリ" (cwd) in Canban's own detail view.
  - "⚡ ルール" is now **⚡ 自動化**. Codex `.rules` and Claude permission rules decide which commands may run. Codex automation threads are labelled "⏰ Codex オートメーション".
  - The agent filter is now **AI Apps**. "Agent" is kept for agents / sub-agents, as in Codex and Claude Code.
  - Tasks are now **タスクカード**, to keep them apart from Claude Code's Task / TaskCreate and Codex cloud tasks.
  - The UI takes these words from one table (`T` in `ui/board.html`). The README has a terminology table.
- Codex projects: "プロジェクト" is now the Codex app's project (named, several folders; read from `~/.codex/.codex-global-state.json` and the state DB) for threads that belong to one, and the folder name otherwise.
  - Folder names stay available as **フォルダ**: detail, tooltip and a scope filter.
  - A Codex project can be turned into a カテゴリ with its folders ("⇣ Codex" in the sidebar).
  - The app state file (over 1 MB) is parsed once per change and shared with the remote-host list; it used to be parsed on every board load. Warm `allSessions` went from 281 ms to 10 ms.
- Agent metadata:
  - Codex pins come from the Codex app (`pinned-thread-ids`; the DB column is no longer used). Pinned threads show 📌 and can be filtered ("Codex アプリでピン留めしたものだけ").
  - Claude sessions without desktop metadata on disk (common with recent Claude desktop versions) show their archived state as unknown instead of "not archived". The "close it in the app first" hint relies on the transcript's `entrypoint`.
  - Folder and pin filters now also apply to task cards.
- Codex sections (the sidebar headings, e.g. "doing" / "done"):
  - Cards show "§ name". Sections are a scope filter and a swimlane mode.
  - A new automation trigger, "Codex のセクション『…』に入ったら" (`section:<id>`), moves the card when the thread is moved between sections in Codex, so lists and sections no longer have to be kept in step by hand. Threads in a section are tracked even when long idle.
  - Section membership is re-read (about 1 ms, partial index) on every DB change, because moving a thread does not bump `updated_at`. It is in parity with the remote collector.
- Requests are not sent to a Codex thread that has follow-ups waiting in the Codex app's own queue ("⏭ Codex キュー N" on the card), so the two queues never interleave.

## 0.8.0 — 2026-09-27
- Send prompts to existing sessions from the board ("指示を送る" in the session detail) or from the model (`canban_send_prompt`): send now, or queue them to run one at a time when the session is free.
  - Delivered as one headless turn through the agent's own CLI (`codex exec resume` / `claude -p --resume`). The prompt goes on stdin; Canban still never writes agent files itself.
  - Permissions are inherited from the session and never raised: Codex uses the sandbox of the latest turn with approvals turned into failures; Claude Code uses the latest `permissionMode`.
  - Sessions without a sandbox need a confirmation for every prompt, and the model cannot send to them by default.
  - Safety gates: nothing is sent while a session is running, waiting for input or was just written; "send now" checks that the session did not change since you looked. One request per session at a time, guarded by a lock shared by all Canban servers. Failures pause the session's queue.
  - Queue: edit, reorder, cancel, stop and resume. Cards show 📨 queued / ▶ running. Results and run logs are kept per session.
  - Remote hosts are supported through a separate `server/remote/dispatch.py` (the collector stays read-only).
  - Settings: on/off, concurrency (local / per host), model access, model rate limit.
- Performance:
  - Only one Canban server (an elected leader) runs background work. Codex starts one server per thread, and each of them used to index and evaluate rules on its own.
  - The Codex session list is read incrementally. An unchanged database is not queried at all. The full read (about 2.4 s and blocking on a large history) now happens only at startup and every 30 minutes. Warm board loads went from about 1.3 s to about 0.1 s on a 6,000-session history.
  - Built-in timings with budgets (`docs/performance.md`), a "⚠ 遅い処理" indicator with details, and `npm run bench`.

## 0.7.0 — 2026-09-27
- Directories: a Canban-only, single-membership grouping for session and task cards, shown on cards in place of the project.
  - Assign with `g`, from the card detail, by dropping a card on a directory in the sidebar, or by dragging it between directory swimlanes.
  - Folders registered on a directory pull their sessions in automatically; an explicit choice (including "none") wins.
  - Also available as a filter, a swimlane mode, an analytics breakdown, a saved-view field and an MCP argument.
- Sidebar (`b`) listing lanes, directories and projects with counts, live status and new-card badges. Click a lane to jump to it; ⌥-click to show only that lane. Collapse or expand all lanes from here. Works as an overlay on narrow screens.
- Swimlanes:
  - Lane headers stay pinned while scrolling.
  - Lists inside a lane have a height cap (compact / normal / all).
  - Collapsed lanes show card counts per list.
  - "Only this lane" focus mode.
  - `[` / `]` step between lanes.
- Keyboard:
  - `/` focuses search (`Esc` clears; `↓` / `Enter` jumps to the first card).
  - ⌘K / Ctrl+K opens a command palette over cards, views, lanes, directories, projects, labels and actions.
  - `?` shows the shortcut overlay.
  - `p` opens the scope filter; `c` adds a card; `a` toggles analytics; `r` reloads.
  - On a focused card: `l` labels, `g` directory, `m` move to list, `h` hide.
  - Focus returns to the card after a picker or detail dialog closes.
- Every attribute choice uses a keyword-filterable picker: lists, labels (create inline), directories (create inline), projects, machines, tasks, swimlane mode and rule lists. Matching is multi-word and ignores case, width and katakana/hiragana. Long menus (views, labels, machines, rules) get a filter box.

## 0.6.0 — 2026-09-26
- Analytics view: sessions per day (stacked by agent), token usage, per-project and per-machine breakdowns, time spent in lists, cycle time to the last list and weekly completions. Charts have hover tooltips and a table view; the Codex/Claude colours are validated for colour-vision deficiencies in light and dark mode.
- Full-text search over conversations (toggle "本文"): a background FTS5 trigram index in `~/.canban/search.sqlite` (last 90 days, incremental) with highlighted snippets on cards; enabled remote hosts are searched on demand.
- Swimlanes by project, machine, agent or label (drag and drop keeps working across lanes).
- Saved views (filters, search, swimlane, view options) with 1–9 shortcuts.
- Token counts for Claude Code sessions (from message usage) and Codex (`tokens_used`), kept in parity with the remote collector.

## 0.5.0 — 2026-09-26
- Git / PR integration for GitHub (`gh`) and GitLab (`glab`): repos come from Codex's recorded origin, Claude PR links or the folder's `remote.origin.url`; PRs/MRs are matched by branch (with per-branch lookups for older branches) and cached for 5 minutes, all in the background so the board never waits.
- Cards show the PR/MR number with state colour and CI result; the detail lists checks / pipeline and the other sessions on the same branch.
- New rule triggers: PR/MR opened, merged, closed; CI failed, CI passed (fire only on transitions after a baseline, never for old PRs when first seen).
- View option to collapse sessions that share a repo + branch into one card.

## 0.4.0 — 2026-09-26
- Task cards: "+ Add a card" at the bottom of every list (Trello-style, Enter to keep adding). Tasks have a title, description, labels, priority, due date and linked sessions.
- Start a new Codex / Claude Code session from a task (desktop app deep link or terminal, local or on a remote host); the new session is linked to the task automatically once it appears (agent + machine + folder or prompt prefix, within an hour).
- Link existing sessions by dragging a session card onto a task card, or from the session detail. Linked sessions are shown inside the task, and rules move the task card.
- Codex sub-agents are shown on their parent card (🤖 count, running count) and listed in the detail.
- CLI-only Claude Code sessions now open in the Claude desktop app via `claude://resume?session=<id>`.

## 0.3.0 — 2026-09-26
- Keyboard: arrow keys move the focused card (←→ between lists, ↑↓ within a list, Home/End); ⌥ + arrows move focus only.
- Live status for recent sessions (running / waiting for input / completed / aborted) from the tail of each log, locally and on remote hosts (Python collector kept in parity with the JS rules and tested).
- "New" highlight for cards with activity since you last looked, and "mark all as read".
- Automatic-move rules (off by default): fire on status transitions or new activity, evaluated on board load and every 60 s in the background; moved cards are marked ⚡ and can be undone.
- Fixes: concurrent board writes are serialized (no lost updates / tmp-file collisions); remote collector arguments are passed as a JSON string (booleans/null previously broke the Python side); the server flushes stdout before exiting.

## 0.2.0 — 2026-09-26
- Renamed to **Canban** (data now lives in `~/.canban`; an existing `~/.session-kanban/board.json` is read once and never modified).
- Resume sessions from the board: in the agent's desktop app (Codex / Claude) or in a terminal (Ghostty, Terminal.app, iTerm2) as a new window, new tab, split, or in the existing window. Defaults are configurable and every variant has a shortcut.
- Claude Code sessions open in the Claude desktop app (`claude://code/continue`), falling back to a new session in the same folder.
- Remote machines: sessions on SSH hosts registered in the Codex app can be enabled per host and are read over SSH with a read-only Python collector.
- Tests: fixture-based MCP tests, Python/JS parity tests, fake-SSH tests; CI on macOS and Linux.

## 0.1.0
- First version: Codex sidebar app (MCP App with a `global` entrypoint), read-only Codex / Claude Code session readers, Trello-style board with user-defined lists, labels, notes, priority and due dates.

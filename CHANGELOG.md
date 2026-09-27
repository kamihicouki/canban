# Changelog

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

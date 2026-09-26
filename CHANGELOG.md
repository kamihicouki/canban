# Changelog

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

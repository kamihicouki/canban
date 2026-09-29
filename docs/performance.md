# Performance

Canban reads a lot of data. A real history used while building 0.8.0 had 4,461 Codex rollouts (15 GB), about 6,000 sessions and a 200 MB search index. Codex also starts one Canban server per thread, so ten or more servers can run at once. These budgets keep Canban from becoming the heavy part of your machine. `server/perf.mjs` measures them at runtime.

## Budgets (p95)

| Operation | Budget | Notes |
|---|---|---|
| `buildBoard` | 300 ms | Warm cache |
| `sessionDetail` | 300 ms | One tail read serves the messages, the live feed and the permissions |
| `live.watch` | 50 ms | Turning file events into card patches and the open session's appended lines (the wait itself is not counted) |
| `sessions.all` | 300 ms | Local and remote listings plus status |
| `codex.list` | 50 ms | 0 queries when the DB and WAL are unchanged; a delta by `updated_at` otherwise |
| `claude.list` | 100 ms | Transcript summaries cached by mtime and size |
| `remote.list` | 50 ms | Cached; refreshed in the background |
| `status` | 100 ms | Log tails cached by mtime and size |
| `tick.dispatch` | 100 ms | With no requests it only stats `requests.json` and never lists sessions |
| `dispatch.inspect` | 100 ms | 256 KB log tail of one session |
| `codexApp.read` | 30 ms | Parse of `~/.codex/.codex-global-state.json`; only when its mtime / size changes, shared by projects, pins, follow-ups and remote hosts |
| `tick.rules` / `tick.search` | 1 s / 3 s | Leader only |
| Event-loop delay | p99 < 50 ms | |
| Non-leader idle CPU | ≈ 0 | No background timers except the 30 s leader heartbeat; no file watchers unless its board is open |
| Open board, nothing happening | 1 tool call / 20 s | The long poll waits on `fs.watch`; no timers, no reads |
| RSS | ≤ 300 MB per server | |

Cold starts (the first full read after a server starts) are expected to go over budget once.

## What keeps it light

- **Leader election** (`server/leader.mjs`): one server holds `~/.canban/leader.lock` (pid plus a 30 s heartbeat) and runs rules, full-text indexing and the request queue. The others only answer tool calls. A lock with a dead owner or no heartbeat for 90 s is taken over.
- **Incremental Codex listing** (`server/sources/codex.mjs`):
  - Rows are cached per DB. When the DB and WAL mtimes are unchanged, nothing is queried. Otherwise only rows with `updated_at >= last max − 1` are read (indexed), and the archived flags are refreshed from their index.
  - A full read happens when the row count disagrees (deletions) and every 30 minutes.
  - The full read is synchronous. On a large history it blocks the event loop for about 2 s, so avoid adding more of them.
- **Requests** (`server/dispatch.mjs`):
  - An idle tick is one `stat`. With work, sessions are resolved one by one from the listing caches (never the whole board, no PR lookups).
  - Remote runs are polled every 20 s, one ssh call per host.
  - Claude runs use `--output-format json`, so run logs hold one result.
  - Logs are removed with their request (50 kept per session, 1,000 overall) or after 14 days.
- **Realtime** (`server/live.mjs`, `server/watch.mjs`, `server/feed.mjs`):
  - Watchers exist only while a board is open (60 s after its last `canban_watch`). They cover the data dir, the Codex home (state DB / WAL), `~/.claude/projects` (recursive) and the logs of running sessions and of the open session.
  - A grown log becomes a card patch from one cached tail read (the same cache as the status). No session listing, no PR lookups. A Codex DB change runs the incremental listing, which is a delta query.
  - The open session's log is read from the client's offset. More than 1 MB behind restarts from the tail.
  - Bursts of writes are coalesced (150 ms), and the UI rebuilds the whole board at most every 1.5 s.
- The board payload carries only per-card request counts. Queues and history load with the detail.

## Watching it

- **At runtime**: over-budget operations are logged to stderr (`[canban] slow: codex.list 2375ms > 50ms`, at most once a minute per operation). They also show up as "⚠ 遅い処理" in the header. Click it for p50 / p95 / max per operation, event-loop delay, memory and which server is the leader. The same data is available from the app tool `canban_get_perf`.
- **While developing**: run `npm run bench` after each change. It reads your real data (read-only) with Canban's data copied to a temp dir.

  ```bash
  npm run bench -- --save before.json
  # … change …
  npm run bench -- --compare before.json
  npm run bench -- --procs 10     # ten servers on one data dir: total CPU / RSS, exactly one leader
  ```

  Numbers are only comparable on a quiet machine: check `uptime` first. A load average in the hundreds makes every operation look 10–40× slower.
- **In tests**: tests check structure rather than wall-clock time, to avoid flakes:
  - An unchanged DB is not queried; a change is read as a delta.
  - An idle dispatch tick lists no sessions.
  - Two dispatchers start a queued prompt exactly once.
  - The request lock holds across processes.

## Baseline (2026-09-27, before / after the 0.8.0 work, quiet machine)

| Scenario | Before | After |
|---|---|---|
| `allSessions` (cold) | 18,566 ms | 3,138 ms |
| `allSessions` (cache expired) | 3,072 ms | 56 ms |
| `buildBoard` (warm) | 1,302 ms | 95 ms |
| `sessionDetail` (latest) | 575 ms | 147 ms |
| Event-loop delay p99 / max | 313 / 2,294 ms | 77 / 427 ms |
| 10 servers, total CPU over 60 s | spikes to 56 %, every server indexing | 1 leader; about 0 % between the leader's steps |

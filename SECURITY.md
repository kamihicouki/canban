# Security

Canban never writes your agents' data itself:

- Codex's `state_*.sqlite` is opened with SQLite's read-only mode (`readOnly` / `mode=ro`) plus `PRAGMA query_only`; transcripts are opened for reading only. The tests lock fixture trees with `chmod a-w` and compare hashes before and after reading.
- Everything Canban itself stores (lists, labels, notes, settings) is written only inside `~/.canban/` (or `$CANBAN_DATA_DIR`): `canban.sqlite` (WAL, board entities, shared UI state, rule observations, presence, leases, requests), the full-text index `search.sqlite` (built from text read out of the session logs; it stays on your machine),  `runs/*.log` (CLI output of each run, removed after 14 days). While a board is open, Canban also watches the session logs for changes (`fs.watch`, read-only).
- Account files are read-only and read narrowly: `oauthAccount` in `.claude.json` (account / org id, e-mail, name), `tokens.account_id` and the e-mail / plan claims of the `id_token` in Codex's `auth.json`, `lastKnownAccountUuid` in the Claude desktop app's `config.json`, and the usage samples in its `plan-usage-history.json`. Access / refresh tokens and the desktop token cache are never returned, logged or stored. Extra config folders (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) are only read, and are passed in that variable when Canban resumes or sends a prompt to one of their sessions.
- The account runner (off by default) is the only part of Canban that writes for the agents, and only inside its data dir: account folders in `~/.canban/accounts/` (a marker file, symlinks to shared files of the default folder, a copied `settings.json` / `config.toml`), removed folders in `~/.canban/accounts/.trash/` (never deleted), and Claude usage in `~/.canban/usage/`. It never writes to `~/.claude`, `~/.codex`, the desktop apps' data or other account switchers' files, and never reads a token: logging in runs `claude auth login` / `codex login` in the user's terminal. The statusline tap of a runner folder keeps only `rate_limits` (percent used, reset time) and passes its input on to the folder's original status line command.
- Remote hosts are **opt-in per host**. Canban runs `ssh -o BatchMode=yes -T -- <alias> python3 -` and pipes a fixed, bundled script (`server/remote/collect.py`) to it. Host aliases come from the Codex app's registered connections and are validated so they can never be parsed as ssh options. The collector only reads files under `~/.codex` and `~/.claude` on the remote host.
- **Sending prompts (0.8.0).** A prompt is delivered by running the agent's own CLI for one non-interactive turn in the existing session — `codex exec resume … <id> -` or `claude -p --resume <id>` — so only the agent writes its session files.
  - The process is started with an argv array (no shell). The prompt is written to its stdin and never appears in argv or a shell string. Session ids are validated before use.
  - Permissions are **inherited, never raised**: Codex runs with the sandbox of the session's latest turn (or its recorded policy; read-only if unknown) and `approval_policy="never"`, so anything that would need approval fails instead of asking. Claude Code runs with the session's latest `permissionMode` (default if unknown).
  - Sessions running without a sandbox / permission checks (`danger-full-access`, `bypassPermissions`) need an explicit confirmation for every prompt from the board. The model (via `canban_send_prompt`) cannot send to them unless you allow it in the settings. Model requests are also rate-limited per session.
  - A prompt is not sent while the session is running, waiting for input, or was written in the last 20 seconds. A "send now" prompt is not sent if the session changed after you looked at it. Only one Canban request runs per session: requests are claimed under a short SQLite BEGIN IMMEDIATE transaction shared by all Canban servers. A failed or stopped run pauses that session's queue.
  - Environment variables of the agent that started Canban (`CLAUDECODE`, `CLAUDE_CODE_*`, `CODEX_THREAD_ID`, …) are removed before the CLI starts.
  - Stopping a run only signals processes Canban started. It checks that the process's command line contains the session id first.
  - On remote hosts, the collector (`server/remote/collect.py`) stays read-only. Starting, polling and stopping runs is done by a separate bundled script, `server/remote/dispatch.py`, piped over the same `ssh -o BatchMode=yes -T` connection. It only reads session logs under the agent data directories and writes run logs to `~/.canban-remote/runs`.
  - Everything can be turned off in ⚙ Settings (sending as a whole, or sending from the model).
- Opening a session only launches `codex:` / `claude:` URLs through the OS URL handler, or passes a resume command to your terminal via AppleScript as an argument (never through a shell string).

## Chrome extension

The unpacked Chrome extension connects to `com.kamihicouki.canban` with the `nativeMessaging` permission. The installer registers one per-user host manifest, allowing only the supplied extension ID. The host launches this repository's existing MCP server over stdio and accepts `tools/call` requests; it opens no HTTP listener. Chrome can use the same board and session operations as the existing Canban UI, subject to the same handlers and settings. The MCP server runs as the current user and retains the data access documented above.

Run `npm run uninstall:chrome-native-host -- --extension-id <extension ID>` to remove the host registration. Remove the unpacked extension through `chrome://extensions` to remove the Chrome UI.

## Reporting a vulnerability

Please open a [private security advisory](https://github.com/kamihicouki/canban/security/advisories/new) instead of a public issue.

SQLite does not replace the agents’ own session stores. External apps do not honor Canban leases: Canban rechecks the session before spawn and stops on CLI writer conflicts. Unknown execution results are interrupted and are never automatically resent. Expiry alone cannot clear a session lease. Offline migration backs up JSON with restricted permissions; after migration JSON is never a fallback source.

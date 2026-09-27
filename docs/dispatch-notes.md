# Sending prompts: how the agents' CLIs behave

These notes come from experiments with throwaway sessions before sending was built (2026-09-27, codex-cli 0.156.1, Claude Code 2.1.220). Re-check them when the CLIs change.

## Codex: `codex exec resume`

```bash
echo "…" | codex exec resume --json --skip-git-repo-check \
  -c sandbox_mode="workspace-write" -c approval_policy="never" <thread-id> -
```

- The turn is appended to the **same thread id and the same rollout file**. The `thread.started` event repeats the original id.
- The `-c sandbox_mode` override takes effect: the new `turn_context.sandbox_policy` shows it.
- The state DB's `threads.sandbox_policy` is **overwritten with what was passed**. Canban passes the session's own latest policy, so nothing changes. If you pass a wrong value, the session keeps it for later turns, so `tests/dispatch.test.mjs` checks the inheritance.
- `threads.sandbox_policy` comes in two formats:
  - The legacy format is `{"type":"read-only"|"workspace-write"|"danger-full-access"}`.
  - The newer format is `{"type":"managed","file_system":{"type":"restricted","entries":[{…,"access":"read"|"write"}]},"network":"restricted"|"enabled"}`. Canban maps it this way: any `write` entry means workspace-write, none means read-only, and a non-`restricted` file system means danger-full-access. The rollout's `turn_context` wins when present.
- `--json` events:
  - `thread.started{thread_id}`, `turn.started`, `item.completed{item:{type:"agent_message",text}}`, `turn.completed{usage}` / `turn.failed{error}`.
  - Network trouble shows up as `{"type":"error","message":"Reconnecting... n/5 …"}` and retries, which can take minutes. It is not a failure.
- Headless runs cannot answer approval prompts, so `approval_policy="never"` makes actions that would need approval fail instead.

## Claude Code: `claude -p --resume`

```bash
echo "…" | claude -p --resume <session-id> --output-format json --permission-mode <mode>
```

- `--resume` keeps the session id unless `--fork-session` is given (per `--help`).
- The transcript records `permissionMode` on each prompt. The values seen are `default`, `acceptEdits`, `auto`, `plan`, `dontAsk` and `bypassPermissions`. `--permission-mode default` is accepted even though `--help` lists `manual`.
- The result object can say `"subtype":"success"` together with `"is_error":true` (for example `Failed to authenticate`). **Use `is_error`.**
- **Environment leak**: when Canban runs under Claude Code (desktop), variables such as `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID` and `CLAUDE_CODE_MESSAGING_*` are inherited. Passed through, the new turn is recorded as coming from `claude-desktop`. Canban removes `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_AGENT_SDK_VERSION`, `CODEX_THREAD_ID`, `CODEX_SANDBOX*` and `CODEX_MANAGED_*` before starting the CLI (locally and in `dispatch.py`).
- Not verified yet: a successful end-to-end turn. The CLI's OAuth session had expired in the test environment.

## Not verified

- What the Codex app and the Claude desktop app show when a thread they have open receives a headless turn. The UI asks you to close the session in the app before sending.

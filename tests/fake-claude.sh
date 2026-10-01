#!/bin/sh
# Fake `claude -p --resume` for tests (see fake-codex.sh). Prints one --output-format json result.
prompt="$(cat)"
[ -n "$FAKE_AGENT_SLEEP" ] && sleep "$FAKE_AGENT_SLEEP"
node -e '
const fs = require("fs");
const [prompt, ...argv] = process.argv.slice(1);
if (process.env.FAKE_AGENT_LOG) fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ agent: "claude", argv, prompt, cwd: process.cwd(), claudecode: process.env.CLAUDECODE ?? null, entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null, configDir: process.env.CLAUDE_CONFIG_DIR ?? null }) + "\n");
// FAKE_AGENT_LIMIT_DEFAULT: the account of the default folder is out of usage.
const limit = process.env.FAKE_AGENT_LIMIT_DEFAULT === "1" && !process.env.CLAUDE_CONFIG_DIR;
const fail = process.env.FAKE_AGENT_FAIL === "1" || limit;
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: fail, result: limit ? "Claude AI usage limit reached|1790000000" : fail ? "Failed to authenticate" : "done: " + prompt.slice(0, 40) }) + "\n");
' "$prompt" "$@"
[ "$FAKE_AGENT_FAIL" = "1" ] && exit 1
exit 0

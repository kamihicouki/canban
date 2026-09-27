#!/bin/sh
# Fake `codex exec resume` for tests: records argv, stdin and selected env to
# $FAKE_AGENT_LOG (one JSON object per run) and prints --json events.
# FAKE_AGENT_FAIL=1 fails the turn; FAKE_AGENT_SLEEP=<s> keeps it running.
prompt="$(cat)"
[ -n "$FAKE_AGENT_SLEEP" ] && sleep "$FAKE_AGENT_SLEEP"
node -e '
const fs = require("fs");
const [prompt, ...argv] = process.argv.slice(1);
if (process.env.FAKE_AGENT_LOG) fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ agent: "codex", argv, prompt, cwd: process.cwd(), claudecode: process.env.CLAUDECODE ?? null, entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null }) + "\n");
' "$prompt" "$@"
echo '{"type":"thread.started","thread_id":"fake"}'
echo '{"type":"turn.started"}'
if [ "$FAKE_AGENT_FAIL" = "1" ]; then
  echo '{"type":"turn.failed","error":{"message":"fake failure"}}'
  exit 1
fi
echo '{"type":"error","message":"Reconnecting... 1/5 (request timed out)"}'
printf '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"done: %s"}}\n' "$(printf %s "$prompt" | tr -d '"\\\n' | head -c 40)"
echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'

# Security

Canban is designed to be **read-only** with respect to your agents' data:

- Codex's `state_*.sqlite` is opened with SQLite's read-only mode (`readOnly` / `mode=ro`) plus `PRAGMA query_only`; transcripts are opened for reading only. The tests lock fixture trees with `chmod a-w` and compare hashes before and after reading.
- Everything Canban itself stores (lists, labels, notes, settings) is written only to `~/.canban/board.json` (or `$CANBAN_DATA_DIR`).
- Remote hosts are **opt-in per host**. Canban runs `ssh -o BatchMode=yes -T -- <alias> python3 -` and pipes a fixed, bundled script (`server/remote/collect.py`) to it. Host aliases come from the Codex app's registered connections and are validated so they can never be parsed as ssh options. The collector only reads files under `~/.codex` and `~/.claude` on the remote host.
- Opening a session only launches `codex:` / `claude:` URLs through the OS URL handler, or passes a resume command to your terminal via AppleScript as an argument (never through a shell string).

## Reporting a vulnerability

Please open a [private security advisory](https://github.com/kamihicouki/canban/security/advisories/new) instead of a public issue.

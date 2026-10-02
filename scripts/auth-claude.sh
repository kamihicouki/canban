#!/bin/bash
# Node's child stdio uses sockets on macOS; script needs a real pipe for stdin.
# exec preserves script's exit status without waiting on an idle input feeder.
exec /usr/bin/script -q /dev/null "$@" < <(/bin/cat)

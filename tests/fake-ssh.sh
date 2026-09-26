#!/bin/sh
# Fake `ssh` for tests: skips options, then runs the remote command locally.
# Special aliases: down-host (connection refused), slow-host (hangs).
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    -o|-p) shift 2 ;;
    *) shift ;;
  esac
done
host="$1"; shift
case "$host" in
  down-host) echo "ssh: connect to host down-host port 22: Connection refused" >&2; exit 255 ;;
  slow-host) exec sleep 5 ;;
esac
exec "$@"

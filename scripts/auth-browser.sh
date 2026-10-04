#!/bin/sh
# Claude's BROWSER hook. All arguments remain separate from shell code.
exec "$CANBAN_AUTH_NODE" "$CANBAN_AUTH_HELPER" "$@"

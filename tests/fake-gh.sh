#!/bin/sh
# Fake `gh` for tests: `auth status` succeeds; `pr list --repo R` prints the PRs for R
# from the JSON file in $FAKE_GH_DATA ({ "owner/repo": [ ...prs ] }).
if [ "$1" = "auth" ]; then exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  repo=""
  while [ $# -gt 0 ]; do [ "$1" = "--repo" ] && repo="$2"; shift; done
  exec python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])).get(sys.argv[2], [])))' "$FAKE_GH_DATA" "$repo"
fi
echo "unsupported: $*" >&2; exit 1

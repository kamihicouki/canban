#!/bin/sh
# Fake `glab` for tests: `auth status` succeeds; `mr list -R P` prints MRs for P from
# $FAKE_GLAB_DATA ({ "mrs": { "group/proj": [...] }, "pipelines": { "group/proj!1": "failed" } });
# `api projects/<enc>/merge_requests/<iid>` returns { head_pipeline: { status } }.
if [ "$1" = "auth" ]; then exit 0; fi
exec python3 - "$@" <<'PY'
import json, os, sys, urllib.parse
args = sys.argv[1:]
data = json.load(open(os.environ["FAKE_GLAB_DATA"]))
if args[:2] == ["mr", "list"]:
    print(json.dumps(data["mrs"].get(args[args.index("-R") + 1], [])))
elif args[0] == "api":
    parts = args[1].split("/")
    path, iid = urllib.parse.unquote(parts[1]), parts[3]
    st = data.get("pipelines", {}).get(f"{path}!{iid}")
    print(json.dumps({"head_pipeline": {"id": 7, "status": st, "web_url": "https://gitlab.com/p"} if st else None}))
else:
    sys.exit(1)
PY

# Canban remote collector. Sent over `ssh <host> python3 -` and run with the Python 3
# standard library only. It is strictly read-only: SQLite is opened with mode=ro and
# files are opened for reading. The caller prepends `ARGS = json.loads("...")` to this file.
#
# Output: a single JSON document on stdout.
#   list     -> {"ok", "codex": {"rows", "error"}, "claude": {"summaries", "unchanged", "desktop", "error"}}
#   messages -> {"ok", "records"}   (records are raw JSON lines, pre-filtered)
# Keep field names in sync with server/sources/codex.mjs and server/sources/claude.mjs.
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

HOME = os.path.expanduser("~")
CODEX_HOME = os.environ.get("CODEX_HOME") or os.path.join(HOME, ".codex")
CLAUDE_HOME = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(HOME, ".claude")
DESKTOP_DIR = os.path.join(HOME, "Library", "Application Support", "Claude", "claude-code-sessions")
if isinstance(globals().get("ARGS"), dict):
    CODEX_HOME = ARGS.get("codexHome") or CODEX_HOME  # noqa: F821 (tests point these at fixtures)
    CLAUDE_HOME = ARGS.get("claudeHome") or CLAUDE_HOME  # noqa: F821
    DESKTOP_DIR = ARGS.get("desktopDir") or DESKTOP_DIR  # noqa: F821

CODEX_COLUMNS = [
    "id", "rollout_path", "created_at", "updated_at", "created_at_ms", "updated_at_ms", "source", "thread_source",
    "cwd", "title", "name", "archived", "git_branch", "model", "first_user_message", "preview", "agent_role",
    "agent_nickname", "is_pinned",
]
SUMMARY_PROMPTS = 3
TAIL_BYTES = 768 * 1024
STATUS_TAIL_BYTES = 256 * 1024
RECENT_MS = 24 * 3600 * 1000
ASK_TOOLS = {"request_user_input", "AskUserQuestion", "ExitPlanMode"}
TS_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$")

def parse_ts(value):
    """ISO-8601 -> epoch milliseconds (matches JS Date.parse for the formats agents write)."""
    if not isinstance(value, str):
        return None
    m = TS_RE.match(value.strip())
    if not m:
        return None
    base, frac, tz = m.groups()
    try:
        dt = datetime.strptime(base, "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return None
    if tz in (None, "Z"):
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        sign = 1 if tz[0] == "+" else -1
        hh, mm = int(tz[1:3]), int(tz[-2:])

        dt = dt.replace(tzinfo=timezone(sign * timedelta(hours=hh, minutes=mm)))
    ms = int(dt.timestamp()) * 1000
    if frac:
        ms += int((frac[1:] + "000")[:3])
    return ms

def state_db():
    best = None
    try:
        names = os.listdir(CODEX_HOME)
    except OSError:
        return None
    for name in names:
        m = re.match(r"^state_(\d+)\.sqlite$", name)
        if m and (best is None or int(m.group(1)) > best[0]):
            best = (int(m.group(1)), os.path.join(CODEX_HOME, name))
    return best[1] if best else None

def codex_rows():
    path = state_db()
    if not path:
        return {"rows": [], "error": None}
    try:
        con = sqlite3.connect("file:%s?mode=ro" % path, uri=True, timeout=5)
        try:
            con.execute("PRAGMA query_only = ON")
            cols = {r[1] for r in con.execute("PRAGMA table_info(threads)")}
            want = [c for c in CODEX_COLUMNS if c in cols]
            cur = con.execute("SELECT %s FROM threads" % ", ".join(want))
            rows = [dict(zip(want, r)) for r in cur]
            edges = []
            if con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_spawn_edges'").fetchone():
                edges = [{"parent": p, "child": c} for p, c in con.execute("SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges")]
        finally:
            con.close()
        now = now_ms()
        for r in rows:
            updated = r.get("updated_at_ms") or ((r.get("updated_at") or 0) * 1000)
            r["rawStatus"], r["statusMtimeMs"] = raw_status_for(r.get("rollout_path"), "codex", updated, now)
        return {"rows": rows, "edges": edges, "error": None}
    except Exception as e:  # noqa: BLE001
        return {"rows": [], "edges": [], "error": "Codex DB 読み取り失敗: %s" % e}

# ---- live status (keep in sync with server/status.mjs) ---------------------
def now_ms():
    args = globals().get("ARGS") or {}
    return args.get("now") or int(__import__("time").time() * 1000)


def codex_raw_status(records):
    state = "idle"
    asks = set()
    for o in records:
        p = o.get("payload") if isinstance(o, dict) else None
        if not isinstance(p, dict):
            continue
        if o.get("type") == "event_msg":
            t = p.get("type")
            if t == "task_started":
                state = "running"
            elif t == "task_complete":
                state = "completed"
            elif t == "turn_aborted":
                state = "aborted"
        elif o.get("type") == "response_item":
            if p.get("type") == "function_call" and p.get("name") in ASK_TOOLS and p.get("call_id"):
                asks.add(p["call_id"])
            elif p.get("type") == "function_call_output" and p.get("call_id"):
                asks.discard(p["call_id"])
    if state == "running" and asks:
        state = "waiting"
    return state


def claude_raw_status(records, desktop_status=None):
    state = "idle"
    asks = set()
    for o in records:
        if not isinstance(o, dict) or o.get("isSidechain") or o.get("type") not in ("user", "assistant"):
            continue
        msg = o.get("message") or {}
        c = msg.get("content")
        items = c if isinstance(c, list) else []
        if o["type"] == "assistant":
            for it in items:
                if isinstance(it, dict) and it.get("type") == "tool_use" and it.get("name") in ASK_TOOLS and it.get("id"):
                    asks.add(it["id"])
            state = "completed" if msg.get("stop_reason") in ("end_turn", "stop_sequence") else "running"
        else:
            for it in items:
                if isinstance(it, dict) and it.get("type") == "tool_result" and it.get("tool_use_id"):
                    asks.discard(it["tool_use_id"])
            text = c if isinstance(c, str) else "".join(it.get("text", "") for it in items if isinstance(it, dict) and it.get("type") == "text")
            state = "aborted" if "[Request interrupted by user" in text else "running"
    if state == "running" and asks:
        state = "waiting"
    if state == "completed" and desktop_status:
        d = str(desktop_status).lower()
        if re.search(r"input|waiting|question|blocked|needs", d):
            state = "waiting"
        elif re.search(r"error|fail", d):
            state = "aborted"
    return state


def read_tail(path, nbytes):
    with open(path, "rb") as fh:
        fh.seek(0, os.SEEK_END)
        size = fh.tell()
        start = max(0, size - nbytes)
        fh.seek(start)
        data = fh.read().decode("utf-8", errors="replace")
    lines = data.split("\n")
    if start > 0:
        lines = lines[1:]
    out = []
    for line in lines:
        if not line.strip():
            continue
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out


def raw_status_for(path, agent, updated_ms, now):
    """(raw status, log mtime ms) for recently updated sessions; the caller settles it."""
    if not path or updated_ms < now - RECENT_MS:
        return None, None
    try:
        st = os.stat(path)
        records = read_tail(path, STATUS_TAIL_BYTES)
    except (OSError, ValueError):
        return None, None
    raw = codex_raw_status(records) if agent == "codex" else claude_raw_status(records)
    return raw, st.st_mtime * 1000

def text_of(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(c["text"] for c in content if isinstance(c, dict) and c.get("type") == "text" and isinstance(c.get("text"), str))

def is_human_prompt(o):
    if o.get("type") != "user" or o.get("isSidechain") or o.get("isMeta"):
        return False
    c = (o.get("message") or {}).get("content")
    if isinstance(c, list) and any(isinstance(x, dict) and x.get("type") == "tool_result" for x in c):
        return False
    return True

def summarize(path, session_id):
    s = {
        "sessionId": session_id, "cwd": None, "branch": None, "prompts": [], "customTitle": None, "agentName": None,
        "model": None, "createdAt": None, "updatedAt": None, "prUrl": None, "turns": 0,
    }
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if not isinstance(o, dict):
                continue
            ts = parse_ts(o.get("timestamp"))
            if ts is not None:
                if s["createdAt"] is None or ts < s["createdAt"]:
                    s["createdAt"] = ts
                if s["updatedAt"] is None or ts > s["updatedAt"]:
                    s["updatedAt"] = ts
            if o.get("cwd") and not s["cwd"]:
                s["cwd"] = o["cwd"]
            if o.get("gitBranch"):
                s["branch"] = o["gitBranch"]
            t = o.get("type")
            if t == "custom-title" and o.get("customTitle"):
                s["customTitle"] = o["customTitle"]
            elif t == "agent-name" and o.get("agentName"):
                s["agentName"] = o["agentName"]
            elif t == "pr-link" and o.get("prUrl"):
                s["prUrl"] = o["prUrl"]
            elif t == "assistant" and (o.get("message") or {}).get("model"):
                s["model"] = o["message"]["model"]
            elif t == "user" and is_human_prompt(o):
                s["turns"] += 1
                if len(s["prompts"]) < SUMMARY_PROMPTS:
                    s["prompts"].append(text_of((o.get("message") or {}).get("content")))
    return s

def desktop_meta():
    meta = {}
    if not os.path.isdir(DESKTOP_DIR):
        return meta
    for root, _dirs, files in os.walk(DESKTOP_DIR):
        if root.count(os.sep) - DESKTOP_DIR.count(os.sep) > 2:
            continue
        for f in files:
            if f.startswith("local_") and f.endswith(".json"):
                try:
                    with open(os.path.join(root, f), "r", encoding="utf-8") as fh:
                        j = json.load(fh)
                except (OSError, ValueError):
                    continue
                if isinstance(j, dict) and j.get("cliSessionId"):
                    meta[j["cliSessionId"]] = {k: j.get(k) for k in ("sessionId", "title", "isArchived", "lastActivityAt", "cwd", "model", "postTurnSummary")}
    return meta

def claude_summaries(known):
    projects = os.path.join(CLAUDE_HOME, "projects")
    out = {"summaries": [], "unchanged": [], "desktop": {}, "error": None}
    if not os.path.isdir(projects):
        return out
    try:
        out["desktop"] = desktop_meta()
        for p in sorted(os.listdir(projects)):
            d = os.path.join(projects, p)
            if not os.path.isdir(d):
                continue
            for f in sorted(os.listdir(d)):
                fp = os.path.join(d, f)
                if not f.endswith(".jsonl") or not os.path.isfile(fp):
                    continue
                st = os.stat(fp)
                sig = [st.st_mtime * 1000, st.st_size]
                prev = known.get(fp)
                if prev and abs(prev[0] - sig[0]) < 1 and prev[1] == sig[1]:
                    out["unchanged"].append(fp)
                    continue
                s = summarize(fp, f[: -len(".jsonl")])
                s["file"] = fp
                s["fileMtimeMs"] = sig[0]
                s["fileBirthMs"] = getattr(st, "st_birthtime", st.st_mtime) * 1000
                s["sig"] = sig
                s["rawStatus"], s["statusMtimeMs"] = raw_status_for(fp, "claude", max(s["updatedAt"] or 0, sig[0]), now_ms())
                out["summaries"].append(s)
    except Exception as e:  # noqa: BLE001
        out["error"] = "Claude セッション読み取り失敗: %s" % e
    return out

def within(path, roots):
    real = os.path.realpath(path)
    return any(real == r or real.startswith(r + os.sep) for r in (os.path.realpath(x) for x in roots))

def keep_record(o, agent):
    if not isinstance(o, dict):
        return None
    if agent == "codex":
        p = o.get("payload") or {}
        it = p.get("item") or {}
        if o.get("type") == "event_msg" and p.get("type") == "item_completed" and it.get("type") in ("UserMessage", "AgentMessage"):
            return o
        return None
    if o.get("type") in ("user", "assistant"):
        return o
    return None

def tail_records(path, agent):
    if not within(path, [CODEX_HOME, CLAUDE_HOME]):
        raise ValueError("許可されていないパスです")
    with open(path, "rb") as fh:
        fh.seek(0, os.SEEK_END)
        size = fh.tell()
        start = max(0, size - TAIL_BYTES)
        fh.seek(start)
        data = fh.read().decode("utf-8", errors="replace")
    lines = data.split("\n")
    if start > 0:
        lines = lines[1:]
    out = []
    for line in lines:
        if not line.strip():
            continue
        try:
            o = keep_record(json.loads(line), agent)
        except ValueError:
            continue
        if o is not None:
            out.append(o)
    return out

def main():
    args = globals().get("ARGS") or {}
    mode = args.get("mode", "list")
    if mode == "list":
        result = {"ok": True, "codex": codex_rows(), "claude": claude_summaries(args.get("known") or {})}
    elif mode == "status":  # used by the parity tests
        recs = args.get("records") or []
        result = {"ok": True, "raw": codex_raw_status(recs) if args.get("agent") == "codex" else claude_raw_status(recs)}
    elif mode == "messages":
        result = {"ok": True, "records": tail_records(args["path"], args.get("agent", "codex"))}
    else:
        result = {"ok": False, "error": "unknown mode"}
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))

try:
    main()
except Exception as e:  # noqa: BLE001
    sys.stdout.write(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))

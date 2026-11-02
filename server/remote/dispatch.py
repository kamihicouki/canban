# Canban remote dispatcher. Sent over `ssh <host> python3 -` like collect.py, but kept
# separate because it starts processes: it runs one headless turn of the agent's own
# CLI (codex / claude) in an existing session. It never writes agent files itself.
# The caller prepends `ARGS = json.loads("...")` to this file.
#
# Modes (one JSON document on stdout):
#   inspect -> {"ok", "records", "mtimeMs"}   tail of the session log (status + permissions)
#   start   -> {"ok", "pid", "log"}           start the CLI detached, prompt on its stdin
#   poll    -> {"ok", "runs": {id: {"alive", "log"}}}  several runs in one ssh call
#   stop    -> {"ok", "stopped"}              SIGINT to a run this script started
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import base64
import hashlib

def prompt_images(a):
    images = a.get('images') or []
    if not isinstance(images, list) or len(images) > 8:
        raise ValueError('画像は8枚までです')
    out = []
    folder = os.path.join(HOME, '.canban-remote', 'prompt-images')
    os.makedirs(folder, mode=0o700, exist_ok=True)
    types = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif'}
    for image in images:
        if image.get('mime') not in types or not re.fullmatch(r'[a-f0-9]{64}', image.get('sha256') or ''):
            raise ValueError('画像の指定が不正です')
        data = base64.b64decode(image.get('data') or '', validate=True)
        if not 0 < len(data) <= 10 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != image['sha256']:
            raise ValueError('画像の内容が一致しません')
        file = os.path.join(folder, image['sha256'] + '.' + types[image['mime']])
        fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
        out.append({k: v for k, v in image.items() if k not in ('data', 'path')})
        out[-1]['path'] = file
    return {'ok': True, 'images': out}

def prompt_skills(a):
    agent = a.get('agent') or 'codex'
    if agent not in ('codex', 'claude'):
        raise ValueError('未対応のAI Appです')
    home = a.get('homeDir') or os.environ.get('CODEX_HOME' if agent == 'codex' else 'CLAUDE_CONFIG_DIR') or os.path.join(HOME, '.' + agent)
    roots = [os.path.join(home, 'skills'), os.path.join(home, 'plugins', 'cache')]
    if agent == 'codex':
        roots.append(os.path.join(HOME, '.agents', 'skills'))
    cwd = a.get('cwd') or ''
    if cwd and not os.path.isabs(cwd):
        raise ValueError('作業フォルダは絶対パスで指定してください')
    while cwd:
        roots.insert(0, os.path.join(cwd, '.agents' if agent == 'codex' else '.claude', 'skills'))
        if agent == 'codex':
            roots.insert(0, os.path.join(cwd, '.codex', 'skills'))
        parent = os.path.dirname(cwd)
        if parent == cwd:
            break
        cwd = parent
    skills, seen = [], set()
    def walk(folder, depth=0):
        real = os.path.realpath(folder)
        if real in seen or depth > 8 or len(skills) >= 1000:
            return
        seen.add(real)
        file = os.path.join(folder, 'SKILL.md')
        try:
            if os.path.isfile(file):
                with open(file, encoding='utf-8') as f:
                    text = f.read(16000)
                header = re.match(r'^---\r?\n([\s\S]*?)\r?\n---', text)
                header = header.group(1) if header else ''
                name = re.search(r'^name:\s*[\"\x27]?([^\r\n\"\x27]+)', header, re.M)
                name = name.group(1).strip() if name else os.path.basename(folder)
                if not re.fullmatch(r'[\w.:-]+', name):
                    return
                description = re.search(r'^description:\s*(.+)', header, re.M)
                description = description.group(1).strip() if description else ''
                if re.fullmatch(r'[>|]-?', description):
                    match = re.search(r'^description:\s*[>|]-?\s*\n((?:[ \t]+[^\n]*\n?)+)', header, re.M)
                    description = ' '.join(match.group(1).split()) if match else ''
                skills.append({'name': name, 'path': file, 'description': description.strip('\"\x27')[:300]})
                return
            for entry in os.scandir(folder):
                if entry.name not in ('node_modules', '.git') and entry.is_dir():
                    walk(entry.path, depth + 1)
        except (OSError, UnicodeError):
            pass
    for root in roots:
        walk(root)
    return {'ok': True, 'skills': sorted(skills, key=lambda s: (s['name'], s['path']))}

HOME = os.path.expanduser("~")
RUNS = os.path.join(HOME, ".canban-remote", "runs")
BINS = {"codex", "claude"}
ID_RE = re.compile(r"^req-[a-z0-9]+-[a-f0-9]+$")
EXTRA_PATH = [os.path.join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", os.path.join(HOME, ".npm-global", "bin"), os.path.join(HOME, "bin")]
# Variables of an agent that may have started the ssh session; they must not leak into the turn.
DROP_ENV = re.compile(r"^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION|CODEX_THREAD_ID|CODEX_SANDBOX.*|CODEX_MANAGED_.*)$")

def args():
    a = globals().get("ARGS")
    return a if isinstance(a, dict) else {}

def run_id(a):
    rid = str(a.get("id") or "")
    if not ID_RE.match(rid):
        raise ValueError("bad request id")
    return rid

def runs_dir():
    return args().get("runsDir") or RUNS  # tests point this at a temp dir

def log_path(rid):
    return os.path.join(runs_dir(), rid + ".log")

def tail_text(path, nbytes=65536):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - nbytes))
            return f.read().decode("utf-8", "replace")
    except OSError:
        return ""

def inspect(a):
    path = os.path.expanduser(str(a.get("path") or ""))
    roots = [os.path.join(HOME, ".codex"), os.path.join(HOME, ".claude"), os.environ.get("CODEX_HOME") or "", os.environ.get("CLAUDE_CONFIG_DIR") or ""]
    roots += [a.get("codexHome") or "", a.get("claudeHome") or ""]  # tests point these at fixtures
    real = os.path.realpath(path)
    if not any(r and (real + os.sep).startswith(os.path.realpath(r) + os.sep) for r in roots):
        raise ValueError("path is outside the agent data directories")
    st = os.stat(real)
    records = []
    for line in tail_text(real, 256 * 1024).split("\n")[1 if st.st_size > 256 * 1024 else 0:]:
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except ValueError:
            pass
    return {"ok": True, "records": records, "mtimeMs": int(st.st_mtime * 1000)}

def find_bin(name):
    override = args().get("bin")  # tests point this at a fake CLI
    if override:
        return override
    path = os.pathsep.join([os.environ.get("PATH", "")] + EXTRA_PATH)
    return shutil.which(name, path=path)

def start(a):
    rid = run_id(a)
    name = a.get("binName")
    if name not in BINS:
        raise ValueError("unknown agent")
    argv = a.get("args")
    if not isinstance(argv, list) or not all(isinstance(x, str) for x in argv):
        raise ValueError("bad args")
    exe = find_bin(name)
    if not exe:
        return {"ok": False, "error": "リモートに %s が見つかりません" % name}
    cwd = os.path.expanduser(str(a.get("cwd") or "")) or HOME
    if not os.path.isdir(cwd):
        return {"ok": False, "error": "作業フォルダがありません: %s" % cwd}
    os.makedirs(runs_dir(), exist_ok=True)
    prune_logs()
    env = {k: v for k, v in os.environ.items() if not DROP_ENV.match(k)}
    env["PATH"] = os.pathsep.join([env.get("PATH", "")] + EXTRA_PATH)
    out = open(log_path(rid), "ab")
    proc = subprocess.Popen([exe] + argv, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
    proc.stdin.write(str(a.get("prompt") or "").encode("utf-8"))
    proc.stdin.close()
    return {"ok": True, "pid": proc.pid, "log": log_path(rid)}

def prune_logs(max_age=14 * 86400):
    """Drop run logs older than two weeks (the local side does the same)."""
    try:
        import time
        cutoff = time.time() - max_age
        for name in os.listdir(runs_dir()):
            p = os.path.join(runs_dir(), name)
            if name.endswith(".log") and os.path.getmtime(p) < cutoff:
                os.remove(p)
    except OSError:
        pass

def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # A finished child of an exited parent is reaped by init; a zombie still counts as gone.
    try:
        with open("/proc/%d/stat" % pid) as f:
            return f.read().split(")")[-1].split()[0] != "Z"
    except OSError:
        pass
    try:
        state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        return bool(state) and not state.startswith("Z")
    except OSError:
        return True

def command_of(pid):
    try:
        with open("/proc/%d/cmdline" % pid, "rb") as f:
            return f.read().replace(b"\0", b" ").decode("utf-8", "replace")
    except OSError:
        pass
    try:
        return subprocess.run(["ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True).stdout
    except OSError:
        return ""

def poll(a):
    out = {}
    for run in a.get("runs") or []:
        rid = run_id(run)
        pid = int(run.get("pid") or 0)
        out[rid] = {"alive": pid > 0 and alive(pid), "log": tail_text(log_path(rid))}
    return {"ok": True, "runs": out}

def stop(a):
    pid = int(a.get("pid") or 0)
    needle = str(a.get("needle") or "")
    if pid <= 0 or not needle or not alive(pid):
        return {"ok": True, "stopped": False}
    if needle not in command_of(pid):
        return {"ok": False, "error": "このプロセスは Canban が起動したものではありません"}
    os.killpg(pid, signal.SIGINT)
    return {"ok": True, "stopped": True}

# A durable reservation precedes thread/start. Only the official API writes Codex history.
class DesktopRpc:
    def __init__(self, binary):
        import selectors
        self.child = subprocess.Popen([binary, 'app-server', '--listen', 'stdio://'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.child.stdout, selectors.EVENT_READ)
        self.buffer, self.serial = b'', 0
        try:
            self.call('initialize', {'clientInfo': {'name': 'canban_desktop_prepare', 'version': '1.0.0'}})
            self.write({'method': 'initialized'})
        except BaseException:
            self.close()
            raise
    def write(self, value):
        self.child.stdin.write((json.dumps(value) + '\n').encode())
        self.child.stdin.flush()
    def call(self, method, params):
        import time
        self.serial += 1
        serial = self.serial
        self.write({'id': serial, 'method': method, 'params': params})
        until = time.monotonic() + 25
        while True:
            while b'\n' in self.buffer:
                line, self.buffer = self.buffer.split(b'\n', 1)
                message = json.loads(line)
                if message.get('id') != serial:
                    continue
                if 'error' in message:
                    raise RuntimeError('Codex App Server API failed')
                return message.get('result') or {}
            remaining = until - time.monotonic()
            if remaining <= 0 or not self.selector.select(remaining):
                raise TimeoutError('Codex App Server timeout')
            chunk = os.read(self.child.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError('Codex App Server disconnected')
            self.buffer += chunk
            if len(self.buffer) > 4 * 1024 * 1024:
                raise RuntimeError('Codex response too large')
    def close(self):
        self.selector.close()
        try:
            self.child.stdin.close()
        except OSError:
            pass
        try:
            self.child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.child.terminate()
            try:
                self.child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait()
        self.child.stdout.close()

def desktop_prepare_codex(a):
    import stat
    import uuid
    rid, cwd = a.get('clientRequestId'), a.get('cwd')
    if not isinstance(rid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', rid) or not isinstance(cwd, str) or not os.path.isabs(cwd) or '\0' in cwd or len(cwd) > 4096:
        return {'ok': True, 'state': 'failed', 'reason': '開始要求が不正です'}
    binary = shutil.which('codex', path=os.pathsep.join([os.environ.get('PATH', '')] + EXTRA_PATH))
    if not binary or not os.path.isdir(cwd):
        return {'ok': True, 'state': 'failed', 'reason': '接続先のCodex CLIと作業フォルダを確認してください'}
    root = os.path.join(HOME, '.canban-remote')
    folder = os.path.join(root, 'launches')
    for directory in (root, folder):
        os.makedirs(directory, mode=0o700, exist_ok=True)
        info = os.lstat(directory)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError('unsafe Desktop reservation directory')
    file = os.path.join(folder, rid + '.json')
    def save(value):
        temp = os.path.join(folder, '.' + str(uuid.uuid4()) + '.tmp')
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as handle:
            json.dump(value, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, file)
        parent = os.open(folder, os.O_RDONLY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    def check_thread(thread):
        return thread.get('id') == record.get('threadId') and os.path.realpath(thread.get('cwd') or '') == record['realCwd']
    def verify():
        reader = DesktopRpc(binary)
        try:
            return check_thread(reader.call('thread/read', {'threadId': record['threadId'], 'includeTurns': False}).get('thread') or {})
        finally:
            reader.close()
    record = {'state': 'preparing', 'cwd': cwd, 'realCwd': os.path.realpath(cwd)}
    try:
        fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        info = os.lstat(file)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_size > 16384:
            raise ValueError('unsafe Desktop reservation')
        try:
            with open(file) as handle:
                record = json.load(handle)
        except (OSError, ValueError):
            return {'ok': True, 'state': 'uncertain', 'cwd': cwd}
        if record.get('cwd') != cwd or record.get('realCwd') != os.path.realpath(cwd):
            return {'ok': True, 'state': 'failed', 'reason': '同じ要求IDの作業フォルダが変わりました'}
        if record.get('state') != 'prepared':
            return {'ok': True, 'state': 'uncertain', 'cwd': cwd, 'threadId': record.get('threadId')}
        try:
            valid = verify()
        except BaseException:
            valid = False
        return {'ok': True, **record, 'state': 'prepared' if valid else 'uncertain', 'writerClosed': True}
    with os.fdopen(fd, 'w') as handle:
        json.dump(record, handle)
        handle.flush()
        os.fsync(handle.fileno())
    save(record)  # fsync the new directory entry before the external intent
    try:
        writer = DesktopRpc(binary)
        try:
            thread = writer.call('thread/start', {'cwd': cwd, 'model': 'gpt-6.1-sol'})['thread']
            uuid.UUID(thread['id'])
            record.update(state='thread-created', threadId=thread['id'])
            save(record)
            if not check_thread(thread):
                raise ValueError('thread cwd mismatch')
            writer.call('thread/archive', {'threadId': thread['id']})
            writer.call('thread/unarchive', {'threadId': thread['id']})
        finally:
            writer.close()
        if not verify():
            raise ValueError('thread readback failed')
        record.update(state='prepared', writerClosed=True)
        save(record)
    except BaseException:
        record.update(state='uncertain')
        save(record)
    return {'ok': True, **record}

def main():
    a = args()
    mode = a.get("mode")
    handlers = {"inspect": inspect, "start": start, "poll": poll, "stop": stop, "prompt_images": prompt_images, "prompt_skills": prompt_skills, "desktop_prepare_codex": desktop_prepare_codex}
    if mode not in handlers:
        result = {"ok": False, "error": "unknown mode"}
    else:
        result = handlers[mode](a)
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))

try:
    main()
except Exception as e:  # noqa: BLE001
    sys.stdout.write(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))

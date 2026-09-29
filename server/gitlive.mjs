// Live git state of running sessions' folders: branch, ahead / behind and uncommitted
// changes, from `git --no-optional-locks status` (never takes the index lock or
// rewrites the index). Recomputed when the repo's HEAD / index change (the live hub
// watches their directory) or, at most every REFRESH_MS, when the session log grows
// (edits that are not staged yet do not touch the index).
import { execFile } from 'node:child_process';
import path from 'node:path';
import { stat } from './sources/readonly.mjs';

const REFRESH_MS = 10e3;
const TIMEOUT_MS = 3000;
const MAX_PROCS = 4;

let active = 0;
const queue = [];
async function withSlot(fn) {
  if (active >= MAX_PROCS) await new Promise((r) => queue.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

function git(cwd, args) {
  return withSlot(() => new Promise((resolve) => {
    execFile('git', ['--no-optional-locks', '-C', cwd, ...args], { timeout: TIMEOUT_MS, maxBuffer: 4 << 20, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } }, (err, out) => resolve(err ? null : out));
  }));
}

// `git status --porcelain=v2 --branch -z` → { branch, detached, ahead, behind, changed, untracked }
export function parseStatus(out) {
  const v = { branch: null, detached: false, ahead: 0, behind: 0, changed: 0, untracked: 0 };
  const parts = String(out).split('\0');
  for (let i = 0; i < parts.length; i++) {
    const l = parts[i];
    if (l.startsWith('# branch.head ')) {
      const b = l.slice(14);
      v.detached = b === '(detached)';
      v.branch = v.detached ? null : b;
    } else if (l.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(l);
      if (m) [v.ahead, v.behind] = [Number(m[1]), Number(m[2])];
    } else if (l.startsWith('1 ') || l.startsWith('u ')) v.changed++;
    else if (l.startsWith('2 ')) {
      v.changed++;
      i++; // a rename carries its original path as the next entry
    } else if (l.startsWith('? ')) v.untracked++;
  }
  return v;
}

const dirs = new Map(); // cwd -> Promise<{ top, gitDir } | null>
export function gitDirOf(cwd) {
  if (!cwd) return Promise.resolve(null);
  if (!dirs.has(cwd)) {
    dirs.set(cwd, git(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir']).then((out) => {
      const [top, gitDir] = String(out || '').split('\n');
      return top && gitDir ? { top, gitDir } : null;
    }));
  }
  return dirs.get(cwd);
}

const states = new Map(); // cwd -> { sig, at, value, gitDir }
const inflight = new Map();

async function signature(gitDir) {
  const [h, i] = await Promise.all([stat(path.join(gitDir, 'HEAD')), stat(path.join(gitDir, 'index'))]);
  return `${h?.mtimeMs ?? '-'}:${i?.mtimeMs ?? '-'}:${i?.size ?? '-'}`;
}

// Refresh the state of `cwd`; resolves with { value, changed }.
// `grew`: the session log grew, so unstaged edits may have changed the working tree.
export function refreshGit(cwd, { grew = false, now = Date.now() } = {}) {
  if (!cwd) return Promise.resolve({ value: null, changed: false });
  if (inflight.has(cwd)) return inflight.get(cwd);
  const p = (async () => {
    const d = await gitDirOf(cwd);
    if (!d) return { value: null, changed: false };
    const sig = await signature(d.gitDir);
    const hit = states.get(cwd);
    if (hit && hit.sig === sig && !(grew && now - hit.at >= REFRESH_MS)) return { value: hit.value, changed: false };
    const out = await git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal']);
    if (out == null) return { value: hit?.value ?? null, changed: false };
    const value = parseStatus(out);
    states.set(cwd, { sig, at: now, value, gitDir: d.gitDir });
    return { value, changed: !hit || JSON.stringify(hit.value) !== JSON.stringify(value) };
  })().finally(() => inflight.delete(cwd));
  inflight.set(cwd, p);
  return p;
}

// The last known state, without running anything (board builds stay fast).
export function peekGit(cwd) {
  return (cwd && states.get(cwd)?.value) || null;
}

export function resetGitForTest() {
  dirs.clear();
  states.clear();
}

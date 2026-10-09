// The uncommitted changes of a session's folder, for the review pane: files with their +/- counts and one
// file's patch. Read-only (`git --no-optional-locks`, no external diff, no pager) and local only.
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseNumstat } from './gitlive.mjs';

const TIMEOUT_MS = 5000;
const FILES_MAX = 200;
const PATCH_MAX = 160 * 1024;
const UNTRACKED_COUNT_MAX = 512 * 1024;

function run(cwd, args, { maxBuffer = 4 << 20, okCodes = [0] } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['--no-optional-locks', '-c', 'core.quotepath=false', '-C', cwd, ...args], {
      timeout: TIMEOUT_MS, maxBuffer, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_EXTERNAL_DIFF: '', GIT_PAGER: 'cat', LC_ALL: 'C' },
    }, (err, out) => resolve(!err || okCodes.includes(err.code) ? String(out ?? '') : null));
  });
}

// `git status --porcelain=v1 -z` → [{ path, status }]; status: modified | added | deleted | renamed | untracked | conflict
export function parsePorcelain(out) {
  const files = [];
  const parts = String(out || '').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const l = parts[i];
    if (l.length < 4) continue;
    const xy = l.slice(0, 2), file = l.slice(3);
    let status = 'modified';
    if (xy === '??') status = 'untracked';
    else if (/U|AA|DD/.test(xy)) status = 'conflict';
    else if (xy.includes('R') || xy.includes('C')) { status = 'renamed'; i++; }
    else if (xy.includes('A')) status = 'added';
    else if (xy.includes('D')) status = 'deleted';
    files.push({ path: file, status });
  }
  return files;
}

async function countLines(file) {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size > UNTRACKED_COUNT_MAX) return 0;
    const text = await fsp.readFile(file, 'utf8');
    if (text.includes('\0')) return 0;
    return text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
  } catch {
    return 0;
  }
}

export async function listChanges(cwd) {
  if (!cwd) return { available: false, reason: '作業フォルダが分かりません' };
  const top = (await run(cwd, ['rev-parse', '--show-toplevel']))?.trim();
  if (!top) return { available: false, reason: 'Git のフォルダではありません' };
  const [status, numstat] = await Promise.all([
    run(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
    run(cwd, ['diff', '--numstat', '-z', 'HEAD']),
  ]);
  if (status == null) return { available: false, reason: '変更を読み取れませんでした' };
  const counts = new Map(parseNumstat(numstat).files.map((f) => [f.path, f]));
  const files = [];
  for (const f of parsePorcelain(status).slice(0, FILES_MAX)) {
    const c = counts.get(f.path);
    const added = f.status === 'untracked' ? await countLines(path.join(top, f.path)) : c?.added ?? 0;
    files.push({ path: f.path, status: f.status, added, removed: c?.removed ?? 0 });
  }
  return { available: true, root: top, files, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0), truncated: parsePorcelain(status).length > FILES_MAX };
}

// One file's patch against HEAD. The path must lie inside the repository (no `..`, no absolute path).
export async function fileDiff(cwd, file) {
  const top = (await run(cwd, ['rev-parse', '--show-toplevel']))?.trim();
  if (!top) throw new Error('Git のフォルダではありません');
  const abs = path.resolve(top, String(file || ''));
  if (!file || path.isAbsolute(file) || abs !== top && !abs.startsWith(top + path.sep)) throw new Error('リポジトリ内のファイルを指定してください');
  const rel = path.relative(top, abs);
  const tracked = (await run(cwd, ['ls-files', '--error-unmatch', '--', rel])) != null;
  const args = tracked
    ? ['diff', '--no-ext-diff', '--no-color', '-U4', 'HEAD', '--', rel]
    : ['diff', '--no-ext-diff', '--no-color', '-U4', '--no-index', '--', '/dev/null', abs];
  const out = await run(top, args, { maxBuffer: 8 << 20, okCodes: [0, 1] });
  if (out == null) throw new Error('差分を読み取れませんでした');
  const truncated = out.length > PATCH_MAX;
  return { path: rel, patch: truncated ? out.slice(0, PATCH_MAX) : out, truncated };
}

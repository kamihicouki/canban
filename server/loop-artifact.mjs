// Read-only, bounded fingerprint of a local Git worktree. No code or hook is executed.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
const git = (cwd, args) => new Promise(resolve => execFile('git', ['--no-optional-locks', '-c', 'core.quotepath=false', '-C', cwd, ...args],
  { timeout: 3000, maxBuffer: 4 << 20, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_EXTERNAL_DIFF: '', GIT_PAGER: 'cat' } },
  (error, out) => resolve(error ? null : out)));
export async function loopArtifact(cwd) {
  if (!cwd) return null;
  const root = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) return null;
  cwd = root.trim();
  const [head, diff, untracked] = await Promise.all([git(cwd, ['rev-parse', 'HEAD']), git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD']), git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])]);
  if (!head || diff === null || untracked === null) return null;
  const hash = createHash('sha256').update(diff);
  const files = untracked.split('\0').filter(Boolean).sort();
  if (files.length > 100) return null;
  let bytes = 0;
  try {
    for (const file of files) {
      const abs = path.resolve(cwd, file);
      if (!abs.startsWith(path.resolve(cwd) + path.sep)) return null;
      const st = await fs.lstat(abs);
      if (!st.isFile() || (bytes += st.size) > (4 << 20)) return null;
      hash.update(file).update(await fs.readFile(abs));
    }
  } catch { return null; }
  return `git:${head.trim()}:${hash.digest('hex').slice(0, 20)}`;
}

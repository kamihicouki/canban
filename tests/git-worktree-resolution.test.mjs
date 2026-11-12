import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveRepoContext } from '../server/git.mjs';

test('resolveRepoContext: non-git directory', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canban-test-nongit-'));
  try {
    const res = await resolveRepoContext(tmpDir);
    assert.equal(res.isGit, false);
    assert.equal(res.isWorktree, false);
    assert.equal(res.repoRoot, tmpDir);
    assert.equal(res.repoName, path.basename(tmpDir));
    assert.equal(res.worktreeName, null);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('resolveRepoContext: standard git repo', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canban-test-repo-'));
  const gitDir = path.join(tmpDir, '.git');
  await fs.mkdir(gitDir);
  await fs.writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  try {
    const res = await resolveRepoContext(tmpDir);
    assert.equal(res.isGit, true);
    assert.equal(res.isWorktree, false);
    assert.equal(res.repoRoot, tmpDir);
    assert.equal(res.repoName, path.basename(tmpDir));
    assert.equal(res.worktreeName, null);
    assert.equal(res.branch, 'main');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('resolveRepoContext: git worktree', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canban-test-mainrepo-'));
  const mainGitDir = path.join(baseDir, '.git');
  const worktreesDir = path.join(mainGitDir, 'worktrees', 'feat-sample');
  await fs.mkdir(worktreesDir, { recursive: true });
  await fs.writeFile(path.join(worktreesDir, 'HEAD'), 'ref: refs/heads/feat-sample\n');

  const wtDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canban-test-wt-'));
  await fs.writeFile(path.join(wtDir, '.git'), `gitdir: ${worktreesDir}\n`);

  try {
    const res = await resolveRepoContext(wtDir);
    assert.equal(res.isGit, true);
    assert.equal(res.isWorktree, true);
    assert.equal(res.repoRoot, baseDir);
    assert.equal(res.repoName, path.basename(baseDir));
    assert.equal(res.worktreeName, 'feat-sample');
    assert.equal(res.branch, 'feat-sample');
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
    await fs.rm(wtDir, { recursive: true, force: true });
  }
});

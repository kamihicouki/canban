// Live git state: porcelain parsing, refresh on HEAD / index changes, read-only status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseStatus, refreshGit, peekGit, gitDirOf, resetGitForTest } from '../server/gitlive.mjs';

test('porcelain v2: branch, ahead / behind, changed (renames once), untracked, detached', () => {
  const out = ['# branch.oid abc', '# branch.head feat/x', '# branch.upstream origin/feat/x', '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 a a src/a.ts', '2 R. N... 100644 100644 100644 a a R100 src/new.ts', 'src/old.ts',
    'u UU N... 1 2 3 4 a b c src/conflict.ts', '? notes.md', ''].join('\0');
  assert.deepEqual(parseStatus(out), { branch: 'feat/x', detached: false, ahead: 2, behind: 1, changed: 3, untracked: 1 });
  assert.deepEqual(parseStatus('# branch.oid abc\0# branch.head (detached)\0'), { branch: null, detached: true, ahead: 0, behind: 0, changed: 0, untracked: 0 });
});

test('refreshGit follows commits and checkouts, and only re-runs when HEAD / index change or the log grew', async () => {
  resetGitForTest();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canban-git-')));
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' });
  try {
    g('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), '1');
    g('add', '.');
    g('commit', '-qm', 'first');
    const d = await gitDirOf(dir);
    assert.equal(d.gitDir, path.join(dir, '.git'));
    let r = await refreshGit(dir);
    assert.equal(r.changed, true);
    assert.deepEqual([r.value.branch, r.value.changed, r.value.untracked], ['main', 0, 0]);
    // An unstaged edit leaves HEAD / index alone: seen only when the log grew (and not too often).
    fs.writeFileSync(path.join(dir, 'a.txt'), '2');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'new');
    r = await refreshGit(dir);
    assert.equal(r.changed, false);
    const index = path.join(dir, '.git', 'index');
    const indexBefore = fs.statSync(index).mtimeMs;
    r = await refreshGit(dir, { grew: true, now: Date.now() + 60e3 });
    assert.deepEqual([r.changed, r.value.changed, r.value.untracked], [true, 1, 1]);
    assert.equal(fs.statSync(index).mtimeMs, indexBefore, 'status must not rewrite the index');
    // A checkout changes HEAD: picked up without the log growing.
    await new Promise((res) => setTimeout(res, 20));
    g('checkout', '-qb', 'feat/y');
    r = await refreshGit(dir);
    assert.equal(r.value.branch, 'feat/y');
    assert.equal(peekGit(dir).branch, 'feat/y');
    assert.equal(await gitDirOf(path.join(os.tmpdir())), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    resetGitForTest();
  }
});

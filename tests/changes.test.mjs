// The review pane's data: +/- counts, the changed files of a folder and one file's patch (read-only, inside the repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseNumstat, refreshGit, resetGitForTest } from '../server/gitlive.mjs';
import { parsePorcelain, listChanges, fileDiff } from '../server/changes.mjs';
import { lastSaidOf } from '../server/feed.mjs';

test('numstat: totals, binary files count 0, renames keep the new path', () => {
  const out = ['3\t1\tsrc/a.ts', '-\t-\timg/logo.png', '5\t0\t', 'old/name.ts', 'new/name.ts', ''].join('\0');
  assert.deepEqual(parseNumstat(out), { added: 8, removed: 1, files: [
    { path: 'src/a.ts', added: 3, removed: 1 }, { path: 'img/logo.png', added: 0, removed: 0 }, { path: 'new/name.ts', added: 5, removed: 0 }] });
  assert.deepEqual(parseNumstat(''), { added: 0, removed: 0, files: [] });
});

test('porcelain v1 reads status per file', () => {
  const out = [' M src/a.ts', 'A  src/new.ts', ' D gone.ts', 'R  new.ts', 'old.ts', '?? notes.md', 'UU conflict.ts', ''].join('\0');
  assert.deepEqual(parsePorcelain(out), [
    { path: 'src/a.ts', status: 'modified' }, { path: 'src/new.ts', status: 'added' }, { path: 'gone.ts', status: 'deleted' },
    { path: 'new.ts', status: 'renamed' }, { path: 'notes.md', status: 'untracked' }, { path: 'conflict.ts', status: 'conflict' }]);
});

test('the last reply of the agent is a short single line', () => {
  const items = [{ k: 'assistant', text: 'first' }, { k: 'tool', name: 'x' }, { k: 'assistant', text: 'line one\n\n  line   two' }, { k: 'turn' }];
  assert.equal(lastSaidOf(items), 'line one line two');
  assert.equal(lastSaidOf([{ k: 'user', text: 'hi' }]), null);
  assert.equal(lastSaidOf([{ k: 'assistant', text: '## 結果\n- **追加**: [PR](https://x.test/1) と `a.ts`\n```js\nconst x = 1\n```\n以上' }]), '結果 追加: PR と a.ts 以上');
});

test('changes of a folder: counts per file, untracked lines, one patch, and no path outside the repository', async () => {
  resetGitForTest();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canban-changes-')));
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' });
  try {
    g('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    g('add', '.'); g('commit', '-qm', 'first');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'x\ny\n');
    const live = await refreshGit(dir);
    assert.deepEqual([live.value.added, live.value.removed], [2, 1]); // tracked changes only: +2 (TWO, four) −1 (two)
    const c = await listChanges(dir);
    assert.equal(c.available, true);
    assert.deepEqual(c.files.map((f) => [f.path, f.status, f.added, f.removed]), [['a.txt', 'modified', 2, 1], ['b.txt', 'untracked', 2, 0]]);
    assert.deepEqual([c.added, c.removed], [4, 1]);
    const d = await fileDiff(dir, 'a.txt');
    assert.match(d.patch, /^-two$/m);
    assert.match(d.patch, /^\+TWO$/m);
    const u = await fileDiff(dir, 'b.txt');
    assert.match(u.patch, /^\+x$/m);
    await assert.rejects(fileDiff(dir, '../outside.txt'), /リポジトリ内/);
    await assert.rejects(fileDiff(dir, '/etc/passwd'), /リポジトリ内/);
    assert.equal((await listChanges(os.tmpdir())).available, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

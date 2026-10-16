import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Terminals, projectRoot } from '../server/terminal.mjs';

async function readUntil(terms, id, since, match) {
  let out = '', offset = since;
  for (let i = 0; i < 40 && !match.test(out); i++) {
    const r = await terms.read({ id, since: offset, timeoutMs: 500 });
    out += r.data;
    offset = r.offset;
    if (r.exited) return { out, offset, exited: true };
  }
  return { out, offset, exited: false };
}

test('the card terminal runs a shell on a pty in the folder and keeps it per card', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canban-term-')));
  const terms = new Terminals({ shell: '/bin/sh' });
  try {
    const t = terms.open({ key: 'card-1', cwd: dir, cols: 100, rows: 30 });
    assert.equal(t.cwd, dir);
    assert.equal(terms.open({ key: 'card-1', cwd: dir }).id, t.id, 'the same card reuses its running shell');
    terms.write({ id: t.id, data: 'pwd; [ -t 0 ] && echo TTY-OK; stty size\n' });
    const r = await readUntil(terms, t.id, t.start, /30 100/);
    assert.match(r.out, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(r.out, /TTY-OK/);
    terms.resize({ id: t.id, cols: 90, rows: 20 });
    terms.write({ id: t.id, data: 'stty size\n' });
    assert.match((await readUntil(terms, t.id, r.offset, /20 90/)).out, /20 90/);
    terms.write({ id: t.id, data: 'exit 3\n' });
    const end = await readUntil(terms, t.id, r.offset, /(?!)/);
    assert.equal(end.exited, true);
    assert.notEqual(terms.open({ key: 'card-1', cwd: dir }).id, t.id, 'a finished shell is replaced');
  } finally {
    terms.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the project root is the git top level, else the folder itself', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canban-root-')));
  try {
    fs.mkdirSync(path.join(dir, 'repo', 'sub'), { recursive: true });
    execFileSync('git', ['init', '-q', path.join(dir, 'repo')]);
    assert.equal(await projectRoot(path.join(dir, 'repo', 'sub')), path.join(dir, 'repo'));
    assert.equal(await projectRoot(dir), dir);
    assert.equal(await projectRoot(path.join(dir, 'missing')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

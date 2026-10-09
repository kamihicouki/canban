// Claude transcripts only grow: a known one is read from where the last read stopped, and the summaries
// survive a restart in Canban's data directory.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonLinesFrom } from '../server/sources/readonly.mjs';
import { listClaudeSessions } from '../server/sources/claude.mjs';
import { attachSummaryCache } from '../server/summary-cache.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-summary-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const line = (o) => `${JSON.stringify(o)}\n`;
const user = (text, at) => line({ type: 'user', timestamp: at, cwd: '/w', message: { role: 'user', content: text } });
const assistant = (text, at) => line({ type: 'assistant', timestamp: at, message: { model: 'm', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } } });

test('lines come with the offset past their newline; an unfinished last line waits, a finished one counts', async () => {
  const f = path.join(root, 'lines.jsonl');
  fs.writeFileSync(f, `${line({ a: 1 })}not json\n\n${line({ b: 2 })}{"c":`);
  const got = [];
  for await (const x of readJsonLinesFrom(f)) got.push(x);
  assert.deepEqual(got.map((x) => x.value), [{ a: 1 }, { b: 2 }]);
  assert.equal(got.at(-1).end, fs.statSync(f).size - '{"c":'.length);
  const rest = [];
  fs.appendFileSync(f, '3}\n');
  for await (const x of readJsonLinesFrom(f, got.at(-1).end)) rest.push(x.value);
  assert.deepEqual(rest, [{ c: 3 }]);
  const g = path.join(root, 'no-newline.jsonl');
  fs.writeFileSync(g, `${line({ a: 1 })}{"z":9}`);
  const all = [];
  for await (const x of readJsonLinesFrom(g)) all.push(x);
  assert.deepEqual(all.map((x) => x.value), [{ a: 1 }, { z: 9 }]);
  assert.equal(all.at(-1).end, fs.statSync(g).size);
});

test('a grown transcript is folded from where it stopped and matches a full read; a replaced one starts over', async () => {
  const home = path.join(root, 'claude'), dir = path.join(home, 'projects', '-w');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 's1.jsonl');
  fs.writeFileSync(f, user('最初の依頼', '2026-10-01T00:00:00Z') + assistant('はい', '2026-10-01T00:01:00Z'));
  const first = (await listClaudeSessions({ home, desktopDir: path.join(root, 'none') })).sessions[0];
  assert.equal(first.title, '最初の依頼');
  fs.appendFileSync(f, user('次の依頼', '2026-10-02T00:00:00Z') + assistant('どうぞ', '2026-10-02T00:01:00Z'));
  const grown = (await listClaudeSessions({ home, desktopDir: path.join(root, 'none') })).sessions[0];
  assert.equal(grown.updatedAt, Date.parse('2026-10-02T00:01:00Z'));
  // A transcript written again from scratch (smaller, another inode) is read from the start.
  fs.rmSync(f);
  fs.writeFileSync(f, user('書き直した依頼', '2026-10-03T00:00:00Z'));
  const replaced = (await listClaudeSessions({ home, desktopDir: path.join(root, 'none') })).sessions[0];
  assert.equal(replaced.title, '書き直した依頼');
  assert.equal(replaced.updatedAt, Date.parse('2026-10-03T00:00:00Z'));
});

test('the summaries are kept in the data directory after a listing that read something new', async () => {
  const dataDir = path.join(root, 'data');
  const detach = attachSummaryCache(dataDir);
  try {
    const home = path.join(root, 'claude2'), dir = path.join(home, 'projects', '-w');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 's2.jsonl');
    fs.writeFileSync(f, user('保存される依頼', '2026-10-04T00:00:00Z'));
    await listClaudeSessions({ home, desktopDir: path.join(root, 'none') });
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'cache', 'claude-summaries.json'), 'utf8'));
    assert.equal(saved.version, 1);
    assert.equal(saved.entries[f].offset, fs.statSync(f).size);
    assert.equal(saved.entries[f].summary.prompts[0], '保存される依頼');
  } finally { detach(); }
});

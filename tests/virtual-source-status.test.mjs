// A session whose source path is `<real file>#<id>` (an Antigravity conversation known
// only from its summaries DB) has no log to read. Reading it must not fail the board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLines, readFeed, readFeedDelta } from '../server/feed.mjs';
import { localStatus, annotateStatus } from '../server/status.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-virtual-source-'));
  const db = path.join(dir, 'conversation_summaries.db');
  fs.writeFileSync(db, 'not a log');
  return { dir, db, sourcePath: `${db}#0bac8205-d0e4-4c67-9ce3-7dcb14a369e4` };
}
const session = (sourcePath, extra = {}) => ({ id: 'antigravity:a1', agent: 'antigravity', sourcePath, updatedAt: Date.now(), ...extra });

test('readLines returns no records for a `<file>#<id>` source that is not a file', async () => {
  const { dir, sourcePath } = fixture();
  try {
    assert.deepEqual(await readLines(sourcePath), { records: [], offset: 0, size: 0, reset: false, fromStart: false });
    assert.deepEqual(await readLines(sourcePath, { start: 0 }), { records: [], offset: 0, size: 0, reset: false, fromStart: false });
    const feed = await readFeed(session(sourcePath));
    assert.deepEqual(feed.items, []);
    assert.equal(feed.offset, 0);
    assert.deepEqual((await readFeedDelta(session(sourcePath), 0)).items, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readLines still reads a real log whose name contains `#`', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-virtual-source-'));
  try {
    const file = path.join(dir, 'issue#12.jsonl');
    fs.writeFileSync(file, '{"a":1}\n{"a":2}\n');
    assert.deepEqual((await readLines(file)).records, [{ a: 1 }, { a: 2 }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a recent Antigravity session without a transcript gets a status instead of failing every session', async () => {
  const { dir, sourcePath } = fixture();
  try {
    assert.equal(await localStatus(session(sourcePath)), 'idle');
    // The status is cached per source path, so the running conversation is another one.
    const running = session(sourcePath.replace(/#.*/, '#11111111-2222-4333-8444-555555555555'), { sourceMetadata: { isRunning: true } });
    assert.equal(await localStatus(running), 'running');
    const log = path.join(dir, 'claude.jsonl');
    fs.writeFileSync(log, `${JSON.stringify({ type: 'user', message: { role: 'user', content: '依頼' } })}\n`);
    const sessions = [session(sourcePath), { id: 'claude:c1', agent: 'claude', sourcePath: log, updatedAt: Date.now() }];
    await annotateStatus(sessions);
    assert.equal(sessions[0].status, 'idle');
    assert.equal(typeof sessions[1].status, 'string');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

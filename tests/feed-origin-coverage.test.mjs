import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { readLines, readFeed, readFeedDelta, FEED_TAIL_BYTES } from '../server/feed.mjs';
const line = value => `${JSON.stringify(value)}\n`;
const user = text => ({ type: 'event_msg', payload: { type: 'user_message', message: text } });
async function withLog(body, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-feed-origin-'));
  const sourcePath = path.join(dir, 'session.jsonl');
  fs.writeFileSync(sourcePath, body);
  try { await run({ agent: 'codex', sourcePath }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('fromStart reports the beginning and retained feed items, independently of text clipping', async () => {
  await withLog(line(user('x'.repeat(5000))), async session => {
    assert.equal((await readLines(session.sourcePath)).fromStart, true);
    const feed = await readFeed(session);
    assert.equal(feed.fromStart, true);
    assert.equal(feed.items[0].text.length, 4000);
  });
  await withLog(Array.from({ length: 121 }, (_, i) => line(user(String(i)))).join(''), async session => {
    assert.equal((await readFeed(session)).fromStart, false);
    assert.equal((await readFeed(session, { limit: 121 })).fromStart, true);
  });
});

test('tail reads, malformed lines and incomplete records cannot claim origin coverage', async () => {
  for (const body of [line(user('first')) + line({ type: 'padding', value: 'x'.repeat(FEED_TAIL_BYTES) }), '{malformed}\n' + line(user('later')), line(user('first')) + JSON.stringify(user('incomplete'))]) {
    await withLog(body, async session => {
      assert.equal((await readLines(session.sourcePath)).fromStart, false);
      assert.equal((await readFeed(session)).fromStart, false);
    });
  }
});

test('delta pointers remain byte offsets and reset derives coverage from the replacement head', async () => {
  await withLog(line(user('first')), async session => {
    const first = await readFeed(session);
    fs.appendFileSync(session.sourcePath, line(user('second')));
    const delta = await readFeedDelta(session, first.offset);
    assert.equal(delta.offset, fs.statSync(session.sourcePath).size);
    assert.deepEqual(delta.items.map(item => item.text), ['second']);
    assert.equal(Object.hasOwn(delta, 'fromStart'), false);
    fs.writeFileSync(session.sourcePath, line(user('new')));
    const reset = await readFeedDelta(session, delta.offset);
    assert.equal(reset.reset, true);
    assert.equal(reset.fromStart, true);
    assert.equal(reset.offset, fs.statSync(session.sourcePath).size);
  });
});

test('compressed rollouts cannot claim head coverage even when their tail contains the entire file', { skip: !zlib.zstdCompressSync }, async () => {
  await withLog(line(user('first')), async session => {
    const compressed = `${session.sourcePath}.zst`;
    fs.writeFileSync(compressed, zlib.zstdCompressSync(fs.readFileSync(session.sourcePath)));
    fs.unlinkSync(session.sourcePath);
    assert.equal((await readLines(session.sourcePath)).fromStart, false);
    const feed = await readFeed(session);
    assert.equal(feed.items[0].text, 'first');
    assert.equal(feed.fromStart, false);
  });
});

test('a reverted Codex log that keeps an earlier prefix does not cover the beginning', async () => {
  const meta = base => line({ type: 'session_meta', payload: { id: 'a', history_mode: 'paginated', history_base: base } });
  await withLog(meta({ thread_id: 'a', end_ordinal_exclusive: 5, end_byte_offset: 900 }) + line(user('後')), async session => {
    assert.equal((await readLines(session.sourcePath)).fromStart, false);
    const feed = await readFeed(session);
    assert.equal(feed.fromStart, false);
    assert.equal(feed.items[0].text, '後', 'the messages themselves are still shown');
  });
  await withLog(meta(null) + line(user('先頭')), async session => {
    assert.equal((await readFeed(session)).fromStart, true);
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrySqliteBusy } from '../server/sqlite-retry.mjs';
import { channel } from 'node:diagnostics_channel';

test('retry diagnostics identify a late timer without permitting another attempt', async () => {
  const events = [], trace = channel('canban.sqlite.fixture.retry');
  const observe = event => events.push(event);
  trace.subscribe(observe);
  let clock = 0, attempts = 0;
  try {
    await assert.rejects(retrySqliteBusy(() => {
      attempts++; clock += 250; throw new Error('database is locked');
    }, { now: () => clock, sleep: async () => { clock = 2638; } }), { code: 'db_busy', busyElapsedMs: 2638 });
  } finally { trace.unsubscribe(observe); }
  assert.equal(attempts, 1);
  assert.deepEqual(events.map(event => event.phase), ['start', 'attempt', 'busy', 'sleep', 'wake', 'exhausted']);
  assert.equal(events.at(-1).remainingMs, -638);
  assert.equal(events.at(-1).attempts, 1);
  assert.equal(events.find(event => event.phase === 'wake').waitMs, 2388);
});

test('retry diagnostics keep success values and original non-contention errors', async () => {
  const events = [], trace = channel('canban.sqlite.fixture.retry');
  const observe = event => events.push(event);
  const value = {}, error = new Error('private fixture-only error');
  trace.subscribe(observe);
  try {
    assert.equal(await retrySqliteBusy(() => value), value);
    await assert.rejects(retrySqliteBusy(() => { throw error; }), actual => actual === error);
  } finally { trace.unsubscribe(observe); }
  assert.ok(events.some(event => event.phase === 'success'));
  assert.ok(events.some(event => event.phase === 'error'));
  assert.ok(!JSON.stringify(events).includes(error.message));
});

test('an unobserved retry keeps the original clock checks and budget', async () => {
  let clock = 0, reads = 0, attempts = 0;
  await assert.rejects(retrySqliteBusy(() => {
    attempts++; clock += 250; throw new Error('database is locked');
  }, { now: () => { reads++; return clock; }, sleep: async () => { clock = 1900; } }), { code: 'db_busy', busyElapsedMs: 1900 });
  assert.equal(attempts, 1); assert.equal(reads, 5);
});

test('a delayed retry timer cannot start another DB attempt without time for its busy timeout', async () => {
  let clock = 0, attempts = 0;
  await assert.rejects(retrySqliteBusy(() => {
    attempts++; clock += 250; throw new Error('database is locked');
  }, { now: () => clock, sleep: async () => { clock = 1900; } }), { code: 'db_busy' });
  assert.equal(attempts, 1);
});

test('a short busy wait retries successfully within the operation budget', async () => {
  let clock = 0, attempts = 0;
  const value = await retrySqliteBusy(() => {
    if (++attempts === 1) { clock += 250; throw new Error('database is busy'); }
    return 'saved';
  }, { now: () => clock, sleep: async ms => { clock += ms; } });
  assert.equal(value, 'saved'); assert.equal(attempts, 2);
});

test('non-contention failures are never retried', async () => {
  const error = new Error('disk failure');
  await assert.rejects(retrySqliteBusy(() => { throw error; }, {
    sleep: async () => { assert.fail('must not delay'); },
  }), actual => actual === error);
});

test('native busy waits with scheduling overhead cannot consume a partial final attempt', async () => {
  let clock = 0, attempts = 0;
  await assert.rejects(retrySqliteBusy(() => {
    attempts++; clock += 500; throw new Error('database is locked');
  }, { now: () => clock, sleep: async () => { clock = 1700; } }), { code: 'db_busy' });
  assert.equal(attempts, 1);
});

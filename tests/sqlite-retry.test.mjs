import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrySqliteBusy } from '../server/sqlite-retry.mjs';

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

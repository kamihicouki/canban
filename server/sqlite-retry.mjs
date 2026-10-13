import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { channel } from 'node:diagnostics_channel';

const diagnostics = channel('canban.sqlite.fixture.retry');

const busy = error => /database (?:is )?(?:locked|busy)/i.test(error.message);
const exhausted = busyElapsedMs => Object.assign(new Error('別の画面が更新中です。少し待って再操作してください。'), { code: 'db_busy', busyElapsedMs });
// SQLite's 250ms timeout can take longer under OS scheduling pressure. Reserve
// another 250ms so the retry loop does not spend the last partial attempt.
const attemptBudgetMs = 500;

export async function retrySqliteBusy(fn, { now = () => performance.now(), sleep = delay } = {}) {
  const start = now(), deadline = start + 2000;
  let attempts = 0;
  const record = (phase, extra = {}) => {
    if (!diagnostics.hasSubscribers) return;
    const elapsedMs = now() - start;
    diagnostics.publish({ phase, attempts, elapsedMs, remainingMs: 2000 - elapsedMs, ...extra });
  };
  const stop = () => {
    const error = exhausted(now() - start);
    record('exhausted'); return error;
  };
  record('start');
  for (;;) {
    // Check again after an arbitrarily late timer wakeup.
    if (now() + attemptBudgetMs >= deadline) throw stop();
    attempts++; record('attempt');
    try { const value = await fn(); record('success'); return value; } catch (error) {
      if (!busy(error)) { record('error'); throw error; }
      record('busy');
      if (now() + attemptBudgetMs >= deadline) throw stop();
      const requestedMs = 15 + Math.floor(Math.random() * 25);
      const waitStart = diagnostics.hasSubscribers ? now() : 0;
      record('sleep', { requestedMs });
      await sleep(requestedMs);
      if (diagnostics.hasSubscribers) record('wake', { requestedMs, waitMs: now() - waitStart });
    }
  }
}

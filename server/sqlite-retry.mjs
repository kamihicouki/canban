import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

const busy = error => /database (?:is )?(?:locked|busy)/i.test(error.message);
const exhausted = busyElapsedMs => Object.assign(new Error('別の画面が更新中です。少し待って再操作してください。'), { code: 'db_busy', busyElapsedMs });
// SQLite's 250ms timeout can take longer under OS scheduling pressure. Reserve
// another 250ms so the retry loop does not spend the last partial attempt.
const attemptBudgetMs = 500;

export async function retrySqliteBusy(fn, { now = () => performance.now(), sleep = delay } = {}) {
  const start = now(), deadline = start + 2000;
  for (;;) {
    // Check again after an arbitrarily late timer wakeup.
    if (now() + attemptBudgetMs >= deadline) throw exhausted(now() - start);
    try { return await fn(); } catch (error) {
      if (!busy(error)) throw error;
      if (now() + attemptBudgetMs >= deadline) throw exhausted(now() - start);
      await sleep(15 + Math.floor(Math.random() * 25));
    }
  }
}

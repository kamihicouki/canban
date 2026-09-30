import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

const busy = error => /database (?:is )?(?:locked|busy)/i.test(error.message);
const exhausted = busyElapsedMs => Object.assign(new Error('別の画面が更新中です。少し待って再操作してください。'), { code: 'db_busy', busyElapsedMs });

export async function retrySqliteBusy(fn, { now = () => performance.now(), sleep = delay } = {}) {
  const start = now(), deadline = start + 2000;
  for (;;) {
    // busy_timeout is 250ms. Check again after an arbitrarily late timer wakeup.
    if (now() + 250 >= deadline) throw exhausted(now() - start);
    try { return await fn(); } catch (error) {
      if (!busy(error)) throw error;
      if (now() + 250 >= deadline) throw exhausted(now() - start);
      await sleep(15 + Math.floor(Math.random() * 25));
    }
  }
}

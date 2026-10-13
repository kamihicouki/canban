import { channel } from 'node:diagnostics_channel';
import { DatabaseSync } from 'node:sqlite';
import { isMainThread, threadId } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';

const prefix = 'CANBAN_SQLITE_DIAGNOSTIC ';
const phases = new Set(['start', 'attempt', 'busy', 'sleep', 'wake', 'success', 'error', 'exhausted']);
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

// Fixture-only observer: no SQL, arguments, errors, paths, or environment values.
// Keep 64 events for each of the three slowest operations; write only at close.
export function createFixtureRecorder(client, write = text => process.stderr.write(text)) {
  let current, operationCount = 0, flushed = false;
  const operations = [];
  const append = event => {
    if (!current) return;
    if (current.events.length < 64) current.events.push(event); else current.droppedEvents++;
  };
  return {
    retry(event) {
      try {
        if (!phases.has(event.phase)) return;
        if (event.phase === 'start') current = { operation: operationCount + 1, events: [], droppedEvents: 0 };
        if (!current) return;
        const safe = { phase: event.phase, attempts: number(event.attempts), elapsedMs: number(event.elapsedMs), remainingMs: number(event.remainingMs) };
        for (const key of ['requestedMs', 'waitMs']) if (key in event) safe[key] = number(event[key]);
        append(safe);
        if (['success', 'error', 'exhausted'].includes(event.phase)) {
          Object.assign(current, { outcome: event.phase, attempts: safe.attempts, elapsedMs: safe.elapsedMs, remainingMs: safe.remainingMs });
          operationCount++;
          operations.push(current); operations.sort((a, b) => b.elapsedMs - a.elapsedMs); operations.length = Math.min(operations.length, 3);
          current = null;
        }
      } catch { /* Diagnostics must not replace the operation's result. */ }
    },
    native(kind, wallMs, cpuMs, outcome) {
      append({ phase: 'native', kind: ['begin', 'commit', 'rollback'].includes(kind) ? kind : 'other',
        wallMs: number(wallMs), cpuMs: number(cpuMs), outcome: ['success', 'busy'].includes(outcome) ? outcome : 'error' });
    },
    flush() {
      if (flushed) return;
      flushed = true;
      try { write(prefix + JSON.stringify({ client, threadId, operationCount, operations }) + '\n'); } catch {}
    },
  };
}

const client = Number(process.env.CANBAN_SQLITE_DIAGNOSTIC_CLIENT);
if (!isMainThread && Number.isInteger(client) && client >= 0 && client < 10) {
  const recorder = createFixtureRecorder(client);
  let measuring = false;
  channel('canban.sqlite.fixture.operation').subscribe(event => {
    if (event.phase === 'begin' && event.kind === 'close') recorder.flush();
    measuring = event.phase === 'begin' && event.kind === 'write';
  });
  channel('canban.sqlite.fixture.retry').subscribe(event => { if (measuring) recorder.retry(event); });
  const original = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    if (!measuring) return original.call(this, sql);
    const start = performance.now();
    const cpuStart = process.threadCpuUsage?.();
    let outcome = 'success';
    try { return original.call(this, sql); }
    catch (error) { outcome = /database (?:is )?(?:locked|busy)/i.test(error.message) ? 'busy' : 'error'; throw error; }
    finally {
      const wallMs = performance.now() - start;
      const cpu = cpuStart && process.threadCpuUsage(cpuStart);
      const kind = sql === 'BEGIN IMMEDIATE' ? 'begin' : sql === 'COMMIT' ? 'commit' : sql === 'ROLLBACK' ? 'rollback' : 'other';
      recorder.native(kind, wallMs, cpu ? (cpu.user + cpu.system) / 1000 : null, outcome);
    }
  };
  process.stderr.on('error', () => {});
}

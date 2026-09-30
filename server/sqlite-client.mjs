// One asynchronous database worker per data directory and MCP process.
import { Worker, isMainThread } from 'node:worker_threads';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
export { isMainThread };
export const executionContext = new AsyncLocalStorage();
const clients = new Map();
export function database(dir) {
  const key = path.resolve(dir);
  if (clients.has(key)) return clients.get(key);
  const worker = new Worker(new URL('./sqlite-worker.mjs', import.meta.url), { workerData: { dir: key }, execArgv: ['--no-warnings'] });
  const pending = new Map();
  let next = 0, failure;
  const rejectAll = (error) => { failure = error; for (const p of pending.values()) p.reject(error); pending.clear(); worker.unref(); };
  worker.on('error', rejectAll);
  worker.on('exit', (code) => { rejectAll(new Error(`Canban DB worker stopped (${code})`)); clients.delete(key); });
  worker.on('message', ({ id, value, error }) => {
    const p = pending.get(id); if (!p) return;
    pending.delete(id);
    if (error) p.reject(Object.assign(new Error(error.message), { code: error.code, busyElapsedMs: error.busyElapsedMs })); else p.resolve(value);
    if (!pending.size) worker.unref();
  });
  worker.unref();
  const client = {
    call(target, method, args = []) {
      if (failure) return Promise.reject(failure);
      worker.ref();
      return new Promise((resolve, reject) => {
        const id = ++next; pending.set(id, { resolve, reject });
        try { worker.postMessage({ id, target, method, args, fence: executionContext.getStore() }); }
        catch (error) { pending.delete(id); if (!pending.size) worker.unref(); reject(error); }
      });
    },
    async close() { try { await client.call('system','close'); } finally { await worker.terminate(); clients.delete(key); } },
  };
  clients.set(key, client);
  return client;
}
export function proxyStore(target, name) {
  const client = database(target.dir);
  return new Proxy(target, { get(object, key) {
    if (key === 'then') return undefined;
    if (key === 'close') return () => client.close();
    if (key === 'database') return client;
    const value = object[key];
    if (typeof value !== 'function' || key === 'logPath') return typeof value === 'function' ? value.bind(object) : value;
    if (key === 'mutate') return () => Promise.reject(new Error('Use a named store mutation; callbacks stay inside the DB worker'));
    return (...args) => client.call(name, key, args);
  } });
}

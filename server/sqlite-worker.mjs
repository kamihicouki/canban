import crypto from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { retrySqliteBusy as retry } from './sqlite-retry.mjs';
import { openDatabase, db, revision, leaseAcquire, transaction, bump, setFence, currentFence, writeBoard } from './sqlite-backend.mjs';
import { Store, defaultState } from './store.mjs';
import { RequestStore } from './requests.mjs';
await retry(() => openDatabase(workerData.dir));
const board = new Store(workerData.dir), requests = new RequestStore(workerData.dir);
if (!db().prepare("SELECT 1 FROM metadata WHERE key='initialized'").get()) {
  await retry(() => transaction(() => { if (!db().prepare("SELECT 1 FROM metadata WHERE key='initialized'").get()) { writeBoard(defaultState()); db().prepare("INSERT INTO metadata VALUES('initialized','1')").run(); } }));
}
const instance=crypto.randomUUID();
await retry(() => transaction(() => db().prepare('INSERT INTO instances VALUES(?,?)').run(instance,process.pid)));
const system = {
  close:() => transaction(() => db().prepare('DELETE FROM instances WHERE owner=?').run(instance)),
  revision: (kind) => revision(kind),
  acquire: (args) => leaseAcquire(args),
  lease: (key) => db().prepare('SELECT * FROM leases WHERE key=?').get(key) || null,
  release: ({ key,owner,generation }) => transaction(() => db().prepare('DELETE FROM leases WHERE key=? AND owner=? AND generation=?').run(key,owner,generation)),
  presenceRead: (cutoff = Date.now()-90000) => transaction(() => {
    const removed = db().prepare('DELETE FROM presence WHERE at < ?').run(cutoff);
    if (removed.changes) bump('presence');
    return db().prepare('SELECT owner,payload FROM presence WHERE at >= ?').all(cutoff).map((r) => [r.owner,JSON.parse(r.payload)]);
  }),
  presencePut: (owner,value) => transaction(() => { db().prepare('INSERT INTO presence VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET payload=excluded.payload,at=excluded.at').run(owner,JSON.stringify(value),value.at); bump('presence'); }),
  presenceDelete: (owner) => transaction(() => { db().prepare('DELETE FROM presence WHERE owner=?').run(owner); bump('presence'); }),
  auxiliaryRead: (key) => { const row = db().prepare('SELECT payload FROM auxiliary WHERE key=?').get(key); return row ? JSON.parse(row.payload) : null; },
  auxiliaryPut: (key,value) => transaction(() => { db().prepare('INSERT INTO auxiliary VALUES(?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload').run(key,JSON.stringify(value)); }, { fence: currentFence }),
};
let queue = Promise.resolve();
parentPort.on('message', (message) => {
  queue = queue.then(async () => {
    const { id,target,method,args,fence } = message;
    try {
      setFence(fence || null);
      const object = { board, requests, system }[target];
      if (!object || typeof object[method] !== 'function' || ['constructor','mutate'].includes(method)) throw new Error('Unknown database operation');
      const value = await retry(() => object[method](...args));
      parentPort.postMessage({ id,value });
    } catch (error) { parentPort.postMessage({ id,error: { message: error.message,code: error.code } }); }
    finally { setFence(null); }
  });
});

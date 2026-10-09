import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
export const SCHEMA_VERSION = 1;
let connection;
let inTransaction = false;
export function openDatabase(dir, { migration = false } = {}) {
  const file = path.join(dir, 'canban.sqlite');
  if (!migration && !fs.existsSync(file) && ['board.json', 'requests.json'].some((name) => fs.existsSync(path.join(dir, name)))) {
    throw Object.assign(new Error('SQLiteへの移行が必要です。Canbanサーバーを停止し、npm run migrate:sqlite -- --apply を実行してください。'), { code: 'migration_required' });
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  try {
  fs.chmodSync(file, 0o600);
  db.exec('PRAGMA busy_timeout=250; PRAGMA foreign_keys=ON;');
  if (Number(db.prepare('PRAGMA user_version').get().user_version) > SCHEMA_VERSION) { db.close(); throw new Error('このCanbanより新しいDBです。アプリを更新してください。'); }
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO metadata VALUES ('change','0'), ('board_change','0'), ('requests_change','0'), ('presence_change','0');
    CREATE TABLE IF NOT EXISTS board_records (kind TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,id));
    CREATE TABLE IF NOT EXISTS ui_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, payload TEXT);
    CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, card_id TEXT NOT NULL, state TEXT NOT NULL, queue_order REAL NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS requests_queue ON requests(state,queue_order);
    CREATE INDEX IF NOT EXISTS requests_session ON requests(session_key,state);
    CREATE INDEX IF NOT EXISTS requests_card ON requests(card_id,state);
    CREATE UNIQUE INDEX IF NOT EXISTS requests_active ON requests(session_key) WHERE state IN ('starting','running');
    CREATE TABLE IF NOT EXISTS queue_pauses (card_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS presence (owner TEXT PRIMARY KEY, payload TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS leases (key TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, generation INTEGER NOT NULL, heartbeat INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lease_generations (key TEXT PRIMARY KEY, generation INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS instances (owner TEXT PRIMARY KEY, pid INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auxiliary (key TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS loop_state (task_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS loop_rounds (task_id TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(task_id,id));
    CREATE TABLE IF NOT EXISTS loop_dispatch (round_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, payload TEXT NOT NULL);
    PRAGMA user_version=1;
    COMMIT;`);
  if (!migration && ['board.json','requests.json'].some((name) => fs.existsSync(path.join(dir,name))) && !db.prepare("SELECT 1 FROM metadata WHERE key='initialized'").get()) { db.close(); throw new Error('SQLiteへの移行が未完了です。移行コマンドを実行してください。'); }
  connection = db;
  return db;
  } catch(error) { try { db.close(); } catch {} throw error; }
}
export function db() { if (!connection) throw new Error('Database is not open'); return connection; }
export function revision(kind = 'change') { return Number(db().prepare('SELECT value FROM metadata WHERE key=?').get(kind)?.value || 0); }
export function bump(kind) {
  for (const key of new Set(['change', `${kind}_change`])) db().prepare("INSERT INTO metadata VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1").run(key);
}
export function transaction(fn, { fence } = {}) {
  db().exec('BEGIN IMMEDIATE');
  inTransaction = true;
  try {
    if (fence) {
      const lease = db().prepare('SELECT owner,generation FROM leases WHERE key=?').get(fence.key);
      if (!lease || lease.owner !== fence.owner || lease.generation !== fence.generation) throw Object.assign(new Error('バックグラウンド処理の実行権が更新されました'), { code: 'stale_owner' });
    }
    const result = fn(); db().exec('COMMIT'); return result;
  } catch (error) { db().exec('ROLLBACK'); throw error; } finally { inTransaction = false; }
}
export function readTransaction(fn) {
  if (inTransaction) return fn();
  db().exec('BEGIN'); inTransaction=true; try { const result=fn(); db().exec('COMMIT'); return result; } catch(error) { db().exec('ROLLBACK'); throw error; } finally { inTransaction=false; }
}
export function readBoard() {
  return readTransaction(() => {
    const out = { lists: [], labels: [], directories: [], cards: {}, remoteHosts: {} };
    for (const row of db().prepare('SELECT * FROM board_records ORDER BY kind,position').all()) {
      const value = JSON.parse(row.payload);
      if (['lists','labels','directories'].includes(row.kind)) out[row.kind].push(value);
      else if (['cards','remoteHosts'].includes(row.kind)) out[row.kind][row.id] = value;
      else out[row.id] = value;
    }
    const ui = db().prepare('SELECT * FROM ui_state WHERE id=1').get();
    out.uiState = ui ? { revision: ui.revision, state: ui.payload ? JSON.parse(ui.payload) : null } : { revision: 0, state: null };
    return out;
  });
}
export function writeBoard(state) {
  const old = new Map(db().prepare('SELECT * FROM board_records').all().map((r) => [`${r.kind}\0${r.id}`, r]));
  const upsert = db().prepare('INSERT INTO board_records VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET position=excluded.position,payload=excluded.payload');
  const put = (kind, id, position, value) => {
    const key = `${kind}\0${id}`, payload = JSON.stringify(value), previous = old.get(key); old.delete(key);
    if (!previous || previous.position !== position || previous.payload !== payload) upsert.run(kind,id,position,payload);
  };
  for (const [key,value] of Object.entries(state)) {
    if (key === 'uiState') continue;
    if (['lists','labels','directories'].includes(key)) value.forEach((item,i) => put(key,item.id,i,item));
    else if (['cards','remoteHosts'].includes(key)) Object.entries(value).forEach(([id,item]) => put(key,id,0,item));
    else put('settings',key,0,value);
  }
  for (const row of old.values()) db().prepare('DELETE FROM board_records WHERE kind=? AND id=?').run(row.kind,row.id);
  const ui = state.uiState || { revision: 0, state: null };
  db().prepare('INSERT INTO ui_state VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload').run(ui.revision,ui.state ? JSON.stringify(ui.state) : null);
  bump('board');
}
export function sessionKey(request) { return JSON.stringify([request.hostId || 'local', request.agent || String(request.cardId).split(':')[0], request.nativeId || request.cardId]); }
export function readRequests() {
  return readTransaction(() => ({ requests: db().prepare('SELECT payload FROM requests ORDER BY queue_order,id').all().map((row) => JSON.parse(row.payload)), paused: Object.fromEntries(db().prepare('SELECT * FROM queue_pauses').all().map((row) => [row.card_id,JSON.parse(row.payload)])) }));
}
export function writeRequests(state) {
  const previous = new Map(db().prepare('SELECT id,payload FROM requests').all().map((r) => [r.id,r.payload]));
  const put = db().prepare('INSERT INTO requests VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET session_key=excluded.session_key,card_id=excluded.card_id,state=excluded.state,queue_order=excluded.queue_order,payload=excluded.payload');
  for (const request of state.requests) {
    const payload = JSON.stringify(request);
    if (previous.get(request.id) !== payload) put.run(request.id,sessionKey(request),request.cardId,request.state,request.order || request.createdAt,payload);
    previous.delete(request.id);
  }
  for (const id of previous.keys()) db().prepare('DELETE FROM requests WHERE id=?').run(id);
  db().exec('DELETE FROM queue_pauses');
  for (const [id, value] of Object.entries(state.paused)) db().prepare('INSERT INTO queue_pauses VALUES(?,?)').run(id,JSON.stringify(value));
  bump('requests');
}
export function alive(pid) { try { process.kill(pid,0); return true; } catch (error) { return error.code === 'EPERM'; } }
export function leaseAcquire({ key, owner, pid, now = Date.now(), payload = {} }) {
  return transaction(() => {
    const row = db().prepare('SELECT * FROM leases WHERE key=?').get(key);
    // Expiry alone never proves that an old owner's child is no longer writing.
    if (row && row.owner !== owner && (alive(row.pid) || JSON.parse(row.payload).uncertain)) return null;
    const generation = row && row.owner === owner ? row.generation : nextGeneration(key);
    db().prepare('INSERT INTO leases VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,pid=excluded.pid,generation=excluded.generation,heartbeat=excluded.heartbeat,payload=excluded.payload').run(key,owner,pid,generation,now,JSON.stringify(payload));
    return { key,owner,generation };
  });
}
// Persist the generation even after release, so an old token is never valid again.
export function nextGeneration(key) {
  const row = db().prepare('INSERT INTO lease_generations VALUES (?,1) ON CONFLICT(key) DO UPDATE SET generation=generation+1 RETURNING generation').get(key);
  return row.generation;
}
export let currentFence = null;
export function setFence(value) { currentFence = value; }

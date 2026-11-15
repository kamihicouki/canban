// A record written under a Desktop lock must finish before the lock is released.
// `try { return save(x); } finally { await lock.release(); }` does not wait for save: the
// write runs outside the lock, and a failed write is an unhandled rejection, which stops
// the server (it has no unhandledRejection handler).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDesktopAccountSetup } from '../server/desktop-account-setup.mjs';
import { createDesktopLaunches } from '../server/desktop-launch.mjs';

const exists = (p) => fs.lstat(p).then(() => true, () => false);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function roots(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canban-lock-await-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data'), appDir = path.join(root, 'Claude');
  await fs.mkdir(dataDir); await fs.mkdir(appDir);
  return { dataDir, appDir };
}

// Slows the rename that publishes `name`, so a lock released too early is seen as gone.
function watchPublish(t, name, lockPath) {
  const seen = [], rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (path.basename(to) !== name) return rename(from, to);
    await sleep(40);
    seen.push(await exists(lockPath));
    return rename(from, to);
  });
  return seen;
}

function setupService({ dataDir, appDir }) {
  return createDesktopAccountSetup({ dataDir, appDir, accounts: {}, runtime: async () => ({ running: false }), open: async () => {}, builds: async () => ({ claude: 'test' }), platform: 'darwin' });
}
const setupState = (dataDir) => path.join(dataDir, 'desktop-accounts', 'claude');

test('setup writes its state while it still holds the lock', async (t) => {
  const r = await roots(t), seen = watchPublish(t, 'setup.json', path.join(setupState(r.dataDir), 'setup.lock'));
  const result = await setupService(r).command({ type: 'cancel-wait' });
  assert.equal(result.state, 'cancelled');
  assert.deepEqual(seen, [true]);
  assert.equal(await exists(path.join(setupState(r.dataDir), 'setup.lock')), false);
  assert.equal(await exists(path.join(setupState(r.dataDir), 'setup.json')), true);
});

test('a failed setup write reaches the caller and frees the lock', async (t) => {
  const r = await roots(t), lock = path.join(setupState(r.dataDir), 'setup.lock');
  // The write fails while the release is still going on: the moment nobody awaits the
  // write unless it is awaited inside the try. node:test fails on the unhandled rejection.
  const rename = fs.rename, rmdir = fs.rmdir;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (path.basename(to) === 'setup.json') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return rename(from, to);
  });
  t.mock.method(fs, 'rmdir', async (dir) => { if (path.basename(dir) === 'setup.lock') await sleep(40); return rmdir(dir); });
  await assert.rejects(setupService(r).command({ type: 'cancel-wait' }), { code: 'ENOSPC' });
  assert.equal(await exists(lock), false);
});

function launchService({ dataDir }) {
  return createDesktopLaunches({ dataDir, resolveTarget: async () => { throw new Error('no target'); }, open: async () => ({}) });
}

test('a launch writes its final result while it still holds the lease', async (t) => {
  const r = await roots(t), id = 'lock-await-1', dir = path.join(r.dataDir, 'desktop-launches');
  const seen = watchPublish(t, `${id}.json`, path.join(dir, `${id}.lock`));
  const result = await launchService(r).start({ agent: 'codex', clientRequestId: id });
  assert.equal(result.state, 'failed');
  assert.ok(seen.length >= 2, 'the first record and the final result are both written');
  assert.equal(seen.every(Boolean), true, `written outside the lease: ${seen}`);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), 'utf8')).result.state, 'failed');
  assert.equal(await exists(path.join(dir, `${id}.lock`)), false);
});

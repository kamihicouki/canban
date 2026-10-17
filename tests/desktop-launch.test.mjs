import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDesktopLaunches } from '../server/desktop-launch.mjs';

const input = { agent: 'claude', clientRequestId: 'request-1', account: 'claude:a', hostId: 'local', cwd: '/work', prompt: '保持する', imageIds: ['image-a'] };
async function fixture(t, adapters = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canban-desktop-launch-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, resolveTarget: async x => ({ account: x.account, hostId: x.hostId, cwd: x.cwd }), open: async () => ({ url: 'claude://code/new' }), ...adapters };
}

test('selection evidence is recorded before Desktop effects and retained across retries and status', async t => {
  const events = [], evidence = { selection: { requestId: input.clientRequestId }, receipt: { status: 'unresolved', appliedRefs: [] } };
  const opts = await fixture(t, {
    recordSelection: async () => { events.push('record'); return evidence; },
    prepareThread: async () => { events.push('prepare'); return { state: 'prepared' }; },
    open: async () => { events.push('open'); return { url: 'claude://code/new' }; },
  });
  const launches = createDesktopLaunches(opts);
  const first = await launches.start(input);
  assert.deepEqual(events, ['record', 'prepare', 'open']);
  assert.deepEqual(first.receipt, evidence.receipt);
  assert.deepEqual((await launches.start(input)), first);
  assert.deepEqual(events, ['record', 'prepare', 'open']);
  assert.deepEqual((await createDesktopLaunches(opts).status(input.clientRequestId)).receipt, evidence.receipt);
});

test('waiting is resumable with the same request ID and private immutable input', async t => {
  let ready = false, opens = 0;
  const opts = await fixture(t, { accounts: { withAccount: async (a, permissions, action) => ready ? action() : { state: 'waiting-for-quit', reason: '終了待ち' } }, open: async () => { opens++; return { url: 'claude://code/new' }; } });
  const launches = createDesktopLaunches(opts);
  assert.equal((await launches.start(input)).state, 'waiting-for-quit');
  await assert.rejects(launches.start({ ...input, prompt: '別の本文' }), /変更|一致/);
  ready = true;
  assert.equal((await launches.start(input)).state, 'opened');
  assert.equal((await launches.start(input)).state, 'opened');
  assert.equal(opens, 1);
  assert.deepEqual((await launches.status(input.clientRequestId)).imageIds, input.imageIds);
  const file = path.join(opts.dataDir, 'desktop-launches', 'request-1.json');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.doesNotMatch(await fs.readFile(file, 'utf8'), /uiToken/);
});

test('two independent MCP service instances open once', async t => {
  let opens = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  const opts = await fixture(t, { open: async () => { opens++; await held; return {}; } });
  const a = createDesktopLaunches(opts), b = createDesktopLaunches(opts);
  const first = a.start(input);
  while (!opens) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await b.start(input)).state, 'opening');
  release(); assert.equal((await first).state, 'opened');
  assert.equal(opens, 1);
});

test('unknown open and unknown thread preparation never retry', async t => {
  for (const stage of ['open', 'prepareThread']) {
    let calls = 0;
    const opts = await fixture(t, { [stage]: async () => { calls++; throw new Error('応答切断'); } });
    const a = createDesktopLaunches(opts);
    assert.equal((await a.start(input)).state, 'uncertain');
    assert.equal((await createDesktopLaunches(opts).start(input)).state, 'uncertain');
    assert.equal(calls, 1);
  }
});

test('cancel requires UI authority and never touches CLI or a waiting draft', async t => {
  let opens = 0;
  const a = createDesktopLaunches(await fixture(t, { accounts: { withAccount: async () => ({ state: 'waiting-for-login' }) }, open: async () => { opens++; } }));
  await a.start(input);
  await assert.rejects(a.cancel(input.clientRequestId), /UI/);
  assert.equal((await a.cancel(input.clientRequestId, { uiAuthorized: true })).state, 'cancelled');
  assert.equal((await a.start(input)).state, 'cancelled');
  assert.equal(opens, 0);
});

test('model booleans cannot grant quit or swap; explicit UI grants persist for recovery', async t => {
  let switches = 0;
  const a = createDesktopLaunches(await fixture(t, { accounts: { withAccount: async (account, opts, action) => {
    if (!opts.allowSwitch || !opts.allowQuit) return { state: 'waiting-for-quit' };
    switches++; return action();
  } } }));
  const request = { ...input, allowDesktopSwitch: true, allowQuit: true, uiToken: 'not-authority' };
  assert.equal((await a.start(request)).state, 'waiting-for-quit'); assert.equal(switches, 0);
  assert.equal((await a.start(request, { uiAuthorized: true })).state, 'opened'); assert.equal(switches, 1);
});

test('target changes and invalid input fail before opening', async t => {
  let host = 'original', opens = 0;
  const a = createDesktopLaunches(await fixture(t, { resolveTarget: async () => ({ hostId: host }), accounts: { withAccount: async () => ({ state: 'waiting-for-quit' }) }, open: async () => { opens++; } }));
  await a.start(input); host = 'other';
  assert.equal((await a.start(input)).state, 'failed');
  await assert.rejects(a.start({ ...input, clientRequestId: '../bad' }));
  assert.equal(opens, 0);
});

test('separate Node processes share the open reservation', async t => {
  const { spawn } = await import('node:child_process');
  const opts = await fixture(t), marker = path.join(opts.dataDir, 'opens');
  const moduleUrl = new URL('../server/desktop-launch.mjs', import.meta.url).href;
  const source = `import fs from 'node:fs/promises'; import {createDesktopLaunches} from ${JSON.stringify(moduleUrl)};
    const a=createDesktopLaunches({dataDir:process.argv[1], resolveTarget:async()=>({hostId:'local'}),open:async()=>{await fs.appendFile(process.argv[2],'open\\n'); await new Promise(r=>setTimeout(r,100)); return {};}});
    await a.start(${JSON.stringify(input)});`;
  const child = () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', source, opts.dataDir, marker], { stdio: ['ignore','ignore','pipe'] });
    let error = ''; p.stderr.on('data', x => { error += x; });
    p.on('error', reject); p.on('exit', code => code ? reject(new Error(error)) : resolve());
  });
  await Promise.all([child(), child()]);
  assert.equal(await fs.readFile(marker,'utf8'), 'open\n');
});

test('cancellation during the last target check prevents the subsequent open', async t => {
  let resolves=0, release, entered, opens=0;
  const blocked=new Promise(r=>{entered=r;});
  const gate=new Promise(r=>{release=r;});
  const a=createDesktopLaunches(await fixture(t,{resolveTarget:async()=>{if(++resolves===2){entered();await gate;}return {hostId:'local'};},open:async()=>{opens++;return {};}}));
  const pending=a.start(input);await blocked;
  assert.equal((await a.cancel(input.clientRequestId,{uiAuthorized:true})).state,'cancelled');
  release();assert.equal((await pending).state,'cancelled');assert.equal(opens,0);
});

test('cancellation during thread preparation records its outcome and suppresses open', async t => {
  for (const uncertain of [false, true]) {
    let release, entered, opens = 0, prepares = 0;
    const blocked = new Promise(r => { entered = r; });
    const gate = new Promise(r => { release = r; });
    const opts = await fixture(t, {
      prepareThread: async () => { prepares++; entered(); await gate; if (uncertain) throw Error('response lost'); return { threadId: 'prepared-thread' }; },
      open: async () => { opens++; return {}; },
    });
    const launches = createDesktopLaunches(opts), pending = launches.start(input);
    await blocked;
    const cancelled = await launches.cancel(input.clientRequestId, { uiAuthorized: true });
    release();
    assert.equal(cancelled.state, 'cancelled');
    assert.equal((await pending).state, 'cancelled');
    assert.equal((await createDesktopLaunches(opts).start(input)).state, 'cancelled');
    assert.equal(opens, 0); assert.equal(prepares, 1);
    const record = JSON.parse(await fs.readFile(path.join(opts.dataDir, 'desktop-launches', 'request-1.json')));
    assert.equal(uncertain ? record.thread.state : record.thread.threadId, uncertain ? 'uncertain' : 'prepared-thread');
  }
});

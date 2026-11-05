// stopChild: tests remove a server's data folder only after the process has really gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { stopChild } from './helpers.mjs';

function start(t, script, ...args) {
  const child = spawn(process.execPath, ['-e', script, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => child.kill('SIGKILL'));
  return new Promise((resolve, reject) => {
    child.stdout.once('data', () => resolve(child));
    child.once('error', reject);
  });
}

test('waits for a child that keeps writing during its asynchronous shutdown', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-stop-child-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const late = path.join(dir, 'late');
  const child = await start(t, `
    process.once('SIGTERM', () => setTimeout(() => { require('fs').writeFileSync(process.argv[1], 'x'); process.exit(0); }, 200));
    setInterval(() => {}, 1000);
    console.log('ready');
  `, late);
  await stopChild(child);
  assert.equal(child.exitCode, 0);
  assert.equal(fs.existsSync(late), true);
});

test('kills a child that ignores SIGTERM', async (t) => {
  const child = await start(t, `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready');`);
  await stopChild(child, { graceMs: 100 });
  assert.equal(child.signalCode, 'SIGKILL');
});

test('returns at once for a child that has already exited', async (t) => {
  const child = await start(t, `console.log('ready');`);
  await new Promise((resolve) => child.once('exit', resolve));
  await stopChild(child);
  assert.equal(child.exitCode, 0);
});

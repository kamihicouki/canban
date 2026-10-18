import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as launcher from '../server/launcher.mjs';

test('concurrent and later launch retries do not repeat the OS action', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-launch-once-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let calls = 0, release;
  const payload = { agent: 'codex', prompt: '確認する', route: 'desktop' };
  const first = launcher.launchOnce(dir, 'request-one', payload, async () => {
    calls++; await new Promise(resolve => { release = resolve; });
    return { route: 'desktop', url: 'codex://threads/new', note: 'アプリで送信してください' };
  });
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  const during = await launcher.launchOnce(dir, 'request-one', payload, () => { calls++; });
  assert.equal(during.state, 'uncertain');
  release(); const result = await first;
  assert.equal(result.state, 'opened');
  assert.deepEqual(await launcher.launchOnce(dir, 'request-one', payload, () => { calls++; }), result);
  assert.equal(calls, 1);
  await assert.rejects(launcher.launchOnce(dir, 'request-one', { ...payload, prompt: '別の依頼' }, () => { calls++; }), /入力/);
  assert.equal(calls, 1);
});

test('an ambiguous OS failure is retained across retries without opening again', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-launch-unknown-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const first = await launcher.launchOnce(dir, 'unknown', { agent: 'claude' }, () => { calls++; throw new Error('応答が切断されました'); });
  assert.equal(first.state, 'uncertain');
  assert.match(first.note, /確認/);
  assert.deepEqual(await launcher.launchOnce(dir, 'unknown', { agent: 'claude' }, () => { calls++; }), first);
  assert.equal(calls, 1);
});

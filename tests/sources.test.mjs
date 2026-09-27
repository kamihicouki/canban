// Source readers: normalization on fixtures, and the read-only guarantee.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { listCodexSessions, codexSessionMessages } from '../server/sources/codex.mjs';
import { listClaudeSessions, claudeSessionMessages } from '../server/sources/claude.mjs';
import { queryReadOnly } from '../server/sources/readonly.mjs';

import { makeFixtures } from './helpers.mjs';

const fx = makeFixtures();
const { codexHome, claudeHome, desktopDir } = fx;
const before = fx.snapshot();
fx.lock(); // any write attempt now fails at the OS level
after(() => fx.cleanup());

test('codex sessions are normalized from the state DB', async () => {
  const { sessions, error } = await listCodexSessions({ home: codexHome });
  assert.equal(error, null);
  const t1 = sessions.find((s) => s.nativeId === 't1');
  assert.equal(t1.id, 'codex:t1');
  assert.equal(t1.title, 'ログイン修正');
  assert.equal(t1.project, 'demo-app');
  assert.equal(t1.branch, 'fix/login');
  assert.equal(t1.updatedAt, 1790000100123);
  assert.equal(t1.subagent, false);
  assert.equal(sessions.find((s) => s.nativeId === 't2').subagent, true);
  const t3 = sessions.find((s) => s.nativeId === 't3');
  assert.equal(t3.archived, true);
  assert.equal(t3.updatedAt, 1790000000000);
});

test('codex messages skip commentary', async () => {
  const msgs = await codexSessionMessages(path.join(codexHome, 'sessions', 'rollout-a.jsonl'));
  assert.deepEqual(msgs.map((m) => [m.role, m.text]), [['user', 'ログインを直して'], ['assistant', '直しました']]);
});

test('claude sessions merge transcript and desktop metadata', async () => {
  const { sessions, error } = await listClaudeSessions({ home: claudeHome, desktopDir });
  assert.equal(error, null);
  assert.equal(sessions.length, 2);
  const c = sessions.find((x) => x.nativeId === 'c1');
  assert.equal(c.id, 'claude:c1');
  assert.equal(c.title, 'トップページ高速化');
  assert.equal(c.project, 'web');
  assert.equal(c.archived, true);
  assert.equal(c.updatedAt, 1790500000000);
  assert.equal(c.prUrl, 'https://github.com/o/r/pull/1');
  const msgs = await claudeSessionMessages(c.sourcePath);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant']);
});

test('read-only DB connection rejects writes', () => {
  assert.throws(() => queryReadOnly(path.join(codexHome, 'state_5.sqlite'), (db) => db.exec("UPDATE threads SET title='x'")));
});

test('fixtures are byte-for-byte unchanged after reading', () => {
  assert.deepEqual(fx.snapshot(), before);
});

// Real data: readers must not call any fs write API while scanning the user's sessions.
test('readers issue no writes against real session data', async () => {
  const calls = [];
  const spy = (obj, name) => {
    const orig = obj[name];
    obj[name] = function (...a) {
      calls.push(`${name}(${String(a[0])})`);
      return orig.apply(this, a);
    };
    return () => (obj[name] = orig);
  };
  const restores = [
    ...['writeFile', 'appendFile', 'rename', 'unlink', 'rm', 'truncate', 'mkdir', 'copyFile'].map((n) => spy(fsp, n)),
    ...['writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'truncateSync', 'mkdirSync', 'copyFileSync', 'createWriteStream'].map((n) => spy(fs, n)),
  ];
  const origOpen = fsp.open;
  fsp.open = function (p, flags = 'r', ...rest) {
    if (flags !== 'r') calls.push(`open(${p}, ${flags})`);
    return origOpen.call(this, p, flags, ...rest);
  };
  try {
    const codex = await listCodexSessions();
    const claude = await listClaudeSessions();
    const s1 = codex.sessions.find((s) => s.sourcePath);
    if (s1) await codexSessionMessages(s1.sourcePath);
    const s2 = claude.sessions[0];
    if (s2) await claudeSessionMessages(s2.sourcePath);
  } finally {
    restores.forEach((r) => r());
    fsp.open = origOpen;
  }
  assert.deepEqual(calls, []);
});

test('Claude sessions without desktop metadata are not claimed to be unarchived', async () => {
  const { normalizeClaudeSummary, newSummary } = await import('../server/sources/claude.mjs');
  const sum = { ...newSummary('x'), prompts: ['hi'], turns: 1, entrypoint: 'cli' };
  const s = normalizeClaudeSummary(sum, undefined);
  assert.deepEqual([s.desktopKnown, s.archived, s.entrypoint], [false, false, 'cli']);
  assert.equal(normalizeClaudeSummary(sum, { isArchived: true }).desktopKnown, true);
});

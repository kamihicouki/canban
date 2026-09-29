// Presence: live boards leave heartbeats in presence.json and see each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Presence, appLabel } from '../server/presence.mjs';

test('boards see each other, heartbeats are throttled, stale and closed boards drop out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-presence-'));
  try {
    const codex = new Presence(dir, { self: '1', app: () => 'Codex', beatMs: 1000, ttlMs: 5000 });
    const claude = new Presence(dir, { self: '2', app: () => 'Claude デスクトップ', beatMs: 1000, ttlMs: 5000 });
    assert.equal(codex.beat(null, 100), true);
    assert.equal(codex.beat(null, 200), false); // nothing new, not due
    assert.equal(claude.beat('claude:c2', 300), true);
    assert.deepEqual(codex.others(400), [{ app: 'Claude デスクトップ', cardId: 'claude:c2' }]);
    assert.deepEqual(claude.others(400), [{ app: 'Codex', cardId: null }]);
    assert.equal(codex.beat('codex:t1', 500), true); // opening a card is written at once
    assert.deepEqual(claude.others(600), [{ app: 'Codex', cardId: 'codex:t1' }]);
    assert.deepEqual(claude.others(5600), []); // codex stopped beating
    claude.leave();
    assert.deepEqual(codex.others(700), []);
    fs.writeFileSync(path.join(dir, 'presence.json'), '{broken');
    assert.deepEqual(codex.others(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('app labels from clientInfo', () => {
  assert.equal(appLabel({ name: 'codex-desktop' }), 'Codex');
  assert.equal(appLabel({ name: 'claude-ai' }), 'Claude デスクトップ');
  assert.equal(appLabel({ name: 'dev-host' }), 'dev-host');
  assert.equal(appLabel(null), 'ボード');
});

// Presence: live boards leave heartbeats in presence.json and see each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Presence, appLabel } from '../server/presence.mjs';

test('boards see each other, heartbeats are throttled, stale and closed boards drop out', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-presence-'));
  try {
    const codex = new Presence(dir, { self: '1', app: () => 'Codex', beatMs: 1000, ttlMs: 5000 });
    const claude = new Presence(dir, { self: '2', app: () => 'Claude デスクトップ', beatMs: 1000, ttlMs: 5000 });
    assert.equal((await codex.beat(null, 100)), true);
    assert.equal((await codex.beat(null, 200)), false); // nothing new, not due
    assert.equal((await claude.beat('claude:c2', 300)), true);
    assert.deepEqual((await codex.others(400)), [{ app: 'Claude デスクトップ', cardId: 'claude:c2' }]);
    assert.deepEqual((await claude.others(400)), [{ app: 'Codex', cardId: null }]);
    assert.equal((await codex.beat('codex:t1', 500)), true); // opening a card is written at once
    assert.deepEqual((await claude.others(600)), [{ app: 'Codex', cardId: 'codex:t1' }]);
    assert.deepEqual((await claude.others(5600)), []); // codex stopped beating
    (await claude.leave());
    assert.deepEqual((await codex.others(700)), []);
    fs.writeFileSync(path.join(dir, 'presence.json'), '{broken');
    assert.deepEqual((await codex.others()), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a board with several cards open shows one row per card, and older entries still read', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-presence-'));
  try {
    const codex = new Presence(dir, { self: '1', app: () => 'Codex', beatMs: 1000, ttlMs: 5000 });
    const claude = new Presence(dir, { self: '2', app: () => 'Claude デスクトップ', beatMs: 1000, ttlMs: 5000 });
    assert.equal((await claude.beat(['claude:c1', 'claude:c2'], 100)), true);
    assert.equal((await claude.beat(['claude:c1', 'claude:c2'], 200)), false);
    assert.equal((await claude.beat(['claude:c2'], 300)), true); // closing a pane is written at once
    assert.deepEqual((await codex.others(400)), [{ app: 'Claude デスクトップ', cardId: 'claude:c2' }]);
    assert.equal((await claude.beat(['claude:c1', 'claude:c2'], 500)), true);
    assert.deepEqual((await codex.others(600)), [{ app: 'Claude デスクトップ', cardId: 'claude:c1' }, { app: 'Claude デスクトップ', cardId: 'claude:c2' }]);
    // an entry written by an older board has no cardIds
    await codex.database.call('system','presencePut',['9',{app:'Codex',cardId:'codex:t1',at:1000}]);
    assert.deepEqual((await claude.others(1100)), [{ app: 'Codex', cardId: 'codex:t1' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('app labels from clientInfo', async () => {
  assert.equal(appLabel({ name: 'codex-desktop' }), 'Codex');
  assert.equal(appLabel({ name: 'claude-ai' }), 'Claude デスクトップ');
  assert.equal(appLabel({ name: 'canban-chrome' }), 'Chrome');
  assert.equal(appLabel({ name: 'dev-host' }), 'dev-host');
  assert.equal(appLabel(null), 'ボード');
});

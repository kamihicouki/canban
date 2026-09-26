import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { matchPending, linkedToTask } from '../server/board.mjs';
import { newSessionLink, newSessionCommand, desktopLink } from '../server/agents.mjs';
import { LOCAL_HOST } from '../server/sources/util.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'canban-tasks-'));
const remote = { id: 'remote-ssh-discovered:box', alias: 'box', label: 'box', local: false, sshPort: 2222 };

test('task cards: create, link (moving between tasks), unlink, delete', async () => {
  const store = new Store(tmp());
  const a = await store.createTask({ title: 'ログイン改善', listId: 'doing' });
  const b = await store.createTask({ title: '別タスク' });
  assert.equal(store.load().cards[a.cardId].listId, 'doing');
  assert.equal(store.load().cards[b.cardId].listId, 'inbox');
  await store.linkSession({ taskId: a.cardId, sessionId: 'codex:t1' });
  await store.linkSession({ taskId: b.cardId, sessionId: 'codex:t1' });
  const s = store.load();
  assert.deepEqual(s.cards[a.cardId].links, []);
  assert.deepEqual(s.cards[b.cardId].links, ['codex:t1']);
  assert.equal(linkedToTask(s).get('codex:t1'), b.cardId);
  await assert.rejects(store.linkSession({ taskId: b.cardId, sessionId: a.cardId }), /タスク同士/);
  await store.unlinkSession({ taskId: b.cardId, sessionId: 'codex:t1' });
  await store.deleteTask({ cardId: a.cardId });
  assert.equal(store.load().cards[a.cardId], undefined);
  await assert.rejects(store.createTask({ title: ' ' }), /カード名/);
});

test('pending launches are matched by agent, host, time and folder or prompt', async () => {
  const store = new Store(tmp());
  const t = await store.createTask({ title: 'x' });
  const startedAt = 1_800_000_000_000;
  await store.addPending({ taskId: t.cardId, pending: { agent: 'codex', hostId: 'local', cwd: '/w/app', prompt: 'ログイン画面の不具合を直して', startedAt } });
  const S = (id, o) => ({ id, agent: 'codex', host: LOCAL_HOST, cwd: '/w/app', preview: '', createdAt: startedAt + 5000, ...o });
  const sessions = [
    S('codex:old', { createdAt: startedAt - 60e3 }), // started before the launch
    S('codex:claude', { agent: 'claude' }), // wrong agent
    S('codex:remote', { host: remote }), // wrong host
    S('codex:other', { cwd: '/w/other', preview: '無関係' }), // neither folder nor prompt
    S('codex:hit2', { createdAt: startedAt + 9000 }),
    S('codex:hit', { cwd: '/w/else', preview: 'ログイン画面の不具合を直して。詳細は…' }),
  ];
  const res = matchPending(store.load(), sessions);
  assert.deepEqual(res.map((r) => r.sessionId), ['codex:hit']); // earliest matching
  await store.resolvePending(res);
  const c = store.load().cards[t.cardId];
  assert.deepEqual(c.links, ['codex:hit']);
  assert.deepEqual(c.pending, []);
});

test('new-session links and commands', () => {
  assert.equal(newSessionLink('codex', { host: LOCAL_HOST, cwd: '/w/app', prompt: '直して' }).url, 'codex://threads/new?prompt=%E7%9B%B4%E3%81%97%E3%81%A6&path=%2Fw%2Fapp');
  assert.equal(newSessionLink('codex', { host: remote, cwd: '/srv', prompt: 'x' }).url, 'codex://threads/new?prompt=x&path=%2Fsrv&hostId=remote-ssh-discovered%3Abox');
  assert.equal(newSessionLink('claude', { host: LOCAL_HOST, cwd: '/w/app', prompt: 'x' }).url, 'claude://code/new?q=x&folder=%2Fw%2Fapp');
  assert.equal(newSessionLink('claude', { host: remote, cwd: '/srv', prompt: 'x' }).url, 'claude://code/new?q=x&ssh_host=box&ssh_port=2222&ssh_folder=%2Fsrv');
  assert.equal(newSessionCommand('claude', { host: LOCAL_HOST, cwd: '/w/app', prompt: "it's" }), `cd /w/app 2>/dev/null; claude 'it'\\''s'`);
  assert.equal(newSessionCommand('codex', { host: remote, cwd: '/srv', prompt: 'x' }), `ssh -t box 'cd /srv 2>/dev/null; codex x'`);
});

test('CLI-only Claude sessions open via claude://resume', () => {
  const uuid = '98036725-506c-4918-9b7f-5a61924654db';
  const l = desktopLink({ agent: 'claude', nativeId: uuid, cwd: '/w', host: LOCAL_HOST, desktopSessionId: null });
  assert.equal(l.url, `claude://resume?session=${uuid}`);
  assert.equal(l.exact, true);
});

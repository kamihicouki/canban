// Claude Desktop's fork / side-session links between sessions, resolved to cards.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopOriginOf, listClaudeSessions } from '../server/sources/claude.mjs';
import { makeFixtures } from './helpers.mjs';

const fx = makeFixtures(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-origin-'));
process.env.CANBAN_CODEX_HOME = fx.codexHome; process.env.CANBAN_CLAUDE_HOME = fx.claudeHome;
process.env.CANBAN_CLAUDE_DESKTOP_DIR = fx.desktopDir;
process.env.CANBAN_GH = path.resolve('tests/fake-gh.sh'); process.env.CANBAN_GLAB = path.resolve('tests/fake-glab.sh');
process.env.FAKE_GH_DATA = '/dev/null';

const PARENT = 'local_abc-123'; // c2 in the fixtures
const transcript = path.join(fx.claudeHome, 'projects', '-r-web');
const addSession = (id, meta) => {
  fs.writeFileSync(path.join(transcript, `${id}.jsonl`), `${JSON.stringify({ type: 'user', cwd: '/r/web', timestamp: '2026-09-23T00:00:00Z', message: { content: `${id} の依頼` } })}\n`);
  fs.writeFileSync(path.join(fx.desktopDir, 'a', 'b', `local_${id}.json`), JSON.stringify({ sessionId: `local_${id}`, cliSessionId: id, title: id, ...meta }));
};
addSession('side1', { spawnedFrom: { sessionId: PARENT, taskId: 'task_1', sideSession: true } });
addSession('fork1', { spawnedFrom: { sessionId: PARENT, sideSession: true, userFork: true, btw: true } });
addSession('fork2', { forkedFromSessionId: PARENT });
addSession('spawn1', { spawnedFrom: { sessionId: PARENT, taskId: 'task_2', title: '別の作業' } });
addSession('gone1', { forkedFromSessionId: 'local_not-on-disk' });
addSession('self1', { forkedFromSessionId: 'local_self1' });

const { Store } = await import('../server/store.mjs');
const { sessionDetail } = await import('../server/board.mjs');
const store = new Store(dir);
after(async () => { await store.close(); fx.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); });

test('desktopOriginOf reads the kind and refuses ids that are not desktop ids', () => {
  assert.deepEqual(desktopOriginOf({ spawnedFrom: { sessionId: PARENT, sideSession: true } }), { desktopId: PARENT, kind: 'side' });
  assert.deepEqual(desktopOriginOf({ spawnedFrom: { sessionId: PARENT, sideSession: true, userFork: true } }), { desktopId: PARENT, kind: 'fork' });
  assert.deepEqual(desktopOriginOf({ spawnedFrom: { sessionId: PARENT } }), { desktopId: PARENT, kind: 'spawned' });
  assert.deepEqual(desktopOriginOf({ forkedFromSessionId: PARENT }), { desktopId: PARENT, kind: 'fork' });
  for (const dm of [undefined, {}, { spawnedFrom: 'x' }, { spawnedFrom: { sessionId: '../../etc' } }, { forkedFromSessionId: 42 }]) assert.equal(desktopOriginOf(dm), null);
});

test('links resolve to existing cards only, and stay apart from sub-agent parents', async () => {
  const { sessions } = await listClaudeSessions({ home: fx.claudeHome, desktopDir: fx.desktopDir });
  const of = (id) => sessions.find((s) => s.nativeId === id);
  assert.deepEqual(of('side1').derivedFrom, { id: 'claude:c2', kind: 'side' });
  assert.deepEqual(of('fork1').derivedFrom, { id: 'claude:c2', kind: 'fork' });
  assert.deepEqual(of('fork2').derivedFrom, { id: 'claude:c2', kind: 'fork' });
  assert.deepEqual(of('spawn1').derivedFrom, { id: 'claude:c2', kind: 'spawned' });
  assert.equal(of('gone1').derivedFrom, undefined, 'a parent without a card is not linked');
  assert.equal(of('self1').derivedFrom, undefined, 'a session is not its own origin');
  assert.equal(of('c1').derivedFrom, undefined);
  // Still their own cards: not hidden, and not treated as sub-agents by delete cascades or exchanges.
  for (const id of ['side1', 'fork1']) assert.equal(of(id).subagent, false);
  for (const id of ['side1', 'fork1']) assert.equal(of(id).parentId, undefined);
});

test('the card detail names the origin and the sessions derived from it', async () => {
  const child = await sessionDetail(store, 'claude:side1');
  assert.equal(child.derivedFrom.id, 'claude:c2');
  assert.equal(child.derivedFrom.kind, 'side');
  assert.equal(child.derivedFrom.title, 'README 修正');
  assert.deepEqual(child.derived, []);
  assert.equal(child.parentId, null);
  const parent = await sessionDetail(store, 'claude:c2');
  assert.equal(parent.derivedFrom, null);
  assert.deepEqual(parent.derived.map((x) => x.id).sort(), ['claude:fork1', 'claude:fork2', 'claude:side1', 'claude:spawn1']);
  assert.equal(parent.derived.find((x) => x.id === 'claude:spawn1').kind, 'spawned');
  assert.deepEqual(parent.children, [], 'not listed as sub-agents');
});

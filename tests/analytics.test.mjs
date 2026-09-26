import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeStats } from '../server/stats.mjs';
import { SearchIndex } from '../server/search.mjs';
import { Store, defaultState } from '../server/store.mjs';
import { RemotePool } from '../server/remote/pool.mjs';
import { makeFixtures } from './helpers.mjs';
import { listClaudeSessions } from '../server/sources/claude.mjs';
import { listCodexSessions } from '../server/sources/codex.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'canban-a-'));
const DAY = 86400e3;

test('stats: daily activity, breakdowns, dwell and cycle time', () => {
  const now = new Date(2026, 8, 26, 12).getTime();
  const S = (id, agent, daysAgo, project, tokens, extra = {}) => ({ id, agent, createdAt: now - daysAgo * DAY, updatedAt: now - daysAgo * DAY, project, tokens, host: { local: true }, ...extra });
  const sessions = [
    S('codex:a', 'codex', 0, 'web', 100), S('codex:b', 'codex', 1, 'web', 50), S('claude:c', 'claude', 1, 'api', 10),
    S('codex:old', 'codex', 40, 'web', 999), S('codex:sub', 'codex', 0, 'web', 5, { subagent: true }),
  ];
  const state = defaultState();
  const iso = (daysAgo) => new Date(now - daysAgo * DAY).toISOString();
  state.cards['codex:a'] = { listId: 'done', history: [{ listId: 'doing', at: iso(3) }, { listId: 'done', at: iso(1) }] };
  state.cards['codex:b'] = { listId: 'doing', history: [{ listId: 'doing', at: iso(2) }] };
  const st = computeStats(state, sessions, { days: 7, now });
  assert.equal(st.totals.sessions, 3);
  assert.equal(st.totals.tokens, 160);
  assert.equal(st.daily.length, 7);
  assert.deepEqual([st.daily.at(-1).codex, st.daily.at(-2).codex, st.daily.at(-2).claude], [1, 1, 1]);
  assert.deepEqual(st.projects.map((p) => [p.name, p.sessions]), [['web', 2], ['api', 1]]);
  assert.equal(st.lists.find((l) => l.id === 'doing').medianDwellMs, 2 * DAY);
  assert.equal(st.cycle.count, 1);
  assert.equal(st.cycle.medianMs, 2 * DAY);
  assert.equal(computeStats(state, sessions, { days: 7, now, agent: 'claude' }).totals.sessions, 1);
});

test('saved views', async () => {
  const store = new Store(tmp());
  const v = await store.saveView({ name: 'レビュー待ち', filters: { status: 'waiting', swimlane: 'project', bogus: 1 } });
  assert.deepEqual(store.load().settings.views, [{ id: v.id, name: 'レビュー待ち', filters: { status: 'waiting', swimlane: 'project' } }]);
  await store.deleteView({ viewId: v.id });
  assert.deepEqual(store.load().settings.views, []);
  await assert.rejects(store.saveView({ name: ' ', filters: {} }), /ビュー名/);
});

const fx = makeFixtures();
after(() => fx.cleanup());

test('full-text index: Japanese substring match, incremental updates', async () => {
  const sessions = [
    ...(await listCodexSessions({ home: fx.codexHome })).sessions,
    ...(await listClaudeSessions({ home: fx.claudeHome, desktopDir: fx.desktopDir })).sessions,
  ].map((s) => ({ ...s, updatedAt: Date.now() }));
  const idx = new SearchIndex(tmp());
  const p1 = await idx.step(sessions);
  assert.equal(p1.indexed, p1.total);
  assert.deepEqual(idx.query('直しました').map((r) => r.id), ['codex:t1']);
  assert.match(idx.query('直しました')[0].snippet, /\[直しました\]/);
  assert.deepEqual(idx.query('計測しま').map((r) => r.id), ['claude:c1']);
  assert.deepEqual(idx.query('ab'), []); // < 3 chars
  const before = fs.statSync(idx.file).mtimeMs;
  await idx.step(sessions); // nothing changed: no re-index
  assert.equal(idx.query('直しました').length, 1);
  assert.ok(fs.statSync(idx.file).mtimeMs >= before);
});

test('remote substring search maps hits to session ids', async () => {
  const pool = new RemotePool({ ssh: path.join(here, 'fake-ssh.sh'), extraArgs: { codexHome: fx.codexHome, claudeHome: fx.claudeHome, desktopDir: fx.desktopDir } });
  const host = { id: 'h', alias: 'fx', label: 'fx', sshArgs: [] };
  await pool.sessions([host]);
  assert.deepEqual([...(await pool.search(host, '直しました'))], ['codex@fx:t1']);
  assert.deepEqual([...(await pool.search(host, 'README を直'))], ['claude@fx:c2']);
});

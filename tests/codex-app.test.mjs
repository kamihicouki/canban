// Codex app state (~/.codex/.codex-global-state.json): projects and assignments,
// follow-ups, pins and remote connections, parsed only when the file changes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { codexAppState, codexAppCounters, annotateCodexApp, parseAppState, codexProjectList } from '../server/sources/codex-app.mjs';
import { listRemoteHosts } from '../server/sources/remotes.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-codexapp-'));
after(() => fs.rmSync(home, { recursive: true, force: true }));

const file = path.join(home, '.codex-global-state.json');
const write = (o) => fs.writeFileSync(file, JSON.stringify(o));
const base = {
  'local-projects': { 'local-a': { id: 'local-a', name: 'retro', rootPaths: ['/r/retro-web', '/r/retro-api'] } },
  'remote-projects': [{ id: 'rp-1', hostId: 'remote-ssh-discovered:vps', remotePath: '/home/u/app', label: 'vps app' }],
  'thread-project-assignments': { t1: { projectId: 'local-a', projectKind: 'local' }, t9: { projectId: 'rp-1', projectKind: 'remote' }, tx: { projectId: 'gone', projectKind: 'local' } },
  'queued-follow-ups': { t1: [{ id: 'f1', text: 'next', cwd: '/r/retro-web', createdAt: 1, pausedReason: null }], t2: [] },
  'pinned-thread-ids': ['t2'],
  'codex-managed-remote-connections': [{ hostId: 'remote-ssh-discovered:vps', alias: 'vps', displayName: 'VPS' }, { hostId: 'x', alias: '-oProxyCommand=evil' }],
};

test('projects, assignments, follow-ups and pins are read; unknown project ids are ignored', () => {
  const app = parseAppState(base, [{ id: 'db-1', name: 'from db', roots: ['/d'] }]);
  assert.deepEqual([...app.projects.keys()].sort(), ['db-1', 'local-a', 'rp-1']);
  assert.deepEqual(app.projects.get('local-a').roots, ['/r/retro-web', '/r/retro-api']);
  assert.equal(app.projects.get('rp-1').hostId, 'remote-ssh-discovered:vps');
  assert.equal(app.assignments.get('t1'), 'local-a');
  assert.equal(app.assignments.has('tx'), false);
  assert.equal(app.followUps.get('t1'), 1);
  assert.equal(app.followUps.has('t2'), false, 'an empty queue is no follow-up');
  assert.ok(app.pinned.has('t2'));
});

test('sessions get the Codex project as their project; the folder name stays as folder', () => {
  const app = parseAppState(base);
  const s1 = { agent: 'codex', nativeId: 't1', project: 'retro-web' };
  const s2 = { agent: 'codex', nativeId: 't2', project: 'misc' };
  const c1 = { agent: 'claude', nativeId: 't1', project: 'web' };
  annotateCodexApp([s1, s2, c1], app);
  assert.deepEqual([s1.project, s1.folder, s1.codexProject.name, s1.codexFollowUps, s1.pinnedInAgent], ['retro', 'retro-web', 'retro', 1, false]);
  assert.deepEqual([s2.project, s2.folder, s2.codexProject, s2.pinnedInAgent], ['misc', 'misc', null, true]);
  assert.deepEqual([c1.project, c1.folder, c1.codexProject], ['web', 'web', undefined], 'Claude sessions are not touched');
  // Cached (remote) session objects are re-annotated: a removed assignment falls back to the folder.
  annotateCodexApp([s1], parseAppState({}));
  assert.deepEqual([s1.project, s1.codexProject], ['retro-web', null]);
  const list = codexProjectList(app, [s1, { codexProject: { id: 'local-a' } }]);
  assert.equal(list.find((p) => p.id === 'local-a').count, 1);
});

test('the file is parsed only when it changes, and remote hosts share the cache', async () => {
  write(base);
  // A state DB with a projects table fills in names the JSON lacks.
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT); CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT); INSERT INTO projects VALUES ('db-1','from db'); INSERT INTO project_roots VALUES ('db-1',0,'/d');");
  db.close();
  const p0 = codexAppCounters.parses;
  const a = await codexAppState({ home });
  assert.equal(a.projects.get('db-1').name, 'from db');
  await codexAppState({ home });
  const hosts = await listRemoteHosts({ home });
  assert.equal(codexAppCounters.parses, p0 + 1, 'parsed once');
  assert.deepEqual(hosts.map((h) => h.alias), ['vps'], 'unsafe aliases are still refused');
  const t = Date.now() / 1000 + 5;
  write({ ...base, 'pinned-thread-ids': ['t1'] });
  fs.utimesSync(file, t, t);
  assert.ok((await codexAppState({ home })).pinned.has('t1'));
  assert.equal(codexAppCounters.parses, p0 + 2);
});

test('a missing or broken file is an empty state', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-codexapp-empty-'));
  assert.equal((await codexAppState({ home: empty })).projects.size, 0);
  fs.writeFileSync(path.join(empty, '.codex-global-state.json'), '{ broken');
  assert.equal((await codexAppState({ home: empty })).assignments.size, 0);
  fs.rmSync(empty, { recursive: true, force: true });
});

test('Codex sections are read, and a move between sections is seen without an updated_at change', async () => {
  const { listCodexSessions, codexListCounters } = await import('../server/sources/codex.mjs');
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-sections-'));
  const db = new DatabaseSync(path.join(h, 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, cwd TEXT, title TEXT, archived INTEGER, thread_section_id TEXT);
    CREATE INDEX idx_threads_updated_at ON threads(updated_at DESC, id DESC);
    CREATE TABLE thread_sections (id TEXT PRIMARY KEY, name TEXT);
    INSERT INTO thread_sections VALUES ('s-doing', 'doing'), ('s-done', 'done');
    INSERT INTO threads VALUES ('a', '', 1, 1000, '/r/x', 'A', 0, 's-doing'), ('b', '', 1, 1000, '/r/x', 'B', 0, NULL);`);
  const get = async () => Object.fromEntries((await listCodexSessions({ home: h })).sessions.map((s) => [s.nativeId, s.codexSection?.name ?? null]));
  assert.deepEqual(await get(), { a: 'doing', b: null });
  const full = codexListCounters.full;
  db.exec("UPDATE threads SET thread_section_id = 's-done' WHERE id = 'a'"); // updated_at untouched
  db.close();
  assert.deepEqual(await get(), { a: 'done', b: null });
  assert.equal(codexListCounters.full, full, 'read as a delta, not a full reload');
  fs.rmSync(h, { recursive: true, force: true });
});

test('source metadata carries the actual app storage scope, assignment and all project roots', async () => {
  const { sessionSourceView } = await import('../server/source-model.mjs');
  const app = await codexAppState({ home });
  const sessions = [{ id: 'codex:t1', nativeId: 't1', agent: 'codex', cwd: '/unrelated' }, { id: 'codex:tx', nativeId: 'tx', agent: 'codex', cwd: '/r/retro-web' }, { id: 'codex:other', nativeId: 'other', agent: 'codex', cwd: '/r/retro-web' }];
  annotateCodexApp(sessions, app);
  const source = sessionSourceView(sessions[0]);
  assert.equal(source.attributes.codexProject.value.ref.scopeId, fs.realpathSync(home));
  assert.equal(source.attributes.codexProject.value.ref.nativeId, 'local-a');
  assert.deepEqual(sessions[0].sourceMetadata.codexProject.roots, ['/r/retro-web', '/r/retro-api']);
  assert.equal(sessionSourceView(sessions[1]).attributes.codexProject.status, 'unavailable');
  assert.equal(sessionSourceView(sessions[2]).attributes.codexProject.status, 'absent');
  annotateCodexApp(sessions, parseAppState(base));
  assert.equal(sessionSourceView(sessions[0]).attributes.codexProject.status, 'unknown', 'unscoped parser result is not a stable source');
});

test('a broken app snapshot keeps previous source facts explicitly stale', async () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-source-stale-'));
  const file = path.join(h, '.codex-global-state.json');
  try {
    fs.writeFileSync(file, JSON.stringify(base));
    const known = await codexAppState({ home: h });
    fs.writeFileSync(file, '{ broken snapshot');
    const stale = await codexAppState({ home: h });
    assert.equal(stale.sourceObservation.status, 'stale');
    assert.equal(stale.sourceObservation.observedAt, known.sourceObservation.observedAt);
    const session = { agent: 'codex', nativeId: 't1' };
    annotateCodexApp([session], stale);
    assert.equal(session.sourceMetadata.codexProject.status, 'stale');
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test('section observations identify the DB and do not borrow the app JSON observation time', () => {
  const app = parseAppState(base, [], { scopeId: '/codex', status: 'known', observedAt: 9000 });
  const s = { agent: 'codex', nativeId: 't1', codexSection: { id: 'sec', name: 'doing' } };
  annotateCodexApp([s], app);
  assert.equal(s.sourceMetadata.codexSection.source, 'codex-db');
  assert.equal(s.sourceMetadata.codexSection.observedAt, null);
});

test('foreign storage and cloud threads cannot inherit local project facts', () => {
  const app = parseAppState(base, [], { scopeId: '/default-codex', status: 'known', observedAt: 9000 });
  const sessions = [
    { agent: 'codex', nativeId: 't1', homeDir: '/other-codex' },
    { agent: 'codex', nativeId: 'missing', homeDir: '/other-codex' },
    { agent: 'codex', nativeId: 't1', sourceKind: 'codex-cloud' },
    { agent: 'codex', nativeId: 'missing', sourceKind: 'codex-cloud' },
    { agent: 'codex', nativeId: 't1', host: { local: false } },
  ];
  annotateCodexApp(sessions, app);
  for (const session of sessions) {
    assert.equal(session.sourceMetadata.codexProject.status, 'unknown');
    assert.equal(session.sourceMetadata.codexProject.ref, undefined);
  }
});

test('storage scope canonicalizes aliases without trimming native IDs', async () => {
  const { storageScope, sourceKey } = await import('../server/source-model.mjs');
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-storage-scope-'));
  try {
    fs.mkdirSync(path.join(h, 'real'));
    fs.symlinkSync(path.join(h, 'real'), path.join(h, 'alias'));
    const scope = storageScope(path.join(h, 'real'));
    assert.equal(storageScope(path.join(h, 'alias') + '/'), scope);
    assert.equal(storageScope('~/'), storageScope(os.homedir()));
    const app = parseAppState(base, [], { scopeId: scope, status: 'known', observedAt: 9000 });
    const s = { agent: 'codex', nativeId: 't1', homeDir: path.join(h, 'alias') + '/' };
    annotateCodexApp([s], app);
    assert.equal(s.sourceMetadata.codexProject.status, 'known');
    assert.notEqual(sourceKey({ ...s.sourceMetadata.codexProject.ref, nativeId: ' p ' }), sourceKey({ ...s.sourceMetadata.codexProject.ref, nativeId: 'p' }));
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test('app observations distinguish acquisition time from the file update time', async () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-acquired-time-'));
  try {
    const file = path.join(h, '.codex-global-state.json');
    fs.writeFileSync(file, JSON.stringify(base));
    fs.utimesSync(file, 1000, 1000);
    const before = Date.now();
    const app = await codexAppState({ home: h });
    assert.ok(app.sourceObservation.observedAt >= before);
    assert.equal(app.sourceObservation.sourceUpdatedAt, fs.statSync(file).mtimeMs);
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

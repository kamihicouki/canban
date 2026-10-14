import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureAccounts, resetAccountsForTest } from '../server/accounts.mjs';
import { listClaudeSessions } from '../server/sources/claude.mjs';
import { planGuests, placeGuests, restoreGuests, openIntegrated, recoverGuests, readLedger, setGuestRunningCheck, guestPaths } from '../server/claude-desktop-guests.mjs';
import { planGuestGroups } from '../server/claude-desktop-groups.mjs';

// Pure layout: one Desktop folder, signed in to "host"; "other" is the second account.
const HOST = 'host-account', OTHER = 'other-account';
const cli = n => `${n}${n}${n}${n}${n}${n}${n}${n}-0000-4000-8000-000000000000`;
const ids = { open: 'local_aaaaaaaa-0000-4000-8000-000000000001', busy: 'local_aaaaaaaa-0000-4000-8000-000000000002', archived: 'local_aaaaaaaa-0000-4000-8000-000000000003', mine: 'local_aaaaaaaa-0000-4000-8000-000000000004' };
let root, env, previousCheck, running, app, hostDir, otherDir, projects;
const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = file => fs.lstat(file).then(() => true, () => false);
const record = (id, n, extra = {}) => ({ sessionId: id, cliSessionId: cli(n), cwd: '/work', title: `会話 ${n}`, lastActivityAt: 1000, completedTurns: 1, remoteMcpServersConfig: [{ name: `mcp-of-${n}` }], ...extra });
const turn = text => JSON.stringify({ type: 'user', cwd: '/work', timestamp: '2026-10-14T00:00:00Z', message: { content: text } }) + '\n';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'canban-guests-'));
  env = { ...process.env };
  app = path.join(root, 'Claude');
  process.env.CANBAN_CLAUDE_DESKTOP_DIR = path.join(app, 'claude-code-sessions');
  process.env.CANBAN_CLAUDE_HOME = path.join(root, 'claude-home');
  process.env.CANBAN_DESKTOP_GUESTS_DIR = path.join(root, 'state');
  projects = path.join(root, 'claude-home', 'projects', '-work');
  hostDir = path.join(app, 'claude-code-sessions', HOST, 'org-h');
  otherDir = path.join(app, 'claude-code-sessions', OTHER, 'org-o');
  await write(path.join(app, 'config.json'), { lastKnownAccountUuid: HOST });
  await write(path.join(hostDir, `${ids.mine}.json`), record(ids.mine, 'd'));
  await write(path.join(otherDir, `${ids.open}.json`), record(ids.open, 'a'));
  await write(path.join(otherDir, `${ids.busy}.json`), record(ids.busy, 'b', { interruptedByQuitAt: 5 }));
  await write(path.join(otherDir, `${ids.archived}.json`), record(ids.archived, 'c', { isArchived: true }));
  for (const n of 'abcd') await write(path.join(projects, `${cli(n)}.jsonl`), turn(`最初の依頼 ${n}`));
  running = false;
  previousCheck = setGuestRunningCheck(async () => running);
  resetAccountsForTest(); configureAccounts({ discover: false });
});
afterEach(async () => {
  setGuestRunningCheck(previousCheck); resetAccountsForTest();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  await fs.rm(root, { recursive: true, force: true });
});

test('only open, idle sessions of other accounts become guests', async () => {
  const plan = await planGuests({ labelOf: a => a.split('-')[0] });
  assert.equal(plan.host, HOST);
  assert.deepEqual(plan.guests.map(g => g.sessionId), [ids.open]);
  assert.equal(plan.guests[0].prefix, '🔗 other · ');
  assert.deepEqual(plan.skipped.map(s => [s.sessionId, s.reason]), [[ids.busy, '作業途中で終了された会話']]);
});

test('a guest carries progress back to its original and the accounts separate again', async () => {
  const origin = path.join(otherDir, `${ids.open}.json`);
  const before = await read(origin);
  const placed = await placeGuests({ labelOf: () => 'other' });
  assert.equal(placed.placed, 1);
  const guest = path.join(hostDir, `${ids.open}.json`);
  assert.equal((await read(guest)).title, '🔗 other · 会話 a');
  assert.deepEqual(await read(origin), before, 'the original is untouched while integrated');
  // Desktop (host account) runs a turn in the guest.
  await write(guest, { ...(await read(guest)), lastActivityAt: 2000, completedTurns: 2, remoteMcpServersConfig: [{ name: 'host-mcp' }], enabledMcpTools: { host: true } });
  await fs.appendFile(path.join(projects, `${cli('a')}.jsonl`), turn('ゲストでの続き'));
  running = true;
  assert.deepEqual((await restoreGuests()).problems, ['Desktop が起動しています']);
  assert.equal(await exists(guest), true, 'nothing is restored while Desktop runs');
  running = false;
  const result = await restoreGuests();
  assert.equal(result.restored, 1);
  const after = await read(origin);
  assert.equal(after.title, '会話 a');
  assert.equal(after.completedTurns, 2);
  assert.equal(after.lastActivityAt, 2000);
  assert.deepEqual(after.remoteMcpServersConfig, before.remoteMcpServersConfig, 'account-specific values stay the original account\'s');
  assert.equal('enabledMcpTools' in after, false);
  assert.equal(await exists(guest), false);
  assert.equal(await readLedger(), null);
  assert.match(await fs.readFile(path.join(projects, `${cli('a')}.jsonl`), 'utf8'), /ゲストでの続き/);
});

test('deleting a guest keeps the original and puts a reaped transcript back', async () => {
  await placeGuests({ labelOf: () => 'other' });
  const guest = path.join(hostDir, `${ids.open}.json`);
  const transcript = path.join(projects, `${cli('a')}.jsonl`);
  const text = await fs.readFile(transcript, 'utf8');
  await fs.unlink(guest);
  await write(path.join(hostDir, `deleted_${ids.open}`), '');
  await fs.unlink(transcript);
  const result = await restoreGuests();
  assert.equal(result.restored, 1);
  assert.equal(await fs.readFile(transcript, 'utf8'), text);
  assert.equal((await read(path.join(otherDir, `${ids.open}.json`))).title, '会話 a');
  assert.equal(await exists(path.join(hostDir, `deleted_${ids.open}`)), false);
});

test('while integrated, the board shows a guest once, as its own account, reachable from the host', async () => {
  await placeGuests({ labelOf: () => 'other' });
  const guest = path.join(hostDir, `${ids.open}.json`);
  await write(guest, { ...(await read(guest)), lastActivityAt: 9000 });
  const sessions = (await listClaudeSessions()).sessions.filter(s => s.nativeId === cli('a'));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].desktopAccount, OTHER);
  assert.equal(sessions[0].title, '会話 a');
  assert.deepEqual([...sessions[0].desktopReach].sort(), [HOST, OTHER].sort());
});

test('opening integrates only while Desktop is stopped, and never a quit-interrupted session', async () => {
  const opened = [];
  let watched = 0;
  const open = async () => opened.push('open');
  const watch = () => watched++;
  running = true;
  const busy = await openIntegrated({ sessionId: ids.open, labelOf: () => 'other', open, watch });
  assert.equal(busy.code, 'desktop_running');
  running = false;
  const interrupted = await openIntegrated({ sessionId: ids.busy, labelOf: () => 'other', open, watch });
  assert.equal(interrupted.code, 'not_guest');
  assert.match(interrupted.reason, /作業の途中/);
  assert.equal(await readLedger(), null);
  const ok = await openIntegrated({ sessionId: ids.open, labelOf: () => 'other', open, watch });
  assert.equal(ok.ok, true);
  assert.deepEqual(opened, ['open']);
  assert.equal(watched, 1);
  assert.equal((await readLedger()).entries.length, 1);
  // A watcher that died: the next server start tidies up once Desktop is stopped.
  assert.equal((await recoverGuests({ watch })).restored, 1);
  assert.equal(await exists(path.join(hostDir, `${ids.open}.json`)), false);
  assert.equal(guestPaths().state, path.join(root, 'state'));
});

// Desktop's manual groups (claude_desktop_config.json), keyed by "<account>/<org>".
const config = (scopes, extra = {}) => JSON.stringify({ coworkUserFilesPath: '/x', preferences: { mcp: { keep: [1, 2.5, 'é'] }, epitaxyPrefs: { 'dframe-group-scopes': scopes, other: true } }, ...extra }, null, 2);
const configFile = () => path.join(app, 'claude_desktop_config.json');
const hostScope = `${HOST}/org-h`;
const canban = { id: 'cg-host-canban', name: 'canban' };

test('a guest joins the host group of the same name, and the assignment stays after the restore', async () => {
  await write(path.join(otherDir, `${ids.open}.json`), record(ids.open, 'a', { cwd: '/Users/d/repo/canban/.claude/worktrees/x' }));
  const before = config({ [hostScope]: { groups: [canban, { id: 'cg-sdw', name: 'sdw' }], assignments: { [`code:${ids.mine}`]: 'cg-sdw' }, order: { 'cg-sdw': [`code:${ids.mine}`] } } });
  await write(configFile(), before);
  const placed = await placeGuests({ labelOf: () => 'other' });
  assert.equal(placed.grouped, 1);
  const scope = JSON.parse(await fs.readFile(configFile(), 'utf8')).preferences.epitaxyPrefs['dframe-group-scopes'][hostScope];
  assert.equal(scope.assignments[`code:${ids.open}`], 'cg-host-canban');
  assert.deepEqual(scope.order['cg-host-canban'], [`code:${ids.open}`]);
  assert.deepEqual((await readLedger()).groups.placed.map(p => [p.sessionId, p.via]), [[ids.open, 'project']]);
  assert.equal((await restoreGuests()).restored, 1);
  const after = JSON.parse(await fs.readFile(configFile(), 'utf8'));
  const a = after.preferences.epitaxyPrefs['dframe-group-scopes'][hostScope];
  // Kept on purpose: Desktop's cache would revive it, and the next integration reuses it.
  assert.equal(a.assignments[`code:${ids.open}`], 'cg-host-canban');
  assert.equal(a.assignments[`code:${ids.mine}`], 'cg-sdw');
  assert.deepEqual(after.preferences.mcp, { keep: [1, 2.5, 'é'] });
  assert.equal(await readLedger(), null);
});

test('group placement follows the origin group, needs a unique name, and never touches an odd config', async () => {
  const scopes = {
    [hostScope]: { groups: [canban, { id: 'cg-a', name: 'dup' }, { id: 'cg-b', name: 'dup' }], assignments: { 'code:local_pre': 'cg-a' }, order: {} },
    [`${OTHER}/org-o`]: { groups: [{ id: 'cg-o1', name: 'research' }, { id: 'cg-o2', name: 'dup' }], assignments: { 'code:local_r': 'cg-o1', 'code:local_d': 'cg-o2' }, order: {} },
  };
  const data = JSON.parse(config(scopes));
  const g = (sessionId, cwd) => ({ sessionId, account: OTHER, org: 'org-o', cwd });
  const plan = planGuestGroups(data, hostScope, [g('local_r', '/repo/canban'), g('local_d', '/repo/canban'), g('local_p', '/Users/d/repo/canban'), g('local_pre', '/repo/canban'), g('local_n', '/repo/other')]);
  assert.deepEqual(plan.map(p => p.groupId || p.skip), ['no-group', 'no-group', 'cg-host-canban', 'preexisting', 'no-group']);
  // A config that would not round-trip byte-for-byte is left alone.
  await write(path.join(otherDir, `${ids.open}.json`), record(ids.open, 'a', { cwd: '/repo/canban' }));
  const odd = config({ [hostScope]: { groups: [canban], assignments: {}, order: {} } }) + '\n';
  await write(configFile(), odd);
  assert.equal((await placeGuests({ labelOf: () => 'other' })).grouped, 0);
  assert.equal(await fs.readFile(configFile(), 'utf8'), odd);
  assert.equal((await readLedger()).groups, undefined);
  await restoreGuests();
  // Invalid UTF-8 would not survive a rewrite: left alone too.
  const bad = Buffer.concat([Buffer.from(config({ [hostScope]: { groups: [canban], assignments: {}, order: {} } }).replace('"/x"', '"/x_"')), Buffer.alloc(0)]);
  const at = bad.indexOf('_'); bad[at] = 0xff;
  await fs.writeFile(configFile(), bad);
  assert.equal((await placeGuests({ labelOf: () => 'other' })).grouped, 0);
  assert.ok((await fs.readFile(configFile())).equals(bad));
});

test('place and restore never run at the same time', async () => {
  await Promise.all([placeGuests({ labelOf: () => 'other' }), restoreGuests(), placeGuests({ labelOf: () => 'other' })].map(p => p.catch(e => e)));
  const state = path.join(root, 'state');
  assert.deepEqual((await fs.readdir(state)).filter(f => f.startsWith('lock')), []);
  await restoreGuests();
  assert.equal(await readLedger(), null);
  assert.equal(await exists(path.join(hostDir, `${ids.open}.json`)), false);
});

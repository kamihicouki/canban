import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { makeFixtures } from './helpers.mjs';
import { newSessionLink, newSessionCommand } from '../server/agents.mjs';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-direct-'));
const fx = makeFixtures();
let child, nextId = 0;
const waiting = new Map();
const rpc = (method, params) => new Promise(resolve => {
  const id = ++nextId;
  waiting.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
before(async () => {
  child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, stdio: ['pipe', 'pipe', 'inherit'], env: {
    ...process.env, CANBAN_DATA_DIR: dataDir, CANBAN_CODEX_HOME: fx.codexHome,
    CANBAN_CLAUDE_HOME: fx.claudeHome, CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir,
    CANBAN_LAUNCH_DRYRUN: '1', CANBAN_SEARCH_INDEX: '0', CANBAN_BACKGROUND: '0',
  } });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message); waiting.delete(message.id);
  });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'direct-test', version: '0' } });
});
after(async () => {
  await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  fs.rmSync(dataDir, { recursive: true, force: true }); fx.cleanup();
});

test('direct desktop starts do not create tasks and retry tokens cannot launch changed requests', async () => {
  const tasks = async () => (await call('canban_get_board', { days: 0 })).structuredContent.lists.flatMap(l => l.cards).filter(c => c.kind === 'task').map(c => c.id);
  const before = await tasks();
  for (const agent of ['codex', 'claude']) {
    const args = { agent, cwd: '/r/web', prompt: 'README を確認する', route: 'desktop', clientRequestId: `direct-${agent}` };
    const opened = await call('canban_start_session', args);
    assert.ok(!opened.isError, opened.content?.[0]?.text);
    assert.equal(opened.structuredContent.state, 'opened');
    assert.equal(opened.structuredContent.route, 'desktop');
    assert.match(opened.structuredContent.url, agent === 'codex' ? /^codex:\/\/threads\/new\?/ : /^claude:\/\/code\/new\?/);
    assert.deepEqual((await call('canban_start_session', args)).structuredContent, opened.structuredContent);
    assert.equal((await call('canban_start_session', { ...args, prompt: '別の依頼' })).isError, true);
  }
  assert.deepEqual(await tasks(), before);
  assert.equal((await call('canban_start_session', { agent: 'codex', taskId: 'task:missing', route: 'desktop' })).isError, true);
});

test('a remote Codex start cannot silently open a local Desktop session', () => {
  assert.throws(() => newSessionLink('codex', { host: { id: 'remote-ssh-discovered:box', alias: 'box', local: false }, cwd: '/srv', prompt: '確認' }), /ターミナル/);
});

test('a terminal start never runs the agent when changing to the requested folder fails', () => {
  const binDir = path.join(dataDir, 'bin'); fs.mkdirSync(binDir);
  const marker = path.join(dataDir, 'launched');
  fs.writeFileSync(path.join(binDir, 'codex'), '#!/bin/sh\nprintf launched > "$CANBAN_START_MARKER"\n', { mode: 0o700 });
  const command = newSessionCommand('codex', { cwd: path.join(dataDir, 'missing'), prompt: 'hello' });
  spawnSync('/bin/sh', ['-c', command], { env: { PATH: binDir, CANBAN_START_MARKER: marker } });
  assert.equal(fs.existsSync(marker), false);
});

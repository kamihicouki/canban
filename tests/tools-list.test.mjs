// tools/list is a contract with every MCP host: names, order, schemas and descriptions.
// The fixture pins each tool's full definition by hash, so moving definitions between files
// (server/tools/*.mjs) cannot drop, reorder or change a tool unnoticed.
// After an intended tool change: CANBAN_UPDATE_TOOLS_SNAPSHOT=1 node --test tests/tools-list.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeFixtures } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshotPath = path.join(root, 'tests', 'fixtures', 'tools-list.json');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-tools-list-'));
const fx = makeFixtures();
let child;
let nextId = 1;
const waiting = new Map();

function rpc(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve) => waiting.set(id, resolve));
}

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

before(async () => {
  child = spawn(process.execPath, ['--no-warnings', path.join(root, 'server', 'index.mjs')], { cwd: root, env: { ...process.env, CANBAN_DATA_DIR: dataDir, CANBAN_CODEX_HOME: fx.codexHome, CANBAN_CLAUDE_HOME: fx.claudeHome, CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir, CANBAN_LAUNCH_DRYRUN: '1', CANBAN_SEARCH_INDEX: '0', CANBAN_BACKGROUND: '0' }, stdio: ['pipe', 'pipe', 'ignore'] });
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m);
  });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
});
after(() => {
  child.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fx.cleanup();
});

test('tools/list keeps every tool, its order and its full definition', async () => {
  const { tools } = (await rpc('tools/list')).result;
  const actual = { names: tools.map((t) => t.name), sha256: Object.fromEntries(tools.map((t) => [t.name, hash(t)])), all: hash(tools) };
  if (process.env.CANBAN_UPDATE_TOOLS_SNAPSHOT === '1') fs.writeFileSync(snapshotPath, `${JSON.stringify(actual, null, 2)}\n`);
  const expected = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  assert.deepEqual(actual.names, expected.names, 'tool names or order changed');
  assert.deepEqual(actual.sha256, expected.sha256, 'a tool definition changed (name / title / description / inputSchema / annotations / _meta)');
  assert.equal(actual.all, expected.all);
});

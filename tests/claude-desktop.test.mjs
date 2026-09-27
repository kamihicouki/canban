// Claude Desktop: the .mcpb manifest starts the server from a bundle without the Codex plugin files.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeFixtures } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(root, ...p), 'utf8'));
const manifest = readJson('manifest.json');
const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-mcpb-'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-mcpb-data-'));
const fx = makeFixtures();
let child;
let nextId = 1;
const waiting = new Map();

function rpc(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve) => waiting.set(id, resolve));
}

// What Claude Desktop does with mcp_config: substitute ${__dirname} and ${user_config.*} (defaults here).
function resolveConfig(dir) {
  const vars = { __dirname: dir };
  for (const [k, v] of Object.entries(manifest.user_config || {})) vars[`user_config.${k}`] = String(v.default ?? '');
  const sub = (s) => s.replace(/\$\{([^}]+)\}/g, (m, k) => vars[k] ?? m);
  const c = manifest.server.mcp_config;
  return { command: sub(c.command), args: c.args.map(sub), env: Object.fromEntries(Object.entries(c.env || {}).map(([k, v]) => [k, sub(v)])) };
}

before(async () => {
  // A bundle as packed by `npm run pack:mcpb`: no .codex-plugin, .mcp.json or tests.
  for (const p of ['server', 'ui', 'scripts', 'assets', 'package.json', 'manifest.json']) fs.cpSync(path.join(root, p), path.join(bundle, p), { recursive: true });
  const cfg = resolveConfig(bundle);
  child = spawn(cfg.command, cfg.args, {
    cwd: os.tmpdir(), // Claude Desktop does not start the server in the bundle directory
    env: { ...process.env, ...cfg.env, CANBAN_DATA_DIR: dataDir, CANBAN_CODEX_HOME: fx.codexHome, CANBAN_CLAUDE_HOME: fx.claudeHome, CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir, CANBAN_LAUNCH_DRYRUN: '1', CANBAN_SEARCH_INDEX: '0', CANBAN_GH: path.join(root, 'tests', 'fake-gh.sh'), CANBAN_GLAB: path.join(root, 'tests', 'fake-glab.sh'), FAKE_GH_DATA: '/dev/null' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m);
  });
});
after(() => {
  child.kill();
  for (const d of [bundle, dataDir]) fs.rmSync(d, { recursive: true, force: true });
  fx.cleanup();
});

test('manifest version and icon stay in step with the package', () => {
  assert.equal(manifest.version, readJson('package.json').version);
  assert.equal(manifest.version, readJson('.codex-plugin', 'plugin.json').version);
  assert.equal(manifest.server.entry_point, 'scripts/launch.sh');
  assert.ok(fs.readFileSync(path.join(root, manifest.icon)).subarray(1, 4).toString() === 'PNG');
});

test('starts from the bundle and reports the Claude Desktop client', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1.0.0' } });
  assert.equal(init.result.serverInfo.name, 'canban');
  assert.equal(init.result.serverInfo.version, manifest.version);
  assert.equal(init.result.protocolVersion, '2025-11-25');
  const perf = (await rpc('tools/call', { name: 'canban_get_perf', arguments: {} })).result.structuredContent;
  assert.deepEqual(perf.client, { name: 'claude-ai', version: '1.0.0' });
});

test('open_canban points at the MCP Apps resource and renders a board', async () => {
  const { result } = await rpc('tools/list');
  const open = result.tools.find((t) => t.name === 'open_canban');
  assert.equal(open._meta.ui.resourceUri, 'ui://canban/board.html');
  assert.deepEqual(open._meta.ui.visibility, ['model', 'app']);
  const res = (await rpc('resources/read', { uri: open._meta.ui.resourceUri })).result.contents[0];
  assert.equal(res.mimeType, 'text/html;profile=mcp-app');
  assert.ok(res.text.includes(`v${manifest.version}`) || !res.text.includes('__CANBAN_VERSION__'));
  const called = (await rpc('tools/call', { name: 'open_canban', arguments: {} })).result;
  assert.equal(called.isError, undefined);
  assert.equal(called.structuredContent.view, 'board');
});

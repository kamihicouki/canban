import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeFixtures, stopChild } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('get_session reads origin only after lookup and explicit includeOrigin, through MCP', async () => {
  const fx = makeFixtures();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-origin-mcp-'));
  const marker = path.join(dir, 'origin-opens');
  const preload = path.join(dir, 'observe.mjs');
  // Observe the reader's numeric nonblocking open without changing production dependencies.
  fs.writeFileSync(preload, `import fs from 'node:fs';\nimport fsp from 'node:fs/promises';\nconst open = fsp.open.bind(fsp);\nfsp.open = (...args) => { if (typeof args[1] === 'number' && (args[1] & fs.constants.O_NONBLOCK)) fs.appendFileSync(process.env.ORIGIN_TEST_MARKER, 'open\\n'); return open(...args); };\n`);
  const child = spawn(process.execPath, ['--no-warnings', '--import', preload, path.join(root, 'server/index.mjs')], {
    cwd: root,
    env: { ...process.env, CANBAN_DATA_DIR: dir, CANBAN_CODEX_HOME: fx.codexHome, CANBAN_CLAUDE_HOME: fx.claudeHome, CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir, CANBAN_LAUNCH_DRYRUN: '1', CANBAN_SEARCH_INDEX: '0', CANBAN_BACKGROUND: '0', ORIGIN_TEST_MARKER: marker },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pending = new Map();
  let nextId = 1;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
  });
  const rpc = (method, params) => new Promise(resolve => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const detail = arguments_ => rpc('tools/call', { name: 'canban_get_session', arguments: arguments_ });
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'origin-test', version: '0' } });
    for (const includeOrigin of [undefined, false]) {
      const result = await detail({ cardId: 'codex:t1', ...(includeOrigin === undefined ? {} : { includeOrigin }) });
      assert.ok(!result.isError, result.content?.[0]?.text);
      assert.equal(Object.hasOwn(result.structuredContent, 'origin'), false);
      assert.equal(fs.existsSync(marker), false);
    }
    const denied = await detail({ cardId: 'codex:missing', includeOrigin: true });
    assert.equal(denied.isError, true);
    assert.equal(fs.existsSync(marker), false);
    const before = fx.snapshot();
    for (const [cardId, text] of [['codex:t1', 'ログインを直して'], ['claude:c1', 'トップページを速くして'], ['claude:c2', 'README を直して']]) {
      const result = await detail({ cardId, includeOrigin: true });
      assert.ok(!result.isError, result.content?.[0]?.text);
      assert.equal(result.structuredContent.origin.state, 'available');
      assert.equal(result.structuredContent.feed.fromStart, true);
      assert.equal(result.structuredContent.origin.item.text, text);
    }
    assert.equal(fs.readFileSync(marker, 'utf8'), 'open\nopen\nopen\n');
    assert.deepEqual(fx.snapshot(), before, 'origin requests preserve every source file');
    fs.appendFileSync(fx.rollout, Array.from({ length: 121 }, (_, i) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: String(i) }] } } }) + '\n').join(''));
    const limited = await detail({ cardId: 'codex:t1' });
    assert.equal(limited.structuredContent.feed.fromStart, false);
    assert.equal(limited.structuredContent.feed.items.length, 120);
  } finally {
    await stopChild(child);
    fs.rmSync(dir, { recursive: true, force: true });
    fx.cleanup();
  }
});

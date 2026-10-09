// Run explicitly: node --test tests/codex-writer.integration.mjs
// Uses only disposable, isolated Codex history; no model turn or user data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { resolveBin } from '../server/dispatch.mjs';
import { codexLifecycle } from '../server/session-actions.mjs';
import { startDesktopBridge } from '../server/codex-desktop-bridge.mjs';

test('retained idle writer: desktop-owned archive, restore and delete persist', { timeout: 40000 }, async () => {
  const bin = resolveBin('codex');
  assert.ok(bin, 'Codex CLI must be installed for native integration');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'canban-native-writer-'));
  const child = spawn(bin, ['app-server', '--listen', 'stdio://'], { env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});
  const pending = new Map(); let serial = 0;
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line), request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    message.error ? request.reject(Error(message.error.message)) : request.resolve(message.result);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++serial; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  let bridge;
  try {
    await rpc('initialize', { clientInfo: { name: 'canban_lifecycle_test', version: '1.0.0' } });
    child.stdin.write('{"method":"initialized"}\n');
    const { thread } = await rpc('thread/start', { cwd: home });
    const session = { agent: 'codex', nativeId: thread.id, id: `codex:${thread.id}`, status: 'idle', homeDir: home };
    // Persist an empty thread, then let the owner retain its writer at idle.
    await rpc('thread/archive', { threadId: thread.id });
    await rpc('thread/unarchive', { threadId: thread.id });
    await rpc('thread/resume', { threadId: thread.id });
    await assert.rejects(codexLifecycle(session, 'archive', { bin, timeoutMs: 5000 }), /保持/);
    bridge = await startDesktopBridge({ dataDir: home, env: { CODEX_HOME: home, CODEX_APP_TOOLS_PIPE_PATH: '/test-owner', CODEX_THREAD_ID: thread.id }, callTool: async (pipe, callerId, tool, args) => {
      if (tool === 'read_thread') return { thread: { id: args.threadId, hostId: 'local', status: 'idle' } };
      return rpc(args.archived ? 'thread/archive' : 'thread/unarchive', { threadId: args.threadId });
    } });
    await codexLifecycle(session, 'archive', { bin, dataDir: home });
    const archived = await rpc('thread/list', { archived: true });
    assert.ok(archived.data.some(t => t.id === thread.id));
    await codexLifecycle(session, 'restore', { bin, dataDir: home });
    await rpc('thread/resume', { threadId: thread.id });
    await codexLifecycle(session, 'delete', { bin, dataDir: home });
    await assert.rejects(rpc('thread/resume', { threadId: thread.id }), /not found|no rollout|does not exist/i);
    assert.ok(!(await rpc('thread/list', { archived: false })).data.some(t => t.id === thread.id));
    assert.ok(!(await rpc('thread/list', { archived: true })).data.some(t => t.id === thread.id));
  } finally {
    await bridge?.close(); lines.close();
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.stdin.end(); child.kill(); await exited;
    await fs.rm(home, { recursive: true, force: true });
  }
});

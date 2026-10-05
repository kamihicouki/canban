import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { startDesktopBridge, findDesktopArchive, desktopTool } from '../server/codex-desktop-bridge.mjs';

const id = '00000000-0000-4000-8000-000000000001';
test('Chrome can use a home-bound bridge and active targets are rejected before mutation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canban-bridge-test-'));
  const calls = []; let status = 'idle';
  const bridge = await startDesktopBridge({ dataDir: dir, env: { CODEX_HOME: dir, CODEX_APP_TOOLS_PIPE_PATH: '/desktop', CODEX_THREAD_ID: id }, callTool: async (pipe, caller, tool, args) => {
    calls.push({ pipe, caller, tool, args });
    return tool === 'read_thread' ? { thread: { id, hostId: 'local', status } } : { archived: args.archived };
  } });
  try {
    const archive = await findDesktopArchive({ homeDir: dir, nativeId: id }, dir);
    assert.deepEqual(await archive(true), { archived: true });
    assert.equal(calls[1].tool, 'set_thread_archived');
    assert.deepEqual(calls[1].args, { threadId: id, hostId: 'local', archived: true });
    status = { type: 'active', activeFlags: ['waitingOnApproval'] };
    await assert.rejects(archive(true), /実行中/);
    assert.equal(calls.length, 3);
    assert.equal(await findDesktopArchive({ homeDir: os.tmpdir(), nativeId: id }, dir), null);
    await assert.rejects(archive('invalid'), /不正/);
  } finally { await bridge.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
test('native tool client frames requests, binds caller metadata and fails on provider errors', async () => {
  const dir = await fs.mkdtemp('/tmp/canban-tool-test-'), pipe = path.join(dir, 'b.sock');
  let success = true;
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4 || buffer.length < 4 + buffer.readUInt32LE()) return;
      const request = JSON.parse(buffer.subarray(4).toString());
      assert.equal(request.params.threadId, id);
      assert.equal(request.params.callerSource, 'codex');
      assert.equal(request.params.tool, 'set_thread_archived');
      const result = { success, contentItems: [{ type: 'inputText', text: success ? '{"archived":true}' : 'provider failed' }] };
      const payload = Buffer.from(JSON.stringify({ id: request.id, result })), header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
      socket.end(Buffer.concat([header, payload]));
    });
  });
  await new Promise(resolve => server.listen(pipe, resolve));
  try {
    assert.deepEqual(await desktopTool(pipe, id, 'set_thread_archived', { threadId: id, archived: true }), { archived: true });
    success = false;
    await assert.rejects(desktopTool(pipe, id, 'set_thread_archived', {}), /provider failed/);
  } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); }
});

// A Codex-launched Canban MCP process can call the desktop's App Tools.
// Chrome talks only to this narrow, same-user bridge; it never impersonates a
// Codex process or bypasses the desktop's signed-process authorization.
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { codexHome } from './sources/codex.mjs';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_FRAME = 8 * 1024 * 1024;

export function desktopTool(pipe, callerId, tool, args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    let buffer = Buffer.alloc(0), settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Codexデスクトップの操作がタイムアウトしました。状態を再取得してください')), timeoutMs);
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(new Error('Codexデスクトップとの接続が閉じられました')));
    socket.on('connect', () => {
      const payload = Buffer.from(JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/call', params: {
        namespace: 'codex_app', tool, arguments: args, callerSource: 'codex',
        threadId: callerId, callId: `canban-${randomUUID()}`, turnId: `canban-${randomUUID()}`,
      } }));
      const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
      socket.write(Buffer.concat([header, payload]));
    });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const size = buffer.readUInt32LE();
      if (size > MAX_FRAME) return finish(new Error('Codexデスクトップの応答が大きすぎます'));
      if (buffer.length < size + 4) return;
      try {
        const message = JSON.parse(buffer.subarray(4, size + 4).toString());
        if (message.id !== 1) return finish(new Error('Codexデスクトップの応答IDが一致しません'));
        if (message.error) throw new Error(message.error.message || 'Codexデスクトップの操作に失敗しました');
        const result = message.result;
        const content = result?.contentItems?.filter(item => item.type === 'inputText').map(item => item.text).join('\n') || '';
        if (result?.success !== true) throw new Error(content || 'Codexデスクトップの操作に失敗しました');
        let value; try { value = JSON.parse(content); } catch { value = { text: content }; }
        finish(null, value);
      } catch (error) { finish(error); }
    });
  });
}

export async function startDesktopBridge({ dataDir, env = process.env, callTool = desktopTool } = {}) {
  const pipe = env.CODEX_APP_TOOLS_PIPE_PATH, callerId = env.CODEX_THREAD_ID;
  if (!pipe || !UUID.test(callerId || '') || env.CANBAN_CLIENT === 'canban-chrome') return null;
  const dir = path.join(dataDir, 'agent-bridges');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const homeDir = await fs.realpath(env.CODEX_HOME || codexHome());
  // Unix socket paths on macOS are limited to 104 bytes. Keep the socket in a
  // private temporary directory, and only the discovery record in Canban data.
  const socketDir = await fs.mkdtemp(path.join(process.env.TMPDIR || '/tmp', 'canban-agent-'));
  await fs.chmod(socketDir, 0o700);
  const socketPath = path.join(socketDir, 'b.sock');
  const recordPath = path.join(dir, `${process.pid}-${randomUUID()}.json`);
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let data = '', handled = false;
    socket.setTimeout(20000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {
      if (handled) return;
      data += chunk.toString();
      if (data.length > 4096) { socket.destroy(); return; }
      if (!data.includes('\n')) return;
      handled = true;
      void (async () => {
        try {
          const request = JSON.parse(data.slice(0, data.indexOf('\n')));
          if (!UUID.test(request.threadId || '') || typeof request.archived !== 'boolean') throw new Error('セッション操作が不正です');
          const target = await callTool(pipe, callerId, 'read_thread', { threadId: request.threadId, hostId: 'local', turnLimit: 1, maxOutputCharsPerItem: 1 });
          if (target.thread?.id !== request.threadId || target.thread?.hostId !== 'local') throw new Error('Codexデスクトップの対象セッションを確認できません');
          const status = typeof target.thread.status === 'string' ? target.thread.status : target.thread.status?.type;
          if (['active', 'running', 'waiting'].includes(status)) throw new Error('実行中・入力待ちのセッションはCodexで停止してから操作してください');
          const result = await callTool(pipe, callerId, 'set_thread_archived', { threadId: request.threadId, hostId: 'local', archived: request.archived });
          socket.end(JSON.stringify({ result }) + '\n');
        } catch (error) { socket.end(JSON.stringify({ error: error.message }) + '\n'); }
      })();
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await fs.chmod(socketPath, 0o600);
  await fs.writeFile(recordPath, JSON.stringify({ socketPath, homeDir }), { mode: 0o600 });
  server.unref();
  return { close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(recordPath, { force: true });
    await fs.rm(socketDir, { recursive: true, force: true });
  } };
}

export async function findDesktopArchive(session, dataDir, { timeoutMs = 20000 } = {}) {
  const dir = path.join(dataDir, 'agent-bridges');
  const home = await fs.realpath(session.homeDir || codexHome());
  const entries = await fs.readdir(dir).catch(() => []);
  for (const entry of entries.filter(name => name.endsWith('.json'))) {
    const record = await fs.readFile(path.join(dir, entry), 'utf8').then(JSON.parse).catch(() => null);
    if (record?.homeDir !== home || typeof record.socketPath !== 'string') continue;
    // Dead MCP servers can leave records after a crash. Probe before choosing;
    // never retry a mutation through another bridge after an unknown outcome.
    const alive = await new Promise(resolve => {
      const socket = net.createConnection(record.socketPath);
      const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 300);
      socket.once('error', () => { clearTimeout(timer); resolve(false); });
      socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    });
    if (!alive) continue;
    return archived => new Promise((resolve, reject) => {
      const socket = net.createConnection(record.socketPath);
      let data = '', settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true; clearTimeout(timer); socket.destroy();
        error ? reject(error) : resolve(result);
      };
      const timer = setTimeout(() => finish(new Error('Codexとの連携がタイムアウトしました。状態を再取得してください')), timeoutMs);
      socket.on('error', error => finish(error));
      socket.on('close', () => finish(new Error('Codexとの連携が切断されました')));
      socket.on('connect', () => socket.write(JSON.stringify({ threadId: session.nativeId, archived }) + '\n'));
      socket.on('data', chunk => {
        data += chunk.toString();
        if (data.length > MAX_FRAME) return finish(new Error('Codexの応答が大きすぎます'));
        if (!data.includes('\n')) return;
        try {
          const message = JSON.parse(data.slice(0, data.indexOf('\n')));
          if (message.error) return finish(new Error(message.error));
          finish(null, message.result);
        } catch (error) { finish(error); }
      });
    });
  }
  return null;
}

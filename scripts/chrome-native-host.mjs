#!/usr/bin/env node
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FrameDecoder, encodeNativeResponse } from '../server/native-messaging.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (...parts) => process.stderr.write(`[canban chrome] ${parts.join(' ')}\n`);
const child = spawn('/bin/sh', [path.join(root, 'scripts', 'launch.sh')], {
  cwd: root,
  env: { ...process.env, CANBAN_CLIENT: 'canban-chrome' },
  stdio: ['pipe', 'pipe', 'inherit'],
});
const decoder = new FrameDecoder();
const waiting = [];
const pending = new Map();
const initId = '__canban_chrome_host_init__';
let ready = false;
let closed = false;

function reply(message) {
  for (const frame of encodeNativeResponse(message)) process.stdout.write(frame);
}

function forward(message) {
  if (!message || message.jsonrpc !== '2.0' || message.id == null || typeof message.method !== 'string') {
    if (message?.id != null) reply({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Invalid JSON-RPC request' } });
    return;
  }
  if (message.method !== 'tools/call') {
    reply({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Chrome bridge only accepts tools/call' } });
    return;
  }
  pending.set(JSON.stringify(message.id), message.id);
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

const stdout = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
stdout.on('line', (line) => {
  if (closed) return;
  let message;
  try { message = JSON.parse(line); } catch { log('ignored invalid MCP stdout line'); return; }
  if (message.id === initId) {
    if (message.error) {
      log(`MCP initialize failed: ${message.error.message || 'unknown error'}`);
      child.kill('SIGTERM');
      return;
    }
    ready = true;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    for (const request of waiting.splice(0)) forward(request);
    return;
  }
  if (message.id != null) pending.delete(JSON.stringify(message.id));
  reply(message);
});

function stopHost(reason) {
  if (closed) return;
  closed = true;
  const ids = new Set([...pending.values(), ...waiting.splice(0).map((request) => request?.id).filter((id) => id != null)]);
  for (const id of ids) reply({ jsonrpc: '2.0', id, error: { code: -32000, message: reason } });
  pending.clear();
  process.stdin.destroy();
  process.stdout.end();
}
child.stdin.on('error', (error) => {
  log(`MCP stdin failed: ${error.message}`);
  stopHost('Canban server connection failed');
  child.kill('SIGTERM');
});
child.once('error', (error) => {
  log(`could not start MCP server: ${error.message}`);
  process.exitCode = 1;
  stopHost('Could not start Canban server');
});
child.once('exit', (code, signal) => {
  stopHost(`Canban server stopped (${signal || code})`);
  if (code) log(`MCP server exited with ${code}`);
});

process.stdin.on('data', (chunk) => {
  try {
    for (const message of decoder.push(chunk)) {
      if (!ready) waiting.push(message);
      else forward(message);
    }
  } catch (error) {
    log(error.message);
    process.exitCode = 1;
    process.stdin.pause();
    child.kill('SIGTERM');
  }
});
process.stdin.on('end', () => {
  if (closed) return;
  child.stdin.end();
  child.kill('SIGTERM');
});
process.stdin.on('error', (error) => log(`stdin error: ${error.message}`));

child.stdin.write(`${JSON.stringify({
  jsonrpc: '2.0',
  id: initId,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'canban-chrome', version: '0.1.0' },
  },
})}\n`);

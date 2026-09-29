#!/usr/bin/env node
// Development host that emulates the Codex MCP Apps host:
// spawns the real MCP server over stdio, renders the ui:// resource in a sandboxed
// iframe, and relays `ui/initialize` / `tools/call` between them.
// Usage: CANBAN_DATA_DIR=/tmp/sk node tests/dev-host.mjs [port]
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || 4517);

const child = spawn('/bin/sh', [path.join(root, 'scripts', 'launch.sh')], { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
let nextId = 1;
const waiting = new Map();
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  const m = JSON.parse(line);
  waiting.get(m.id)?.(m);
  waiting.delete(m.id);
});
function rpc(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve) => waiting.set(id, resolve));
}
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: process.env.CANBAN_DEV_CLIENT || 'dev-host', version: '0' } });

const HOST_PAGE = (theme) => `<!doctype html><meta charset="utf-8"><title>Canban dev host</title>
<style>html,body{margin:0;height:100%;background:${theme === 'dark' ? '#111' : '#eee'}}iframe{border:0;width:100%;height:100%}</style>
<iframe id="app" sandbox="allow-scripts allow-forms allow-popups"></iframe>
<script>
const theme = ${JSON.stringify(theme)};
const frame = document.getElementById('app');
fetch('/resource').then(r => r.json()).then(res => { frame.srcdoc = res.contents[0].text; });
window.addEventListener('message', async (ev) => {
  if (ev.source !== frame.contentWindow) return;
  const m = ev.data; if (!m || m.jsonrpc !== '2.0' || m.id == null) return;
  const reply = (r) => frame.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, ...r }, '*');
  if (m.method === 'ui/initialize') return reply({ result: { protocolVersion: '2026-01-26', hostInfo: { name: 'dev-host' }, hostCapabilities: {}, hostContext: { theme, displayMode: 'fullscreen', locale: 'ja-JP' } } });
  if (m.method === 'tools/call') { const r = await fetch('/rpc', { method: 'POST', body: JSON.stringify(m.params) }).then(r => r.json()); return reply(r.error ? { error: r.error } : { result: r.result }); }
  if (m.method === 'ui/open-link') { console.log('open-link', m.params.url); return reply({ result: {} }); }
  reply({ result: {} });
});
</script>`;

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (url.pathname === '/resource') {
      const r = await rpc('resources/read', { uri: 'ui://canban/board.html' });
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(r.result));
    }
    if (url.pathname === '/rpc' && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      const r = await rpc('tools/call', JSON.parse(body));
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(r));
    }
    if (url.pathname === '/direct') {
      // Same UI served top-level with a window.openai shim (for screenshots / debugging).
      const r = await rpc('resources/read', { uri: 'ui://canban/board.html' });
      const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
      const shim = `<script>window.openai={theme:${JSON.stringify(theme)},displayMode:'fullscreen',
        callTool:(name,args)=>fetch('/rpc',{method:'POST',body:JSON.stringify({name,arguments:args})}).then(r=>r.json()).then(r=>{if(r.error)throw new Error(r.error.message);return r.result}),
        openExternal:({href})=>{console.log('open',href);return Promise.resolve()}};</script>`;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(r.result.contents[0].text.replace('<head>', `<head>${shim}`));
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(HOST_PAGE(url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'));
  })
  .listen(port, '127.0.0.1', () => console.log(`dev host: http://localhost:${port}/`));

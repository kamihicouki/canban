// Read-only evidence of the profile already opened by Claude. Matching the
// open file's inode prevents a changed symlink from impersonating the old app.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { claudeDesktopRoots } from './accounts.mjs';

const runCommand = (bin, args) => new Promise((resolve, reject) => execFile(bin, args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
export async function inspectDesktopRuntime(plan, { run = runCommand } = {}) {
  const processes = await run('/bin/ps', ['-axo', 'pid=,command=']);
  const lines = processes.split('\n').filter(line => /\/Claude\.app\/Contents\/(?:MacOS|Frameworks)\//.test(line));
  const pids = lines.map(line => line.trim().split(/\s+/)[0]);
  const mainPids = lines.filter(line => /^MacOS\/Claude(?:\s|$)/.test(line.split('/Claude.app/Contents/')[1] || '')).map(line => line.trim().split(/\s+/)[0]);
  if (!pids.length) return { running: false, profileDir: null };
  let output;
  try { output = await run('/usr/sbin/lsof', ['-a', '-p', pids.join(','), '-FpfinD']); }
  catch { return { running: true, profileDir: null }; }
  const roots = await claudeDesktopRoots();
  const dirs = [...new Set(await Promise.all(roots.map(r => fs.realpath(r.dir).catch(() => null))))].filter(Boolean);
  const loaded = new Set();
  const byPid = new Map();
  let inode, device, pid;
  for (const line of output.split('\n')) {
    if (line[0] === 'p') { pid = line.slice(1); inode = device = null; }
    else if (line[0] === 'f') { inode = device = null; }
    else if (line[0] === 'i') inode = line.slice(1);
    else if (line[0] === 'D') device = line.slice(1);
    else if (line[0] === 'n' && inode) {
      const name = line.slice(1);
      for (const dir of dirs) {
        let file;
        if (name === dir || name.startsWith(dir + path.sep)) file = name;
        else if (name.startsWith(plan.defaultDir + path.sep)) file = path.join(dir, path.relative(plan.defaultDir, name));
        else continue;
        const st = await fs.stat(file, { bigint: true }).catch(() => null);
        if (st && String(st.ino) === inode && (!device || (/^(0x)?[0-9a-f]+$/i.test(device) && BigInt('0x' + device.replace(/^0x/, '')) === st.dev))) {
          loaded.add(dir);
          if (!byPid.has(pid)) byPid.set(pid, new Set());
          byPid.get(pid).add(dir);
        }
      }
    }
  }
  return { running: true, profileDir: loaded.size === 1 && mainPids.length && mainPids.every(p => byPid.get(p)?.size === 1) ? [...loaded][0] : null };
}

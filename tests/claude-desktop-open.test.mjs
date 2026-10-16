// Every way Canban opens Claude Desktop must go through openClaudeDesktop
// (server/claude-desktop-open.mjs), which merges every account's sessions into the
// sidebar. A new path that opens claude:// some other way fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openUrl, setRunner } from '../server/launcher.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function sources(dir) {
  const out = [];
  for (const d of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...await sources(rel));
    else if (/\.(m?js)$/.test(d.name)) out.push([rel, await fs.readFile(path.join(root, rel), 'utf8')]);
  }
  return out;
}

test('openUrl refuses claude:// links; only the gateway opens Claude Desktop', async () => {
  const calls = [];
  const prev = setRunner(async (f, a) => calls.push([f, ...a]));
  try {
    await assert.rejects(openUrl('claude://code/new'), /openClaudeDesktop/);
    await assert.rejects(openUrl('CLAUDE://resume?session=x'), /openClaudeDesktop/);
    assert.deepEqual(calls, []);
  } finally { setRunner(prev); }
});

test('no server, UI or extension code opens an app link outside the gateway', async () => {
  const files = [...await sources('server'), ...await sources('ui'), ...await sources('chrome').catch(() => []), ...await sources('scripts')];
  const offenders = [];
  for (const [file, text] of files) {
    if (/\bopenAppUrl\b/.test(text) && !['server/launcher.mjs', 'server/claude-desktop-open.mjs'].includes(file)) offenders.push(`${file}: openAppUrl`);
    // Launching the OS "open" / "xdg-open" directly would skip the gateway.
    if (/(execFile|spawn|execFileSync|spawnSync|runner)\(\s*['"`](\/usr\/bin\/)?(open|xdg-open)['"`]/.test(text) && file !== 'server/launcher.mjs') offenders.push(`${file}: OS open`);
    // A claude:// link handed to the browser or the host would skip it too.
    if (/(location\.(href|assign)|window\.open|openExternal|ui\/open-link)[^\n]*claude:/.test(text)) offenders.push(`${file}: claude:// in the browser`);
  }
  assert.deepEqual(offenders, []);
});

#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] || path.join(root, 'dist', 'canban-web-store.zip'));
const buildScript = path.join(root, 'scripts', 'build-chrome.mjs');
if (!fs.existsSync(buildScript)) throw new Error('Chrome 拡張本体の変更を先に取り込んでください（scripts/build-chrome.mjs が必要です）');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-store-'));
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
  return result.stdout;
}
try {
  run(process.execPath, [buildScript, '--outdir', temp], root);
  const manifest = JSON.parse(fs.readFileSync(path.join(temp, 'manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3 || !/^\d+(\.\d+){0,3}$/.test(manifest.version) || manifest.version.split('.').some(n => +n > 65535) || manifest.version.split('.').every(n => +n === 0)) throw new Error('Invalid Chrome manifest version');
  if (JSON.stringify(manifest.permissions) !== '["nativeMessaging"]' || manifest.host_permissions?.length || manifest.content_scripts?.length) throw new Error('Permissions changed: update and review CHROMEWEBSTORE.md before packaging');
  manifest.homepage_url = 'https://github.com/kamihicouki/canban';
  manifest.icons = {};
  fs.mkdirSync(path.join(temp, 'icons'));
  for (const size of [16, 48, 128]) {
    const filename = `icons/icon-${size}.png`;
    const bytes = fs.readFileSync(path.join(root, 'chrome', filename));
    if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) !== size || bytes.readUInt32BE(20) !== size) throw new Error(`Invalid icon: ${filename}`);
    fs.writeFileSync(path.join(temp, filename), bytes);
    manifest.icons[size] = filename;
  }
  manifest.action.default_icon = manifest.icons;
  manifest.content_security_policy = { extension_pages: "script-src 'self'; object-src 'none'; connect-src 'none'" };
  fs.writeFileSync(path.join(temp, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const html = fs.readFileSync(path.join(temp, 'board.html'), 'utf8');
  if (/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(html) || /\son[a-z]+\s*=/i.test(html) || /(?:src|href)\s*=\s*["']https?:/i.test(html)) throw new Error('Extension HTML contains inline code or remote resources');
  const files = ['manifest.json', 'board.html', 'board.css', 'board.js', 'service-worker.js', 'canban.png', ...Object.values(manifest.icons)].sort();
  // Explicit allowlist: never bundle the native host, session data, secrets or developer docs.
  const archive = path.join(temp, 'package.zip');
  run('zip', ['-X', '-q', archive, ...files], temp);
  run('unzip', ['-t', archive], temp);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(archive, output);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex');
  fs.writeFileSync(`${output}.sha256`, `${digest}  ${path.basename(output)}\n`);
  process.stdout.write(`${output}\nversion: ${manifest.version}\nsha256: ${digest}\n`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

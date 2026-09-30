#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--outdir');
const outDir = path.resolve(outIndex >= 0 ? args[outIndex + 1] : path.join(root, 'dist', 'chrome'));
if (outIndex >= 0 && (!args[outIndex + 1] || args[outIndex + 1].startsWith('--'))) throw new Error('--outdir needs a path');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
let html = fs.readFileSync(path.join(root, 'ui', 'board.html'), 'utf8').replaceAll('__CANBAN_VERSION__', pkg.version);
const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/gi)];
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
if (styles.length !== 1 || scripts.length !== 1) throw new Error('Chrome build expects one inline style block and one inline board script');
const css = styles[0][1].trim();
const js = scripts[0][1].trim();
html = html.replace(styles[0][0], '<link rel="stylesheet" href="board.css">');
html = html.replace(scripts[0][0], '<script src="board.js" defer></script>');

const manifest = {
  manifest_version: 3,
  name: 'Canban',
  version: pkg.version,
  description: 'Codex / Claude Code のセッションをカンバンで管理します。',
  permissions: ['nativeMessaging'],
  background: { service_worker: 'service-worker.js' },
  action: { default_title: 'Canban' },
  icons: { 128: 'canban.png' },
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, 'board.html'), html);
fs.writeFileSync(path.join(outDir, 'board.css'), `${css}\n`);
fs.writeFileSync(path.join(outDir, 'board.js'), `${js}\n`);
fs.copyFileSync(path.join(root, 'chrome', 'service-worker.js'), path.join(outDir, 'service-worker.js'));
fs.copyFileSync(path.join(root, 'assets', 'canban.png'), path.join(outDir, 'canban.png'));
process.stdout.write(`${outDir}\n`);

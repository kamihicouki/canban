#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const extensionIndex = args.indexOf('--extension-id');
const extensionId = extensionIndex >= 0 ? args[extensionIndex + 1] : '';
const dryRun = args.includes('--dry-run');
const uninstall = args.includes('--uninstall');
if (!/^[a-p]{32}$/.test(extensionId || '')) {
  process.stderr.write('使い方: node scripts/install-chrome-native-host.mjs [--dry-run] [--uninstall] --extension-id <Chrome拡張ID>\n');
  process.exit(2);
}

let hostsDir;
if (process.platform === 'darwin') hostsDir = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
else if (process.platform === 'linux') hostsDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'google-chrome', 'NativeMessagingHosts');
else throw new Error('Chrome Native Messaging の登録はmacOS／Linuxに対応しています');

const hostName = 'com.kamihicouki.canban';
const manifestPath = path.join(hostsDir, `${hostName}.json`);
const manifest = {
  name: hostName,
  description: 'Canban Native Messaging Host',
  path: path.join(root, 'scripts', 'chrome-native-host.sh'),
  type: 'stdio',
  allowed_origins: [`chrome-extension://${extensionId}/`],
};

if (dryRun) {
  process.stdout.write(`${JSON.stringify({ action: uninstall ? 'uninstall' : 'install', manifestPath, manifest }, null, 2)}\n`);
  process.exit(0);
}

if (uninstall) {
  try {
    const installed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!installed.allowed_origins?.includes(manifest.allowed_origins[0])) throw new Error('登録内容の拡張IDが一致しないため削除しません');
    fs.rmSync(manifestPath);
    process.stdout.write(`Native Messagingを解除しました: ${manifestPath}\n`);
  } catch (error) {
    if (error.code === 'ENOENT') process.stdout.write('Native Messagingは登録されていません\n');
    else throw error;
  }
} else {
  fs.mkdirSync(hostsDir, { recursive: true });
  const tempPath = `${manifestPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, manifestPath);
  process.stdout.write(`Native Messagingを登録しました: ${manifestPath}\n`);
}

#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveDataDirectory } from '../server/data-directory.mjs';
import { chromeRuntimeDirectory, installChromeRuntime } from './chrome-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostName = 'com.kamihicouki.canban_main_test';

function chromeHostsDirectory() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
  if (process.platform === 'linux') return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'google-chrome', 'NativeMessagingHosts');
  throw new Error('Chrome Native Messaging の登録はmacOS／Linuxに対応しています');
}

export function updateLocalChrome({ repository = root, hostsDirectory = chromeHostsDirectory(), runtimeDirectory = chromeRuntimeDirectory(hostName) } = {}) {
  const base = path.join(repository, '.local', 'chrome-main-test');
  const config = JSON.parse(fs.readFileSync(path.join(base, 'config.json'), 'utf8'));
  const dataDirectory = resolveDataDirectory({ root: repository });
  const extensionDirectory = path.join(repository, 'dist', 'chrome');
  const extensionId = crypto.createHash('sha256').update(Buffer.from(config.publicKey, 'base64')).digest('hex')
    .slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
  if (extensionId !== config.extensionId) throw new Error('テスト拡張の公開鍵とIDが一致しません');

  function run(command, args) {
    const result = spawnSync(command, args, { cwd: repository, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
    return result.stdout.trim();
  }
  function writeAtomic(filename, content, mode = 0o600) {
    const temporary = `${filename}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, content, { mode });
    fs.renameSync(temporary, filename);
  }

  const lock = path.join(base, 'update.lock');
  try { fs.mkdirSync(lock); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('別のmainテスト版更新が実行中です');
    throw error;
  }
  let staging;
  try {
    if (run('git', ['branch', '--show-current']) !== 'main') throw new Error('通常checkoutをmainに切り替えてから実行してください');
    if (run('git', ['status', '--porcelain', '--untracked-files=no'])) throw new Error('mainに未コミットの変更があります');
    const sha = run('git', ['rev-parse', 'HEAD']);
    fs.mkdirSync(path.dirname(extensionDirectory), { recursive: true });
    staging = fs.mkdtempSync(path.join(path.dirname(extensionDirectory), '.main-test-build-'));
    run(process.execPath, ['scripts/build-chrome.mjs', '--outdir', staging]);

    const manifest = JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf8'));
    manifest.key = config.publicKey;
    manifest.name = `Canban Main Test ${manifest.version}`;
    manifest.description = 'ローカルmain checkoutのCanbanをテストします。';
    manifest.action.default_title = manifest.name;
    fs.writeFileSync(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const boardPath = path.join(staging, 'board.js');
    const board = fs.readFileSync(boardPath, 'utf8');
    const originalHost = "chrome.runtime.connectNative('com.kamihicouki.canban')";
    if (board.split(originalHost).length !== 2) throw new Error('Native Messaging接続先が想定と異なります');
    fs.writeFileSync(boardPath, board.replace(originalHost, `chrome.runtime.connectNative('${hostName}')`));
    if (sha !== run('git', ['rev-parse', 'HEAD']) || run('git', ['status', '--porcelain', '--untracked-files=no'])) {
      throw new Error('ビルド中にcheckoutが変更されました。もう一度実行してください');
    }

    fs.mkdirSync(extensionDirectory, { recursive: true });
    for (const filename of fs.readdirSync(staging)) writeAtomic(path.join(extensionDirectory, filename), fs.readFileSync(path.join(staging, filename)), 0o644);
    const { launcher } = installChromeRuntime({ repository, runtimeDirectory, sha, dataDirectory });
    fs.mkdirSync(hostsDirectory, { recursive: true });
    writeAtomic(path.join(hostsDirectory, `${hostName}.json`), `${JSON.stringify({
      name: hostName, description: 'Canban main checkout local test', path: launcher,
      type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`],
    }, null, 2)}\n`);
    const result = { ref: 'main', sha, version: manifest.version, extensionId, extensionDirectory,
      sourceDirectory: repository, runtimeDirectory, dataDirectory, updatedAt: new Date().toISOString() };
    writeAtomic(path.join(base, 'build.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('使い方: npm run update:chrome（ローカルmainから固定パスへビルド）');
  process.stdout.write(`${JSON.stringify(updateLocalChrome(), null, 2)}\n`);
}

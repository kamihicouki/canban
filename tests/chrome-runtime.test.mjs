import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { chromeRuntimeDirectory } from '../scripts/chrome-runtime.mjs';
import { FrameDecoder, encodeNativeResponse } from '../server/native-messaging.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('installed Chrome host serves shared data without access to the original Documents checkout', { timeout: 30000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-chrome-runtime-'));
  let child;
  try {
    const repository = path.join(temp, 'Documents', 'repo', 'canban');
    const home = path.join(temp, "user's home");
    fs.mkdirSync(repository, { recursive: true });
    fs.mkdirSync(path.join(home, '.canban'), { recursive: true });
    for (const entry of ['server', 'scripts', 'ui', 'assets', 'package.json']) fs.cpSync(path.join(source, entry), path.join(repository, entry), { recursive: true });
    fs.mkdirSync(path.join(repository, '.local'));
    fs.writeFileSync(path.join(repository, '.local', 'config.json'), '{invalid private configuration');
    fs.writeFileSync(path.join(repository, 'untracked-secret'), 'private data');
    const extensionId = 'a'.repeat(32);
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share') };
    delete env.CANBAN_DATA_DIR;
    const installed = spawnSync(process.execPath, [path.join(repository, 'scripts', 'install-chrome-native-host.mjs'), '--extension-id', extensionId], { env, encoding: 'utf8' });
    assert.equal(installed.status, 0, installed.stderr);
    const hosts = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts') : path.join(env.XDG_CONFIG_HOME, 'google-chrome', 'NativeMessagingHosts');
    const host = JSON.parse(fs.readFileSync(path.join(hosts, 'com.kamihicouki.canban.json')));
    const runtimeDirectory = chromeRuntimeDirectory(host.name, { home, env });
    assert.equal(host.path, path.join(runtimeDirectory, 'native-host.sh'));
    assert.deepEqual(host.allowed_origins, [`chrome-extension://${extensionId}/`]);
    const snapshot = fs.readdirSync(runtimeDirectory).find((name) => fs.statSync(path.join(runtimeDirectory, name)).isDirectory());
    assert.equal(fs.existsSync(path.join(runtimeDirectory, snapshot, '.local')), false);
    assert.equal(fs.existsSync(path.join(runtimeDirectory, snapshot, 'untracked-secret')), false);
    // Removing the source reproduces the unavailable-program failure without changing OS permissions.
    fs.renameSync(repository, `${repository}-unavailable`);
    child = spawn(host.path, host.allowed_origins, { env: { ...env, PATH: '/usr/bin:/bin', CANBAN_LIVE: '0', CANBAN_BACKGROUND: '0', CANBAN_SEARCH_INDEX: '0' } });
    const exit = new Promise((resolve) => child.once('close', resolve));
    const decoder = new FrameDecoder();
    let stderr = '';
    child.stderr.on('data', (bytes) => { stderr += bytes; });
    child.stdin.on('error', () => {});
    const response = new Promise((resolve, reject) => {
      // Cold process startup can be delayed by the real-session reader fixture and OS I/O.
      // This verifies installation independence, not a five-second performance budget.
      const timer = setTimeout(() => reject(new Error(`Native Host timed out: ${stderr}`)), 15000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', () => { clearTimeout(timer); reject(new Error(`Native host has exited: ${stderr}`)); });
      child.stdout.on('data', (bytes) => {
        for (const message of decoder.push(bytes)) if (message.id === 1) { clearTimeout(timer); resolve(message); }
      });
    });
    child.stdin.write(encodeNativeResponse({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'canban_get_ui_state', arguments: {} } })[0]);
    const message = await response;
    assert.deepEqual(message.result?.structuredContent?.result, { revision: 0, state: null });
    assert.ok(fs.existsSync(path.join(home, '.canban', 'canban.sqlite')));
    assert.equal(fs.existsSync(repository), false, 'the host must not recreate or depend on its source checkout');
    child.stdin.end();
    await exit;
  } finally {
    child?.kill();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

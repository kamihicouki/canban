import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

export function chromeRuntimeDirectory(hostName, { home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const base = platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Canban')
    : platform === 'linux' ? path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'canban')
    : null;
  if (!base) throw new Error('Chrome Native Messaging の登録はmacOS／Linuxに対応しています');
  return path.join(base, 'native-hosts', hostName);
}

// Chrome's child processes cannot assume access to a checkout in Documents.
// Keep each committed runtime immutable so an update cannot mix code in a running host.
export function installChromeRuntime({ repository, runtimeDirectory, sha, dataDirectory } = {}) {
  function run(command, args, options = {}) {
    const result = spawnSync(command, args, { cwd: repository, maxBuffer: 32 * 1024 * 1024, ...options });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command}: ${result.stderr?.toString()}`);
    return result.stdout;
  }
  if (!sha && fs.existsSync(path.join(repository, '.git'))) {
    if (run('git', ['status', '--porcelain', '--untracked-files=no']).length) throw new Error('未コミットの変更があります');
    sha = run('git', ['rev-parse', 'HEAD']).toString().trim();
  }
  const snapshot = path.join(runtimeDirectory, sha || crypto.randomUUID());
  fs.mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(runtimeDirectory, '.runtime-'));
  try {
    if (sha) {
      run('tar', ['-xf', '-', '-C', staging], { input: run('git', ['archive', '--format=tar', sha]) });
    } else {
      // Bare companion installations have no Git metadata. Copy only program files.
      for (const entry of ['server', 'ui', 'assets', 'scripts/chrome-native-host.sh', 'scripts/chrome-native-host.mjs', 'scripts/launch.sh', 'package.json', '.codex-plugin/plugin.json']) {
        const source = path.join(repository, entry);
        if (!fs.existsSync(source)) continue;
        fs.mkdirSync(path.dirname(path.join(staging, entry)), { recursive: true });
        fs.cpSync(source, path.join(staging, entry), { recursive: true });
      }
    }
    if (fs.existsSync(path.join(staging, '.local'))) throw new Error('Chrome実行ファイルにローカルデータが含まれています');
    const version = JSON.parse(fs.readFileSync(path.join(staging, 'package.json'), 'utf8')).version;
    for (const entry of ['scripts/chrome-native-host.sh', 'scripts/chrome-native-host.mjs', 'scripts/launch.sh', 'server/index.mjs']) {
      if (!fs.statSync(path.join(staging, entry)).isFile()) throw new Error(`Chrome実行ファイルがありません: ${entry}`);
    }
    if (!fs.existsSync(snapshot)) fs.renameSync(staging, snapshot);
    const launcher = path.join(runtimeDirectory, 'native-host.sh');
    const temporary = `${launcher}.${process.pid}.tmp`;
    const data = dataDirectory ? `export CANBAN_DATA_DIR=${shellQuote(dataDirectory)}\n` : '';
    fs.writeFileSync(temporary, `#!/bin/sh\n${data}export CANBAN_NODE=${shellQuote(process.execPath)}\nexec ${shellQuote(path.join(snapshot, 'scripts', 'chrome-native-host.sh'))}\n`, { mode: 0o700 });
    fs.renameSync(temporary, launcher);
    return { runtimeDirectory, snapshot, launcher, version, sha };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

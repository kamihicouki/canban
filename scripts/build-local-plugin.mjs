#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function buildLocalPlugin({ repository = root } = {}) {
  function run(command, args, options = {}) {
    const result = spawnSync(command, args, { cwd: repository, maxBuffer: 32 * 1024 * 1024, ...options });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command}: ${result.stderr?.toString()}`);
    return result.stdout;
  }
  if (run('git', ['branch', '--show-current']).toString().trim() !== 'main') throw new Error('通常checkoutのmainから配布物を作成してください');
  if (run('git', ['status', '--porcelain', '--untracked-files=no']).length) throw new Error('mainに未コミットの変更があります');
  if (run('git', ['ls-files', '.local']).length) throw new Error('.local の保存データをGit管理から除外してください');
  const sha = run('git', ['rev-parse', 'HEAD']).toString().trim();
  const outputDirectory = path.join(repository, 'dist', 'codex-plugin');
  fs.mkdirSync(path.dirname(outputDirectory), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(outputDirectory), '.plugin-build-'));
  try {
    run('tar', ['-xf', '-', '-C', staging], { input: run('git', ['archive', '--format=tar', sha]) });
    if (fs.existsSync(path.join(staging, '.local'))) throw new Error('配布物にローカルデータが含まれています');
    const version = JSON.parse(fs.readFileSync(path.join(staging, 'package.json'), 'utf8')).version;
    fs.rmSync(outputDirectory, { recursive: true, force: true });
    fs.renameSync(staging, outputDirectory);
    return { sha, version, outputDirectory };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('使い方: npm run build:plugin');
  process.stdout.write(`${JSON.stringify(buildLocalPlugin(), null, 2)}\n`);
}

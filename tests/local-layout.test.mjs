import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDataDirectory } from '../server/data-directory.mjs';
import { updateLocalChrome } from '../scripts/update-local-chrome.mjs';
import { buildLocalPlugin } from '../scripts/build-local-plugin.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value));

test('local data configuration, explicit override and installed copies resolve the same data', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-layout-'));
  try {
    const home = path.join(temp, 'home'), repository = path.join(temp, 'repository');
    const data = path.join(repository, '.local', 'data');
    fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(home); fs.mkdirSync(path.join(repository, '.git'));
    writeJson(path.join(repository, '.local', 'config.json'), { dataDirectory: 'data' });
    fs.symlinkSync(data, path.join(home, '.canban'));
    const installed = path.join(temp, 'installed-copy');
    fs.mkdirSync(path.join(installed, '.local'), { recursive: true });
    writeJson(path.join(installed, '.local', 'config.json'), { dataDirectory: 'accidental-copy' });
    assert.equal(resolveDataDirectory({ env: {}, home, root: repository }), fs.realpathSync(data));
    assert.equal(resolveDataDirectory({ env: {}, home, root: path.join(temp, 'installed-copy') }), fs.realpathSync(data));
    assert.equal(resolveDataDirectory({ env: { CANBAN_DATA_DIR: '/explicit/data' }, home, root: repository }), '/explicit/data');
    fs.unlinkSync(path.join(home, '.canban'));
    assert.equal(resolveDataDirectory({ env: {}, home, root: path.join(temp, 'installed-copy') }), path.join(home, '.canban'));
    writeJson(path.join(repository, '.local', 'config.json'), {});
    assert.throws(() => resolveDataDirectory({ env: {}, home, root: repository }), /dataDirectory/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('local Chrome update preserves the ID, shares repo data and refuses dirty or non-main checkouts', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-local-chrome-'));
  try {
    const repository = path.join(temp, 'repository'), hostsDirectory = path.join(temp, 'hosts');
    fs.mkdirSync(repository);
    for (const item of ['scripts', 'server', 'ui', 'assets', 'chrome', 'package.json', '.gitignore']) {
      fs.cpSync(path.join(source, item), path.join(repository, item), { recursive: true });
    }
    const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-b', 'main'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
    const base = path.join(repository, '.local', 'chrome-main-test');
    fs.mkdirSync(base, { recursive: true });
    writeJson(path.join(repository, '.local', 'config.json'), { dataDirectory: 'data' });
    const publicKey = Buffer.from('local-test-public-key').toString('base64');
    const extensionId = crypto.createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 32)
      .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
    writeJson(path.join(base, 'config.json'), { publicKey, extensionId });
    fs.writeFileSync(path.join(repository, '.local', 'private-data-sentinel'), 'private local data');
    fs.writeFileSync(path.join(repository, 'untracked-local-note'), 'untracked user note');
    const distribution = buildLocalPlugin({ repository });
    assert.equal(fs.existsSync(path.join(distribution.outputDirectory, '.local')), false);
    assert.equal(fs.existsSync(path.join(distribution.outputDirectory, 'untracked-local-note')), false);
    assert.equal(fs.existsSync(path.join(distribution.outputDirectory, '.git')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(distribution.outputDirectory, 'package.json'))).version, distribution.version);
    const result = updateLocalChrome({ repository, hostsDirectory });
    assert.equal(result.extensionId, extensionId);
    assert.equal(result.dataDirectory, path.join(repository, '.local', 'data'));
    assert.equal(result.sourceDirectory, repository);
    const manifest = JSON.parse(fs.readFileSync(path.join(result.extensionDirectory, 'manifest.json')));
    assert.equal(manifest.key, publicKey); assert.equal(manifest.version, result.version);
    assert.match(fs.readFileSync(path.join(result.extensionDirectory, 'board.js'), 'utf8'), /connectNative\('com\.kamihicouki\.canban_main_test'\)/);
    const host = JSON.parse(fs.readFileSync(path.join(hostsDirectory, 'com.kamihicouki.canban_main_test.json')));
    assert.equal(host.path, path.join(base, 'native-host.sh'));
    assert.deepEqual(host.allowed_origins, [`chrome-extension://${extensionId}/`]);
    assert.match(fs.readFileSync(host.path, 'utf8'), /CANBAN_DATA_DIR=.*\.local\/data/);
    assert.equal(fs.existsSync(path.join(base, 'update.lock')), false);
    fs.appendFileSync(path.join(repository, 'package.json'), '\n');
    assert.throws(() => updateLocalChrome({ repository, hostsDirectory }), /未コミット/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(base, 'build.json'))), result);
    git('checkout', '--', 'package.json'); git('checkout', '-b', 'feature');
    assert.throws(() => updateLocalChrome({ repository, hostsDirectory }), /main/);
    assert.equal(fs.existsSync(path.join(base, 'update.lock')), false);
    writeJson(path.join(base, 'config.json'), { publicKey, extensionId: 'a'.repeat(32) });
    assert.throws(() => updateLocalChrome({ repository, hostsDirectory }), /公開鍵とID/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

// Version sync: the three version files agree, and CHANGELOG.md / CHROMEWEBSTORE.md
// describe that version. scripts/bump-version.mjs keeps them in step.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION_FILES, bump, nextVersion, parseArgs, parseVersion, usedVersions } from '../scripts/bump-version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const versionOf = (dir, f) => JSON.parse(read(dir, f)).version;

test('package.json, manifest.json and .codex-plugin/plugin.json share one version', () => {
  const versions = Object.fromEntries(VERSION_FILES.map(f => [f, versionOf(root, f)]));
  assert.equal(new Set(Object.values(versions)).size, 1, `バージョンが揃っていません: ${JSON.stringify(versions)}（npm run bump で揃えてください）`);
});

test('the latest CHANGELOG.md heading is the current version', () => {
  const version = versionOf(root, 'package.json');
  const heading = /^## (\S+)/m.exec(read(root, 'CHANGELOG.md'))?.[1];
  assert.equal(heading, version, `CHANGELOG.md の先頭が ${heading} です。${version} の項目を追加してください（npm run bump）`);
});

test('CHROMEWEBSTORE.md mentions the current version', () => {
  const version = versionOf(root, 'package.json');
  assert.match(read(root, 'CHROMEWEBSTORE.md'), new RegExp(`^## .*\\b${version.replaceAll('.', '\\.')}\\b`, 'm'));
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-bump-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.codex-plugin'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{\n  "name": "canban",\n  "version": "1.2.3",\n  "private": true\n}\n');
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{\n  "manifest_version": "0.3",\n  "version": "1.2.3"\n}\n');
  fs.writeFileSync(path.join(dir, '.codex-plugin/plugin.json'), '{\n  "name": "canban",\n  "version": "1.2.3"\n}\n');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.3 — 2026-10-01\n\n- 前回\n');
  fs.writeFileSync(path.join(dir, 'CHROMEWEBSTORE.md'), '## ローカル統合版 1.2.0 — 2026-09-01\n\n## 内部実装版 1.2.3\n\n- 前回\n\n# Chrome Web Store — Canban\n');
  return dir;
}

test('bump updates all five files with a minimal diff', t => {
  const dir = fixture(t);
  const version = bump({ dir, kind: 'patch', summary: '要約', store: 'ストア向け', date: '2026-10-19', log() {} });
  assert.equal(version, '1.2.4');
  assert.equal(read(dir, 'package.json'), '{\n  "name": "canban",\n  "version": "1.2.4",\n  "private": true\n}\n');
  for (const f of VERSION_FILES) assert.equal(versionOf(dir, f), '1.2.4');
  assert.equal(read(dir, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.4 — 2026-10-19\n\n- 要約\n\n## 1.2.3 — 2026-10-01\n\n- 前回\n');
  assert.equal(read(dir, 'CHROMEWEBSTORE.md'), '## ローカル統合版 1.2.0 — 2026-09-01\n\n## 内部実装版 1.2.4\n\n- ストア向け\n\n## 内部実装版 1.2.3\n\n- 前回\n\n# Chrome Web Store — Canban\n');
});

test('store notes go above the current version even when its heading has no label', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'CHROMEWEBSTORE.md'), '## ローカル統合版 1.2.0\n\n## 1.2.3 — 2026-10-01\n\n- 統合\n\n## 内部実装版 1.2.2\n\n- 前回\n');
  bump({ dir, summary: '要約', log() {} });
  assert.equal(read(dir, 'CHROMEWEBSTORE.md'), '## ローカル統合版 1.2.0\n\n## 内部実装版 1.2.4\n\n- 要約\n\n## 1.2.3 — 2026-10-01\n\n- 統合\n\n## 内部実装版 1.2.2\n\n- 前回\n');
});

test('bump accepts minor and an explicit version, and refuses going backwards', t => {
  const dir = fixture(t);
  assert.equal(bump({ dir, kind: 'minor', summary: 'a', log() {} }), '1.3.0');
  assert.equal(bump({ dir, kind: '1.3.5', summary: 'b', log() {} }), '1.3.5');
  assert.throws(() => bump({ dir, kind: '1.3.5', summary: 'c', log() {} }), /より新しくありません/);
  assert.throws(() => bump({ dir, kind: 'patch', summary: ' ', log() {} }), /要約/);
});

test('--next-free skips numbers used by origin/main and open PRs', t => {
  const dir = fixture(t);
  assert.equal(bump({ dir, nextFree: true, used: new Set(['1.2.4', '1.2.6', '1.2.1']), summary: 'a', log() {} }), '1.2.7');
  assert.deepEqual(nextVersion(parseVersion('1.2.3'), 'patch', new Set(['1.2.4', '1.2.5'])), [1, 2, 6]);
});

test('--next-free never picks a number below one in use on another release line', t => {
  const dir = fixture(t);
  assert.equal(bump({ dir, nextFree: true, used: new Set(['1.3.5']), summary: 'a', log() {} }), '1.3.6');
  assert.equal(bump({ dir, kind: 'minor', nextFree: true, used: new Set(['1.4.2', '2.0.0']), summary: 'b', log() {} }), '2.1.0');
  assert.throws(() => bump({ dir, kind: '2.1.5', nextFree: true, used: new Set(['2.2.0']), summary: 'c', log() {} }), /使用中の 2\.2\.0/);
});

test('--store needs a value, so --dry-run is never taken as one', () => {
  assert.throws(() => parseArgs(['patch', '要約', '--store', '--dry-run']), /--store/);
  assert.throws(() => parseArgs(['patch', '要約', '--store']), /--store/);
  assert.deepEqual(parseArgs(['minor', '要', '約', '--store', 'ス', '--next-free', '--strict']), { kind: 'minor', summary: '要 約', store: 'ス', nextFree: true, strict: true });
});

test('usedVersions reads open PRs through refs/pull, covering forks, and warns about what it cannot read', () => {
  const logs = [];
  const exec = (cmd, args) => cmd === 'git' && args[0] === 'show' && args[1] === 'origin/main:package.json' ? '{"version":"0.29.22"}' : cmd === 'git' && args[0] === 'fetch' ? '' : null;
  assert.deepEqual([...usedVersions({ exec, log: m => logs.push(m) })], ['0.29.22']);
  assert.match(logs.join(), /open PR の一覧（gh）/);
  assert.throws(() => usedVersions({ exec, strict: true }), /open PR の一覧/);
  const withGh = (cmd, args) => cmd === 'gh' ? '[{"number":7,"title":"何か（0.29.23）"},{"number":8,"title":"Node 22.13.0 対応"}]' : args[1] === 'origin/pr/7:package.json' ? '{"version":"0.29.24"}' : exec(cmd, args);
  logs.length = 0;
  assert.deepEqual([...usedVersions({ exec: withGh, log: m => logs.push(m) })].sort(), ['0.29.22', '0.29.23', '0.29.24']);
  assert.match(logs.join(), /#8 の package\.json/);
  const staleFetch = (cmd, args) => cmd === 'git' && args[0] === 'fetch' ? null : withGh(cmd, args);
  assert.throws(() => usedVersions({ exec: staleFetch, strict: true }), /git fetch/);
});

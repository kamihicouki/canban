import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { publishChromeWebStore } from '../scripts/publish-chrome-web-store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = 'a'.repeat(32);
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-cws-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const zip = path.join(dir, 'package.zip');
  fs.writeFileSync(zip, Buffer.from('504b0304', 'hex'));
  return { CWS_EXTENSION_ID: id, CWS_PUBLISHER_ID: 'publisher', CWS_CLIENT_ID: 'test-client', CWS_CLIENT_SECRET: 'DO_NOT_LOG_SECRET', CWS_REFRESH_TOKEN: 'DO_NOT_LOG_REFRESH', CWS_PACKAGE_PATH: zip };
}
function mock(responses, requests) {
  return async (url, options = {}) => {
    requests.push({ url, ...options });
    assert.ok(responses.length, `Unexpected request: ${url}`);
    const value = responses.shift();
    return { ok: value.http ? value.http < 400 : true, status: value.http || 200, json: async () => value };
  };
}
test('store ZIP only contains extension assets and correct-sized icons', { skip: !fs.existsSync(path.join(root, 'scripts/build-chrome.mjs')) && 'Chrome implementation must be merged first' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-cws-zip-'));
  try {
    const zip = path.join(dir, 'release.zip');
    const result = spawnSync(process.execPath, ['scripts/package-chrome-web-store.mjs', zip], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const listing = spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8' });
    assert.equal(listing.status, 0, listing.stderr);
    assert.deepEqual(listing.stdout.trim().split('\n').sort(), ['board.css', 'board.html', 'board.js', 'canban.png', 'icons/icon-128.png', 'icons/icon-16.png', 'icons/icon-48.png', 'manifest.json', 'service-worker.js'].sort());
    const manifest = JSON.parse(spawnSync('unzip', ['-p', zip, 'manifest.json'], { encoding: 'utf8' }).stdout);
    assert.deepEqual(manifest.permissions, ['nativeMessaging']);
    assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'none'; connect-src 'none'");
    for (const size of [16, 48, 128]) {
      const bytes = spawnSync('unzip', ['-p', zip, manifest.icons[size]]).stdout;
      assert.equal(bytes.readUInt32BE(16), size);
      assert.equal(bytes.readUInt32BE(20), size);
    }
    assert.match(fs.readFileSync(`${zip}.sha256`, 'utf8'), /^[a-f0-9]{64}  release.zip\n$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('missing configuration fails before any network request', async () => {
  await assert.rejects(publishChromeWebStore({ env: {}, fetchImpl: () => assert.fail('Network called') }), /設定が不足/);
});
test('upload only does not publish, waits for async success and keeps secrets out of logs', async t => {
  const requests = [], logs = [], env = fixture(t);
  const result = await publishChromeWebStore({ env, fetchImpl: mock([{ access_token: 'ACCESS' }, {}, { uploadState: 'IN_PROGRESS' }, { lastAsyncUploadState: 'SUCCEEDED' }], requests), sleep: async () => {}, log: message => logs.push(message) });
  assert.deepEqual(result, { state: 'UPLOADED' });
  assert.equal(requests.length, 4);
  assert.equal(requests[2].url, `https://chromewebstore.googleapis.com/upload/v2/publishers/publisher/items/${id}:upload?uploadType=media`);
  assert.ok(requests.every(r => !r.url.endsWith(':publish')));
  assert.doesNotMatch(logs.join('\n'), /DO_NOT_LOG|ACCESS/);
});
test('upload failure never submits an item', async t => {
  const requests = [];
  await assert.rejects(publishChromeWebStore({ env: { ...fixture(t), CWS_MODE: 'publish' }, fetchImpl: mock([{ access_token: 'ACCESS' }, {}, { uploadState: 'FAILED' }], requests), log() {} }), /Upload did not succeed/);
  assert.ok(requests.every(r => !r.url.endsWith(':publish')));
});
test('an existing pending submission is preserved', async t => {
  const requests = [];
  await assert.rejects(publishChromeWebStore({ env: fixture(t), fetchImpl: mock([{ access_token: 'ACCESS' }, { submittedItemRevisionStatus: { state: 'PENDING_REVIEW' } }], requests) }), /existing submission/);
  assert.equal(requests.length, 2);
});
test('publish blocks warnings and reads back review state without claiming publication', async t => {
  const requests = [], logs = [];
  const result = await publishChromeWebStore({ env: { ...fixture(t), CWS_MODE: 'publish' }, fetchImpl: mock([{ access_token: 'ACCESS' }, {}, { uploadState: 'SUCCEEDED' }, { state: 'PENDING_REVIEW' }, { submittedItemRevisionStatus: { state: 'PENDING_REVIEW' } }], requests), log: message => logs.push(message) });
  assert.equal(result.state, 'PENDING_REVIEW');
  assert.deepEqual(JSON.parse(requests[3].body), { publishType: 'DEFAULT_PUBLISH', blockOnWarnings: true, skipReview: false });
  assert.match(logs.at(-1), /審査申請済み/);
  assert.doesNotMatch(logs.at(-1), /ストア掲載済み/);
});
test('inconclusive readback fails instead of reporting success', async t => {
  await assert.rejects(publishChromeWebStore({ env: { ...fixture(t), CWS_MODE: 'publish' }, fetchImpl: mock([{ access_token: 'ACCESS' }, {}, { uploadState: 'SUCCEEDED' }, { state: 'PENDING_REVIEW' }, {}], []), log() {} }), /readback was inconclusive/);
});

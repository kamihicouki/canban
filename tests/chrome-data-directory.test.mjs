import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDataDirectory } from '../server/data-directory.mjs';

test('Chrome uses user data even when launched from a configured development checkout', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-chrome-data-'));
  try {
    const root = path.join(temp, 'repo');
    const home = path.join(temp, 'home');
    const userData = path.join(home, '.canban');
    const developmentData = path.join(root, '.local', 'data');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.mkdirSync(developmentData, { recursive: true });
    fs.mkdirSync(userData, { recursive: true });
    const config = path.join(root, '.local', 'config.json');
    fs.writeFileSync(config, JSON.stringify({ dataDirectory: 'data' }));
    const chrome = { CANBAN_CLIENT: 'canban-chrome' };
    const resolve = (env) => resolveDataDirectory({ root, home, env });
    assert.equal(resolve(chrome), fs.realpathSync(userData));
    assert.equal(resolve({}), fs.realpathSync(developmentData));
    assert.equal(resolve({ ...chrome, CANBAN_DATA_DIR: developmentData }), developmentData);
    // A stale or broken developer configuration must not affect Chrome users.
    fs.writeFileSync(config, '{invalid');
    assert.equal(resolve(chrome), fs.realpathSync(userData));
    assert.throws(() => resolve({}), SyntaxError);
    // The default remains the user's home path on the first launch.
    fs.rmSync(userData, { recursive: true });
    assert.equal(resolve(chrome), userData);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

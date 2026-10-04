import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function canonicalDataDirectory(directory) {
  try { return fs.realpathSync(directory); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.resolve(directory);
  }
}

// Chrome users and installed copies default to ~/.canban. Only development
// checkouts use local configuration. An explicit environment setting wins.
export function resolveDataDirectory({ env = process.env, home = os.homedir(), root = repository } = {}) {
  if (env.CANBAN_DATA_DIR) return env.CANBAN_DATA_DIR;
  const configFile = path.join(root, '.local', 'config.json');
  if (env.CANBAN_CLIENT !== 'canban-chrome' && fs.existsSync(path.join(root, '.git')) && fs.existsSync(configFile)) {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (typeof config.dataDirectory !== 'string' || !config.dataDirectory.trim()) {
      throw new Error(`${configFile}: dataDirectory を指定してください`);
    }
    return canonicalDataDirectory(path.resolve(path.dirname(configFile), config.dataDirectory));
  }
  return canonicalDataDirectory(path.join(home, '.canban'));
}

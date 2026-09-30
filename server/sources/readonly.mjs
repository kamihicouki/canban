// Read-only access layer for agent session data.
// This module is the only way the source readers touch Codex / Claude files.
// It intentionally exposes no write APIs.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

export function exists(p) {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function stat(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

export async function realpath(p) {
  try {
    return await fsp.realpath(p);
  } catch {
    return null;
  }
}

export async function listDir(p) {
  try {
    return await fsp.readdir(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Sub-directory names, following symlinks (the Claude desktop app's profiles and shared
// session folders are often linked).
export async function listSubdirs(p) {
  const out = [];
  for (const e of await listDir(p)) {
    if (e.isDirectory()) out.push(e.name);
    else if (e.isSymbolicLink() && (await stat(`${p}/${e.name}`))?.isDirectory()) out.push(e.name);
  }
  return out;
}

export async function readJson(p) {
  const fh = await fsp.open(p, 'r');
  try {
    return JSON.parse(await fh.readFile('utf8'));
  } finally {
    await fh.close();
  }
}

// Iterate JSON lines of a file opened with the 'r' flag. Malformed lines are skipped.
export async function* readJsonLines(p) {
  const stream = fs.createReadStream(p, { flags: 'r', encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // skip partial / malformed line (file may be mid-write)
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

// Read the last `bytes` bytes of a file and return complete JSON lines from it.
export async function readTailJsonLines(p, bytes = 256 * 1024) {
  const fh = await fsp.open(p, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    let lines = buf.toString('utf8').split('\n');
    if (start > 0) lines = lines.slice(1); // first line is likely partial
    const out = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    return out;
  } finally {
    await fh.close();
  }
}

// Run a query against a SQLite database opened in read-only mode.
// The connection is opened and closed per call so no lock is held between calls.
export function queryReadOnly(dbPath, fn) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON');
    return fn(db);
  } finally {
    db.close();
  }
}

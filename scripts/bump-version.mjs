#!/usr/bin/env node
// Bump the version in package.json, manifest.json and .codex-plugin/plugin.json together,
// and add the matching entries to CHANGELOG.md and CHROMEWEBSTORE.md.
//
//   npm run bump -- [patch|minor|x.y.z] "変更の要約" [--store "ストア向けの要約"] [--next-free] [--dry-run]
//
// --next-free skips numbers already taken by origin/main and open PRs (gh pr list), so
// parallel branches do not pick the same number. Without gh it checks origin/main only.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION_FILES = ['package.json', 'manifest.json', '.codex-plugin/plugin.json'];
const SEMVER = /\b(\d+)\.(\d+)\.(\d+)\b/;
const SEMVER_ALL = /\b\d+\.\d+\.\d+\b/g;

export function parseVersion(text) {
  const m = SEMVER.exec(String(text || ''));
  return m ? m.slice(1, 4).map(Number) : null;
}
export const formatVersion = v => v.join('.');
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export function nextVersion(current, kind, used = new Set()) {
  let next;
  if (kind === 'minor') next = [current[0], current[1] + 1, 0];
  else if (kind === 'patch') next = [current[0], current[1], current[2] + 1];
  else {
    next = parseVersion(kind);
    if (!next || formatVersion(next) !== kind) throw new Error(`Unknown bump "${kind}": use patch, minor or x.y.z`);
  }
  while (used.has(formatVersion(next))) next = [next[0], next[1], next[2] + 1];
  return next;
}

// Replace only the "version" value so key order and formatting stay as they are.
export function setJsonVersion(text, version) {
  let done = false;
  const out = text.replace(/("version"\s*:\s*")[^"]*(")/, (_, a, b) => { done = true; return a + version + b; });
  if (!done) throw new Error('No "version" field');
  return out;
}

export function addChangelogEntry(text, version, date, summary) {
  if (new RegExp(`^## ${version.replaceAll('.', '\\.')}\\b`, 'm').test(text)) throw new Error(`CHANGELOG.md already has ${version}`);
  const entry = `## ${version} — ${date}\n\n- ${summary}\n\n`;
  const at = text.search(/^## /m);
  return at < 0 ? `${text.trimEnd()}\n\n${entry}` : text.slice(0, at) + entry + text.slice(at);
}

const headingOf = version => new RegExp(`^## .*\\b${version.replaceAll('.', '\\.')}\\b`, 'm');

// New store notes go right above the current version's entry (or else the latest
// "## …実装版 x.y.z" entry) and reuse the label of the latest "…実装版" heading.
export function addStoreEntry(text, version, summary, current) {
  if (headingOf(version).test(text)) throw new Error(`CHROMEWEBSTORE.md already has ${version}`);
  const impl = /^## (\S*実装版) \d+\.\d+\.\d+/m.exec(text);
  const m = (current && headingOf(current).exec(text)) || impl || /^## (\S*版) \d+\.\d+\.\d+/m.exec(text);
  const entry = `## ${impl ? impl[1] : '内部実装版'} ${version}\n\n- ${summary}\n\n`;
  return m ? text.slice(0, m.index) + entry + text.slice(m.index) : `${text.trimEnd()}\n\n${entry}`;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

// Numbers in use elsewhere: origin/main's package.json and each open PR (title and head branch).
export function usedVersions({ exec = run, log = console.error } = {}) {
  const used = new Set();
  const add = text => { for (const v of String(text || '').match(SEMVER_ALL) || []) used.add(v); };
  exec('git', ['fetch', '--quiet', 'origin']);
  const main = exec('git', ['show', 'origin/main:package.json']);
  if (main) add(JSON.parse(main).version);
  else log('origin/main を読めませんでした。');
  const prs = exec('gh', ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'headRefName,title']);
  if (prs == null) { log('gh が使えないため、origin/main だけで空き番号を判断します。'); return used; }
  for (const pr of JSON.parse(prs)) {
    add(pr.title);
    const pkg = exec('git', ['show', `origin/${pr.headRefName}:package.json`]);
    if (pkg) add(JSON.parse(pkg).version);
  }
  return used;
}

export function bump({ dir = root, kind = 'patch', summary, store, nextFree = false, dryRun = false, date, used, log = console.log } = {}) {
  if (!summary?.trim()) throw new Error('変更の要約を指定してください: npm run bump -- patch "変更の要約"');
  const read = f => fs.readFileSync(path.join(dir, f), 'utf8');
  const current = parseVersion(JSON.parse(read('package.json')).version);
  const taken = nextFree ? (used || usedVersions()) : new Set();
  // Start from the highest number in use so --next-free never goes backwards.
  let base = current;
  if (nextFree && kind === 'patch') for (const v of taken) {
    const p = parseVersion(v);
    if (p[0] === current[0] && p[1] === current[1] && compareVersions(p, base) > 0) base = p;
  }
  const next = nextVersion(kind === 'patch' ? base : current, kind, taken);
  if (compareVersions(next, current) <= 0) throw new Error(`${formatVersion(next)} は現在の ${formatVersion(current)} より新しくありません`);
  const version = formatVersion(next);
  const today = date || new Date().toLocaleDateString('sv-SE');
  const writes = [
    ...VERSION_FILES.map(f => [f, setJsonVersion(read(f), version)]),
    ['CHANGELOG.md', addChangelogEntry(read('CHANGELOG.md'), version, today, summary.trim())],
    ['CHROMEWEBSTORE.md', addStoreEntry(read('CHROMEWEBSTORE.md'), version, (store || summary).trim(), formatVersion(current))],
  ];
  if (!dryRun) for (const [f, text] of writes) fs.writeFileSync(path.join(dir, f), text);
  log(`${formatVersion(current)} → ${version}${dryRun ? '（dry-run: 書き込みなし）' : ''}`);
  return version;
}

function parseArgs(argv) {
  const opts = { kind: 'patch' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--next-free') opts.nextFree = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--store') opts.store = argv[++i];
    else rest.push(a);
  }
  if (/^(patch|minor|\d+\.\d+\.\d+)$/.test(rest[0] || '')) opts.kind = rest.shift();
  opts.summary = rest.join(' ');
  return opts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { bump(parseArgs(process.argv.slice(2))); }
  catch (e) { console.error(e.message); process.exit(1); }
}

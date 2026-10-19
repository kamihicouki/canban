#!/usr/bin/env node
// Bump the version in package.json, manifest.json and .codex-plugin/plugin.json together,
// and add the matching entries to CHANGELOG.md and CHROMEWEBSTORE.md.
//
//   npm run bump -- [patch|minor|x.y.z] "変更の要約" [--store "ストア向けの要約"] [--next-free [--strict]] [--dry-run]
//
// --next-free counts from the highest number origin/main and open PRs (gh pr list) use and
// skips taken ones. Without gh it checks origin/main only; --strict makes that an error.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION_FILES = ['package.json', 'manifest.json', '.codex-plugin/plugin.json'];
const SEMVER = /\b(\d+)\.(\d+)\.(\d+)\b/;

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

// Numbers in use elsewhere: origin/main's package.json and each open PR (its title and the
// package.json at its head, read through refs/pull/N/head so fork PRs are covered too).
// It only avoids the numbers it could read; it does not reserve one. `strict` turns any
// read failure into an error instead of a warning.
export function usedVersions({ exec = run, log = console.error, strict = false } = {}) {
  const used = new Set();
  const missing = [];
  const add = version => { if (version) used.add(version); };
  // A failed fetch would leave stale refs that still read fine, so it counts as unread.
  if (exec('git', ['fetch', '--quiet', 'origin', 'main', '+refs/pull/*/head:refs/remotes/origin/pr/*']) == null) missing.push('origin の最新（git fetch）');
  const main = exec('git', ['show', 'origin/main:package.json']);
  if (main) add(JSON.parse(main).version);
  else missing.push('origin/main');
  const prs = exec('gh', ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title']);
  if (prs == null) missing.push('open PR の一覧（gh）');
  else for (const pr of JSON.parse(prs)) {
    // Titles carry the number as "…（x.y.z）"; other numbers in a title are not versions.
    add(/[（(](\d+\.\d+\.\d+)[）)]/.exec(pr.title)?.[1]);
    const pkg = exec('git', ['show', `origin/pr/${pr.number}:package.json`]);
    if (pkg) add(JSON.parse(pkg).version);
    else missing.push(`#${pr.number} の package.json`);
  }
  if (missing.length) {
    const message = `読めなかったため番号の確認から外しました: ${missing.join('、')}`;
    if (strict) throw new Error(message);
    log(message);
  }
  return used;
}

export function bump({ dir = root, kind = 'patch', summary, store, nextFree = false, strict = false, dryRun = false, date, used, log = console.log } = {}) {
  if (!summary?.trim()) throw new Error('変更の要約を指定してください: npm run bump -- patch "変更の要約"');
  const read = f => fs.readFileSync(path.join(dir, f), 'utf8');
  const current = parseVersion(JSON.parse(read('package.json')).version);
  const taken = nextFree ? (used || usedVersions({ strict })) : new Set();
  // With --next-free, patch/minor count from the highest number in use, so an old worktree
  // never picks a number below one main or another PR already has.
  let base = current;
  if (nextFree) for (const v of taken) {
    const p = parseVersion(v);
    if (p && compareVersions(p, base) > 0) base = p;
  }
  const next = nextVersion(base, kind, taken);
  if (compareVersions(next, current) <= 0) throw new Error(`${formatVersion(next)} は現在の ${formatVersion(current)} より新しくありません`);
  if (nextFree && compareVersions(next, base) <= 0) throw new Error(`${formatVersion(next)} は使用中の ${formatVersion(base)} より新しくありません`);
  const version = formatVersion(next);
  const today = date || new Date().toLocaleDateString('sv-SE');
  const writes = [
    ...VERSION_FILES.map(f => [f, setJsonVersion(read(f), version)]),
    ['CHANGELOG.md', addChangelogEntry(read('CHANGELOG.md'), version, today, summary.trim())],
    ['CHROMEWEBSTORE.md', addStoreEntry(read('CHROMEWEBSTORE.md'), version, (store || summary).trim(), formatVersion(current))],
  ];
  if (!dryRun) for (const [f, text] of writes) fs.writeFileSync(path.join(dir, f), text);
  log(`${formatVersion(current)} → ${version}${base !== current ? `（使用中の最大 ${formatVersion(base)} の次）` : ''}${dryRun ? '（dry-run: 書き込みなし）' : ''}`);
  return version;
}

export function parseArgs(argv) {
  const opts = { kind: 'patch' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--next-free') opts.nextFree = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--store') {
      opts.store = argv[++i];
      if (!opts.store?.trim() || opts.store.startsWith('--')) throw new Error('--store にはストア向けの要約を続けてください');
    }
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

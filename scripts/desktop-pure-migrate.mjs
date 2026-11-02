#!/usr/bin/env node
// Return Claude Desktop to its pure layout (docs/claude-desktop-pure-layout-plan.md):
// one real ~/Library/Application Support/Claude, sessions as real files under
// claude-code-sessions/<account>/<org>, no profile links. Every change is a rename
// or symlink removal recorded in a journal, so rollback replays it backwards.
// The originals are also APFS-cloned first. Nothing is written without --apply.
//
//   plan              show what apply would do
//   apply  --apply    migrate (Desktop and Claude Profiles.app must be stopped)
//   verify            check the result
//   rollback --apply [--dir <backup dir>]
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = os.homedir();
const SUPPORT = path.join(HOME, 'Library', 'Application Support');
const CLAUDE = path.join(SUPPORT, 'Claude');
const PPB = path.join(SUPPORT, 'Claude-ppb');
const PROFILES = path.join(SUPPORT, 'Claude-Profiles');
const MAIN = path.join(PROFILES, 'main');
const PPB_PROFILE = path.join(PROFILES, 'ppb');
const SHARED = path.join(PROFILES, '_shared-sessions');
const PROJECTS = path.join(HOME, '.claude', 'projects');
const BACKUPS = path.join(HOME, '.canban', 'backups');
const CB1E = 'cb1e4fe4-fb1f-4723-a120-f0e09462d2ad', ORG_CB1E = '9e88875d-b595-464f-9bce-3ba89b156f19';
const A50 = '50e8712e-8dae-46b5-9bfe-1a2e19b93368', ORG_50 = '604b3ea8-4b70-469c-b79c-b15779279a3d';
const TREES = ['claude-code-sessions', 'local-agent-mode-sessions'];
// Created under 50e8 (their scratch lives in 50e8/604b) but stored in the shared cb1e folder.
const OWNED_BY_50 = ['local_b95ba536', 'local_ad42aa1e', 'local_df5b054e'];

const args = process.argv.slice(2);
const command = args[0] || 'plan';
const apply = args.includes('--apply');
const opt = name => { const i = args.indexOf(`--${name}`); return i > 0 ? args[i + 1] : undefined; };
const log = (...m) => console.log(...m);
const fail = m => { console.error(`中止: ${m}`); process.exit(1); };
const lstat = p => fs.lstat(p).catch(() => null);
const isLink = async p => (await lstat(p))?.isSymbolicLink() ?? false;
const isDir = async p => (await lstat(p))?.isDirectory() ?? false;
const ls = p => fs.readdir(p).catch(() => []);
const readJson = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const accountOf = async dir => (await readJson(path.join(dir, 'config.json')).catch(() => ({}))).lastKnownAccountUuid || null;
const encode = p => p.replace(/[^A-Za-z0-9]/g, '-');
const short = p => p.replace(SUPPORT + '/', '').replace(HOME, '~');
// Isolated tests only: a fake home has no Desktop of its own.
const running = pattern => process.env.CANBAN_TRIAL_FAKE_STOPPED === '1' && HOME !== os.userInfo().homedir ? false : execFileSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' }).split('\n').some(l => pattern.test(l));
const requireStopped = () => {
  if (running(/\/Claude\.app\/Contents\/MacOS\/Claude(\s|$)/)) fail('Claude Desktop が起動しています');
  if (running(/Claude Profiles\.app\/Contents\/MacOS\//)) fail('Claude Profiles.app が起動しています');
};

// ---- the journal: every applied step, written before moving on ----
let journal = null;
const record = async step => { journal.steps.push(step); await fs.writeFile(journal.file, JSON.stringify(journal, null, 1)); };
const ops = [];   // planned steps
const plan = step => ops.push(step);

async function run(step) {
  if (step.op === 'rename') {
    if (await lstat(step.to)) throw new Error(`${short(step.to)} が既にあります`);
    // Record each parent created here so rollback can remove it again.
    const missing = [];
    for (let dir = path.dirname(step.to); !await lstat(dir); dir = path.dirname(dir)) missing.unshift(dir);
    for (const dir of missing) { await fs.mkdir(dir); await record({ op: 'mkdir', path: dir }); }
    await fs.rename(step.from, step.to);
  } else if (step.op === 'unlink') {
    step.target = await fs.readlink(step.path);
    await fs.unlink(step.path);
  } else if (step.op === 'mkdir') {
    if (await lstat(step.path)) return;
    await fs.mkdir(step.path);
  }
  await record(step);
}

const describe = s => s.op === 'rename' ? `移動  ${short(s.from)}\n   → ${short(s.to)}${s.why ? `（${s.why}）` : ''}`
  : s.op === 'unlink' ? `リンク解除 ${short(s.path)}${s.why ? `（${s.why}）` : ''}` : `作成  ${short(s.path)}`;

async function resolveSession(dir, prefix) {
  const hits = (await ls(dir)).filter(f => f.startsWith(prefix) && f.endsWith('.json'));
  if (hits.length !== 1) fail(`${prefix} が ${short(dir)} に ${hits.length} 件あります`);
  return hits[0];
}

async function preflight() {
  if (!await isLink(CLAUDE)) fail('通常の保存先 Claude がリンクではありません（移行済みか、想定外の構成です）');
  const target = await fs.realpath(CLAUDE);
  if (![PPB, MAIN, PPB_PROFILE].includes(target)) fail(`Claude のリンク先が想定外です: ${target}`);
  if (await accountOf(MAIN) !== CB1E) fail('Claude-Profiles/main のログインが cb1e ではありません');
  if (await accountOf(PPB) !== A50) fail('Claude-ppb のログインが 50e8 ではありません');
  for (const tree of TREES) {
    if (await fs.realpath(path.join(MAIN, tree)).catch(() => null) !== path.join(SHARED, tree)) fail(`main/${tree} が共有フォルダを指していません`);
    if (!await isLink(path.join(SHARED, tree, A50, ORG_50))) fail(`共有 ${tree} の 50e8/604b がリンクではありません`);
  }
  return target;
}

async function buildPlan(B) {
  const moved = path.join(B, 'moved');
  plan({ op: 'unlink', path: CLAUDE, why: 'プロフィール切替用のリンク' });
  plan({ op: 'rename', from: MAIN, to: CLAUDE, why: 'cb1e のプロフィールを実体にする' });
  for (const tree of TREES) {
    const dest = path.join(CLAUDE, tree), shared = path.join(SHARED, tree), ppb = path.join(PPB, tree);
    plan({ op: 'unlink', path: dest });
    plan({ op: 'rename', from: shared, to: dest, why: '共有フォルダを実ディレクトリとして取り込む' });
    // Links inside the shared tree (the 50e8 org link and skills-plugin links).
    for (const a of await ls(shared)) for (const o of await ls(path.join(shared, a))) {
      if (await isLink(path.join(shared, a, o))) plan({ op: 'unlink', path: path.join(dest, a, o), why: 'アカウント間の共有リンク' });
    }
    // 50e8/9e88 holds only scheduled-tasks.json written while the folders were linked.
    if (await isDir(path.join(shared, A50, ORG_CB1E))) plan({ op: 'rename', from: path.join(dest, A50, ORG_CB1E), to: path.join(moved, tree, `${A50}--${ORG_CB1E}`), why: '共有中にできた空の組み合わせ' });
    for (const a of await ls(ppb)) for (const o of await ls(path.join(ppb, a))) {
      const src = path.join(ppb, a, o);
      if (!await isDir(src)) continue;
      const realShared = path.join(shared, a, o);
      if (await isDir(realShared) && !await isLink(realShared)) fail(`${tree}/${a}/${o} が Claude-ppb と共有の両方に実体としてあります`);
      plan({ op: 'rename', from: src, to: path.join(dest, a, o), why: 'Claude-ppb（50e8）の分' });
    }
  }
  const sessions = path.join(CLAUDE, 'claude-code-sessions');
  const master = path.join(SHARED, 'claude-code-sessions', CB1E, ORG_CB1E);
  for (const prefix of OWNED_BY_50) {
    const file = await resolveSession(master, prefix);
    if ((await ls(path.join(PPB, 'claude-code-sessions', A50, ORG_50))).includes(file)) fail(`${file} が 50e8 側にもあります`);
    plan({ op: 'rename', from: path.join(sessions, CB1E, ORG_CB1E, file), to: path.join(sessions, A50, ORG_50, file), why: '50e8 で作られた会話' });
  }
  if ((await ls(master)).includes('archived-sessions.idx')) plan({ op: 'rename', from: path.join(sessions, CB1E, ORG_CB1E, 'archived-sessions.idx'), to: path.join(moved, 'archived-sessions.idx'), why: '持ち主が変わるため Desktop に作り直させる' });

  // scratch-workspaces of Claude-Profiles/ppb join the ones that come with main.
  const scratchSrc = path.join(PPB_PROFILE, 'scratch-workspaces'), scratchDest = path.join(CLAUDE, 'scratch-workspaces');
  const mainScratch = path.join(MAIN, 'scratch-workspaces');
  for (const a of await ls(scratchSrc)) for (const o of await ls(path.join(scratchSrc, a))) for (const leaf of await ls(path.join(scratchSrc, a, o))) {
    const from = path.join(scratchSrc, a, o, leaf);
    const existing = path.join(mainScratch, a, o, leaf);
    if (await lstat(existing)) {
      if ((await ls(from)).length || (await ls(existing)).length) fail(`scratch ${a}/${o}/${leaf} が main と ppb の両方にあり、中身があります`);
      plan({ op: 'rename', from, to: path.join(moved, 'scratch-duplicates', a, o, leaf), why: '空の重複' });
    } else plan({ op: 'rename', from, to: path.join(scratchDest, a, o, leaf), why: 'scratch を集める' });
  }

  // Transcripts are filed under the real path of the session's cwd. Scratch cwds
  // were recorded through the Claude link, whose real path now becomes Claude/.
  const records = [];
  for (const [dir, owner] of [[master, CB1E], [path.join(PPB, 'claude-code-sessions', A50, ORG_50), A50]])
    for (const f of await ls(dir)) if (f.startsWith('local_') && f.endsWith('.json')) records.push(await readJson(path.join(dir, f)));
  const projects = await ls(PROJECTS);
  for (const r of records) {
    const leaf = (r.cwd || '').split('/scratch-workspaces/')[1];
    if (!leaf) continue;
    const want = encode(path.join(SUPPORT, 'Claude', 'scratch-workspaces', leaf));
    for (const id of [r.cliSessionId, ...(r.priorCliSessionIds || [])].filter(Boolean)) {
      const hits = [];
      for (const p of projects) {
        const file = path.join(PROJECTS, p, `${id}.jsonl`);
        const st = await lstat(file);
        if (st) hits.push({ project: p, file, mtime: st.mtimeMs });
      }
      if (!hits.length) continue;
      // Keep the newest copy (a stale one can sit in the right-named folder) and
      // free the right-named slot before moving it there.
      const keep = hits.sort((x, y) => y.mtime - x.mtime)[0];
      const parts = h => [h.file, path.join(PROJECTS, h.project, id)];
      for (const h of hits) if (h !== keep) for (const from of parts(h)) if (await lstat(from))
        plan({ op: 'rename', from, to: path.join(moved, 'projects', h.project, path.basename(from)), why: `「${r.title}」の古いコピー` });
      if (keep.project !== want) for (const from of parts(keep)) if (await lstat(from))
        plan({ op: 'rename', from, to: path.join(PROJECTS, want, path.basename(from)), why: `「${r.title}」の会話記録を実体パスの名前へ` });
    }
  }
  const retired = path.join(B, 'retired');
  plan({ op: 'rename', from: PPB, to: path.join(retired, 'Claude-ppb'), why: '確認が済むまで退避（削除しない）' });
  plan({ op: 'rename', from: PROFILES, to: path.join(retired, 'Claude-Profiles'), why: '確認が済むまで退避（削除しない）' });
}

async function inventory() {
  const out = {};
  for (const [name, dir] of [['shared cb1e', path.join(SHARED, 'claude-code-sessions', CB1E, ORG_CB1E)], ['Claude-ppb 50e8', path.join(PPB, 'claude-code-sessions', A50, ORG_50)]])
    out[name] = (await ls(dir)).filter(f => f.startsWith('local_') && f.endsWith('.json')).length;
  return out;
}

async function migrate() {
  const linked = await preflight();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const B = path.join(BACKUPS, `desktop-pure-${stamp}`);
  await buildPlan(B);
  const counts = await inventory();
  log(`現在のリンク先: ${short(linked)}`);
  log(`会話: ${Object.entries(counts).map(([k, v]) => `${k} ${v} 件`).join(' / ')}`);
  log(`バックアップ: ${short(B)}（APFS clone）\n`);
  ops.forEach((s, i) => log(`${String(i + 1).padStart(2)}. ${describe(s)}`));
  if (!apply) return log('\n（--apply で実行）');
  requireStopped();
  await fs.mkdir(path.join(B, 'clone'), { recursive: true, mode: 0o700 });
  log('\nバックアップ中…');
  for (const src of [PPB, PROFILES]) execFileSync('/bin/cp', ['-cRp', src, path.join(B, 'clone', path.basename(src))]);
  for (const s of ops) if (s.op === 'rename' && s.from.startsWith(PROJECTS)) {
    const to = path.join(B, 'clone', 'projects', path.relative(PROJECTS, s.from));
    await fs.mkdir(path.dirname(to), { recursive: true });
    execFileSync('/bin/cp', ['-cRp', s.from, to]);
  }
  journal = { version: 1, file: path.join(B, 'journal.json'), createdAt: new Date().toISOString(), link: await fs.readlink(CLAUDE), counts, steps: [] };
  await record({ op: 'begin' });
  requireStopped();
  for (const [i, s] of ops.entries()) {
    try { await run(s); }
    catch (e) { fail(`手順 ${i + 1} で失敗しました（${e.message}）。rollback --apply --dir "${B}" で戻せます`); }
  }
  await record({ op: 'done' });
  log(`\n移行しました。記録: ${short(journal.file)}`);
  await verify();
}

async function latestBackup() {
  const dirs = (await ls(BACKUPS)).filter(n => n.startsWith('desktop-pure-')).sort();
  return dirs.length ? path.join(BACKUPS, dirs.at(-1)) : null;
}

async function rollback() {
  const B = opt('dir') || await latestBackup();
  if (!B) fail('バックアップがありません');
  const j = await readJson(path.join(B, 'journal.json'));
  const steps = j.steps.filter(s => !['begin', 'done'].includes(s.op)).reverse();
  log(`戻す記録: ${short(B)}（${steps.length} 手順）`);
  for (const s of steps) log(`  ${s.op === 'rename' ? `移動 ${short(s.to)} → ${short(s.from)}` : s.op === 'unlink' ? `リンク作成 ${short(s.path)} → ${short(s.target)}` : `削除（空なら） ${short(s.path)}`}`);
  if (!apply) return log('（--apply で実行）');
  requireStopped();
  for (const s of steps) {
    if (s.op === 'rename') { await fs.mkdir(path.dirname(s.from), { recursive: true }); await fs.rename(s.to, s.from); }
    else if (s.op === 'unlink') await fs.symlink(s.target, s.path);
    else if (s.op === 'mkdir') await fs.rmdir(s.path).catch(() => {});
  }
  await fs.rename(path.join(B, 'journal.json'), path.join(B, 'journal.rolled-back.json'));
  log('戻しました');
}

async function verify() {
  const problems = [], notes = [];
  if (!await isDir(CLAUDE)) problems.push('Claude が実ディレクトリではありません');
  for (const tree of TREES) {
    const links = execFileSync('/usr/bin/find', [path.join(CLAUDE, tree), '-type', 'l'], { encoding: 'utf8' }).trim();
    if (links) problems.push(`${tree} にリンクが残っています: ${links}`);
  }
  for (const n of await ls(SUPPORT)) if (/^Claude-/.test(n)) problems.push(`Application Support に ${n} が残っています`);
  const base = path.join(CLAUDE, 'claude-code-sessions');
  log(`ログイン: ${await accountOf(CLAUDE)}`);
  for (const a of await ls(base)) for (const o of await ls(path.join(base, a))) {
    const dir = path.join(base, a, o);
    if (!await isDir(dir)) continue;
    const files = (await ls(dir)).filter(f => f.startsWith('local_') && f.endsWith('.json'));
    log(`  ${a.slice(0, 8)}/${o.slice(0, 8)}: ${files.length} 件`);
    for (const f of files) {
      const r = await readJson(path.join(dir, f));
      const leaf = (r.cwd || '').split('/scratch-workspaces/')[1];
      if (!r.isArchived && r.cwd && !await lstat(r.cwd)) (leaf ? problems : notes).push(`作業フォルダがありません: ${r.title}（${r.cwd}）`);
      if (leaf && !r.isArchived && !await lstat(path.join(PROJECTS, encode(path.join(SUPPORT, 'Claude', 'scratch-workspaces', leaf)), `${r.cliSessionId}.jsonl`))) problems.push(`会話記録が実体パスの名前にありません: ${r.title}`);
    }
  }
  if (notes.length) { log('\n参考（移行前からの状態。worktree の削除など）:'); notes.forEach(p => log(`  - ${p}`)); }
  if (problems.length) { log('\n問題:'); problems.forEach(p => log(`  - ${p}`)); process.exitCode = 1; }
  else log('\n問題は見つかりませんでした');
}

const commands = { plan: migrate, apply: migrate, verify, rollback };
if (!commands[command]) fail(`使い方: ${Object.keys(commands).join(' | ')}（書き込みは --apply）`);
if (command === 'apply' && !apply) fail('apply には --apply を付けてください');
await commands[command]();

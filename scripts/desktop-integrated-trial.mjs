#!/usr/bin/env node
// Trial of the integrated Desktop sidebar (docs/claude-desktop-integrated-sidebar-research.md).
// A guest is a copy of another account's session record placed in the launching
// account's folder while Desktop is stopped. Nothing is written without --apply.
//
//   status
//   switch  --to <profile dir> [--apply]          point the default Desktop link at a signed-in profile
//   prepare --guest local_<id> --into <profile dir> [--label name] [--apply]
//   restore [--apply]                              write guests back to their originals and remove them
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const SUPPORT = path.join(os.homedir(), 'Library', 'Application Support');
const DEFAULT_DIR = path.join(SUPPORT, 'Claude');
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const STATE = path.join(process.env.CANBAN_TRIAL_DIR || path.join(os.homedir(), '.canban', 'desktop-integrated'));
const LEDGER = path.join(STATE, 'ledger.json');
// Values that belong to the account the session was created in.
const ACCOUNT_KEYS = ['remoteMcpServersConfig', 'enabledMcpTools', 'chromePermissionMode', 'chromeAllowedDomains', 'chromeTabGroupId', 'bridgeSessionIds', 'remoteControlAutoEligible', 'steeredByRemoteClient'];
// A session with unfinished work would be resumed by the launching account at
// launch (seen in the 2026-10-14 trial: a quit-interrupted guest ran a turn).
const BUSY_KEYS = ['armedWorkAtQuit', 'pendingFirstStart', 'pendingCycle', 'interruptedByQuitAt', 'interruptedAwaitingPerson', 'lastTurnCutShort'];

const args = process.argv.slice(2);
const command = args[0];
const opt = name => { const i = args.indexOf(`--${name}`); return i > 0 ? args[i + 1] : undefined; };
const apply = args.includes('--apply');
const log = (...m) => console.log(...m);
const fail = message => { console.error(`中止: ${message}`); process.exit(1); };

const sha = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const exists = file => fs.lstat(file).then(() => true, () => false);
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJsonAtomic = async (file, value) => {
  const tmp = `${file}.canban-${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(tmp, file);
};
// Isolated tests only: the fake home has no Desktop of its own.
const desktopRunning = () => process.env.CANBAN_TRIAL_FAKE_STOPPED === '1' && os.homedir() !== os.userInfo().homedir ? false : execFileSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' })
  .split('\n').some(line => /\/Claude\.app\/Contents\/MacOS\/Claude(\s|$)/.test(line));
const requireStopped = () => { if (desktopRunning()) fail('Claude Desktop が起動しています。終了してから実行してください'); };
const accountOf = async dir => (await readJson(path.join(dir, 'config.json')).catch(() => ({}))).lastKnownAccountUuid || null;

// <profile>/claude-code-sessions/<account>/<org>, the folder Desktop lists for that login.
async function sessionFolder(profile) {
  const account = await accountOf(profile);
  if (!account) fail(`${profile} のログインアカウントを確認できません`);
  const base = path.join(profile, 'claude-code-sessions', account);
  const orgs = [];
  for (const org of await fs.readdir(base).catch(() => [])) {
    const dir = path.join(base, org);
    const real = await fs.realpath(dir).catch(() => null);
    if (real && (await fs.readdir(real)).some(f => f.startsWith('local_') && f.endsWith('.json'))) orgs.push(dir);
  }
  if (orgs.length !== 1) fail(`${base} に会話のある組織フォルダが ${orgs.length} 件あります`);
  return { account, dir: orgs[0], real: await fs.realpath(orgs[0]) };
}

async function findSession(id) {
  if (!/^local_[0-9a-f-]{36}$/.test(id)) fail('--guest は local_<uuid> で指定してください');
  const roots = (await fs.readdir(SUPPORT)).filter(n => /^Claude-/.test(n)).map(n => path.join(SUPPORT, n));
  for (const n of await fs.readdir(path.join(SUPPORT, 'Claude-Profiles')).catch(() => [])) if (!n.startsWith('_') && !n.startsWith('.')) roots.push(path.join(SUPPORT, 'Claude-Profiles', n));
  const hits = new Map();
  for (const root of roots) {
    const base = path.join(root, 'claude-code-sessions');
    for (const account of await fs.readdir(base).catch(() => [])) for (const org of await fs.readdir(path.join(base, account)).catch(() => [])) {
      const file = path.join(base, account, org, `${id}.json`);
      const real = await fs.realpath(file).catch(() => null);
      if (real && !hits.has(real)) hits.set(real, { profile: root, account, file: real });
    }
  }
  if (hits.size !== 1) fail(`${id} の保存先が ${hits.size} 件見つかりました`);
  return [...hits.values()][0];
}

async function transcriptOf(cli) {
  const found = [];
  for (const project of await fs.readdir(PROJECTS)) {
    const file = path.join(PROJECTS, project, `${cli}.jsonl`);
    if (await exists(file)) found.push(file);
  }
  if (found.length !== 1) fail(`会話記録 ${cli}.jsonl が ${found.length} 件あります`);
  return found[0];
}

// APFS clone: no extra space until either copy changes, and the link count stays 1.
const clone = (from, to) => execFileSync('/bin/cp', ['-cRp', from, to]);

async function status() {
  log('Desktop 起動中:', desktopRunning());
  log('通常の保存先:', await fs.readlink(DEFAULT_DIR).catch(() => '(リンクではない)'));
  const ledger = await readJson(LEDGER).catch(() => null);
  if (!ledger) return log('台帳: なし（ゲストは置かれていません）');
  log(`台帳: ${ledger.createdAt}`);
  for (const e of ledger.entries) log(`- ${e.sessionId} ${await exists(e.guestPath) ? 'ゲストあり' : 'ゲストなし'} → 原本 ${e.originPath}`);
}

async function switchProfile() {
  const to = opt('to');
  if (!to) fail('--to <プロフィールのフォルダ> を指定してください');
  const target = await fs.realpath(to).catch(() => fail(`${to} がありません`));
  const current = await fs.readlink(DEFAULT_DIR).catch(() => fail('通常の保存先がリンクではありません'));
  const account = await accountOf(target);
  if (!account) fail(`${target} はログイン済みのプロフィールではありません`);
  log(`通常の保存先: ${current} → ${target}（${account}）`);
  if (await fs.realpath(DEFAULT_DIR) === target) return log('切替は不要です');
  if (!apply) return log('（--apply で実行）');
  requireStopped();
  const tmp = `${DEFAULT_DIR}.canban-${crypto.randomUUID()}`;
  await fs.symlink(target, tmp);
  if (await fs.readlink(DEFAULT_DIR) !== current) { await fs.unlink(tmp); fail('別の操作で保存先が変わりました'); }
  await fs.rename(tmp, DEFAULT_DIR);
  log('切り替えました');
}

async function prepare() {
  const id = opt('guest'), into = opt('into');
  if (!id || !into) fail('--guest と --into を指定してください');
  if (await exists(LEDGER)) fail('前回のゲストが残っています。先に restore してください');
  const origin = await findSession(id);
  const target = await sessionFolder(await fs.realpath(into));
  if (await accountOf(origin.profile) === target.account) fail('同じアカウントの会話はゲストにしません');
  const record = await readJson(origin.file);
  if (record.isArchived) fail('アーカイブ済みの会話です');
  const busy = BUSY_KEYS.filter(k => record[k] != null);
  if (busy.length) fail(`未完了の作業があります (${busy.join(', ')})`);
  const guestPath = path.join(target.real, `${id}.json`);
  if (await exists(guestPath)) fail(`${guestPath} が既にあります`);
  const transcript = await transcriptOf(record.cliSessionId);
  const label = opt('label') || path.basename(origin.profile).replace(/^Claude-/, '');
  const prefix = `🔗 ${label} · `;
  log(`ゲスト: ${record.title}（${id}）`);
  log(`  原本  ${origin.file}`);
  log(`  置き先 ${guestPath}（${target.account}）`);
  log(`  会話記録 ${transcript} を退避`);
  if (!apply) return log('（--apply で実行）');
  requireStopped();
  const backup = path.join(STATE, 'backup', id);
  await fs.mkdir(backup, { recursive: true, mode: 0o700 });
  clone(origin.file, path.join(backup, 'origin.json'));
  clone(transcript, path.join(backup, 'transcript.jsonl'));
  const sidecar = transcript.slice(0, -'.jsonl'.length);
  if (await exists(sidecar)) clone(sidecar, path.join(backup, 'transcript.d'));
  const ledger = { version: 1, createdAt: new Date().toISOString(), entries: [{
    sessionId: id, cliSessionId: record.cliSessionId, prefix, guestPath, guestDir: target.real,
    originPath: origin.file, originSha: await sha(origin.file), transcript, backup,
  }] };
  await fs.mkdir(STATE, { recursive: true, mode: 0o700 });
  await writeJsonAtomic(LEDGER, ledger);
  await writeJsonAtomic(guestPath, { ...record, title: prefix + record.title });
  log('ゲストを置きました');
}

async function restore() {
  const ledger = await readJson(LEDGER).catch(() => null);
  if (!ledger) return log('台帳がありません。片付けるゲストはありません');
  if (apply) requireStopped();
  const since = Date.parse(ledger.createdAt);
  for (const e of ledger.entries) {
    log(`- ${e.sessionId}`);
    const guest = await readJson(e.guestPath).catch(() => null);
    const originChanged = await sha(e.originPath).catch(() => null) !== e.originSha;
    const transcriptGone = !await exists(e.transcript);
    const marker = path.join(path.dirname(e.transcript), `${e.cliSessionId}.desktop-released.json`);
    const newMarker = (await fs.stat(marker).catch(() => null))?.mtimeMs > since;
    const tombstone = path.join(e.guestDir, `deleted_${e.sessionId}`);
    let merged = null;
    if (guest && originChanged) log('  原本が統合中に別の場所で更新されたため、書き戻さずゲストを退避先に保存します');
    else if (guest) {
      merged = { ...guest };
      const origin = await readJson(e.originPath);
      for (const k of ACCOUNT_KEYS) k in origin ? merged[k] = origin[k] : delete merged[k];
      if (typeof guest.title === 'string' && guest.title.startsWith(e.prefix)) merged.title = guest.title.slice(e.prefix.length);
      const changed = Object.keys({ ...origin, ...merged }).filter(k => JSON.stringify(origin[k]) !== JSON.stringify(merged[k]));
      log(`  書き戻す項目: ${changed.join(', ') || '(変更なし)'}`);
    } else log('  ゲストは統合中に削除されました。原本は残します');
    if (transcriptGone) log('  会話記録が消えているため、退避分から戻します');
    if (newMarker) log('  統合中に付いた会話記録の解放マーカーを外します');
    if (!apply) continue;
    if (guest && originChanged) await fs.copyFile(e.guestPath, path.join(e.backup, 'guest-conflict.json'));
    if (merged) await writeJsonAtomic(e.originPath, merged);
    if (transcriptGone) clone(path.join(e.backup, 'transcript.jsonl'), e.transcript);
    const sidecar = e.transcript.slice(0, -'.jsonl'.length);
    if (await exists(path.join(e.backup, 'transcript.d')) && !await exists(sidecar)) clone(path.join(e.backup, 'transcript.d'), sidecar);
    if (newMarker) await fs.unlink(marker);
    await fs.unlink(e.guestPath).catch(() => {});
    await fs.unlink(tombstone).catch(() => {});
    const leftovers = (await fs.readdir(e.guestDir)).filter(f => f.includes(e.sessionId));
    if (leftovers.length) log(`  置き先に残ったファイル（手を付けていません）: ${leftovers.join(', ')}`);
    if (!(guest && originChanged)) await fs.rm(e.backup, { recursive: true, force: true });
  }
  if (!apply) return log('（--apply で実行）');
  await fs.unlink(LEDGER);
  log('片付けました');
}

const commands = { status, switch: switchProfile, prepare, restore };
if (!commands[command]) fail(`使い方: ${Object.keys(commands).join(' | ')}（書き込みは --apply）`);
await commands[command]();

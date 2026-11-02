// Resolve a saved card to the authoritative Desktop record and shared CLI log.
// The caller supplies only a card and an account; paths and IDs stay server-side.
import fs from 'node:fs/promises';
import path from 'node:path';
import { desktopSessionFolders, guestIndex, BUSY_KEYS } from './claude-desktop-guests.mjs';
import { validDesktopAccount } from './claude-desktop-roots.mjs';

const fail = reason => { throw Object.assign(new Error(reason), { code: 'desktop_resume_unavailable' }); };
const CLI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^local_[A-Za-z0-9-]{1,64}$/;
export function createClaudeDesktopResume({ paths, findSession, check, requests }) {
  async function resolve(input) {
    if (input.operation !== 'resume' || input.agent !== 'claude' || !validDesktopAccount(input.account)) fail('Desktop の再開アカウントを選んでください');
    const source = await findSession(input.cardId);
    if (source.agent !== 'claude' || source.host?.local === false) fail('このMacの Claude Desktop 会話を選んでください');
    if (source.desktopAmbiguous || !CLI.test(source.nativeId || '') || source.desktopSessionId && !ID.test(source.desktopSessionId)) fail('元の会話IDと所有者を確認できません。元のアカウントで確認してください');
    if (typeof source.cwd !== 'string' || !source.cwd.startsWith('/') || source.cwd.includes('\0') || source.cwd.length > 4096) fail('元の会話の作業先を確認できません');
    if ((await requests(input.cardId)).some(r => ['queued','starting','running'].includes(r.state))) fail('この会話には待機中または実行中の指示があります。完了または取消後に再開してください');
    const ledgerGuests = guestIndex(paths), matches = [];
    for (const folder of await desktopSessionFolders(paths)) {
      for (const f of await fs.readdir(folder.dir)) {
        if (!f.endsWith('.json') || !ID.test(f.slice(0,-5))) continue;
        const file = path.join(folder.dir, f);
        if (ledgerGuests.has(file)) continue;
        const st = await fs.lstat(file);
        if (!st.isFile() || st.isSymbolicLink() || st.size > 1024*1024) continue;
        const record = JSON.parse(await fs.readFile(file,'utf8'));
        if (source.desktopSessionId && record.sessionId === source.desktopSessionId || record.cliSessionId === source.nativeId) matches.push({ ...folder, record });
      }
    }
    if (source.desktopSessionId ? matches.length !== 1 : matches.length !== 0) fail('元の会話の所有者が複数あるか、Desktop の記録が変更されています。ボードを再確認してください');
    const { record, account, org = null, profileId = null } = matches[0] || {};
    const owner = record ? `claude:${account}` : validDesktopAccount(source.account) ? source.account : null;
    if (record && (record.sessionId !== source.desktopSessionId || record.cliSessionId !== source.nativeId || record.cwd !== source.cwd || source.desktopAccount && source.desktopAccount !== account)) fail('元の会話ID・履歴・作業先・所有者が一致しません');
    const archived = !!(source.archived || record?.isArchived), importCLI = !record || archived;
    if (archived && owner !== input.account) fail('アーカイブ済みの会話は元のアカウントで復元してから、別アカウントで開いてください');
    if (owner !== input.account || importCLI) {
      if (record && BUSY_KEYS.some(k => record[k] != null)) fail('作業途中で終了した会話です。元のアカウントで再開・停止してから選び直してください');
      const problem = await check(source);
      if (problem) fail(`${problem}。元のアカウントで作業を止めてから再開してください`);
    }
    const sourcePath = await fs.realpath(source.sourcePath).catch(() => null);
    if (!sourcePath || path.basename(sourcePath) !== `${source.nativeId}.jsonl`) fail('元の CLI 履歴の参照先を確認できません');
    const transcripts = [];
    for (const folder of await fs.readdir(paths.projects, { withFileTypes: true }).catch(() => [])) {
      if (!folder.isDirectory() && !folder.isSymbolicLink()) continue;
      const candidate = path.join(paths.projects, folder.name, `${source.nativeId}.jsonl`);
      const real = await fs.realpath(candidate).catch(() => null);
      if (real) transcripts.push(real);
    }
    if (transcripts.length !== 1 || transcripts[0] !== sourcePath) fail('同じ会話IDの CLI 履歴が複数あるか、元の履歴を Desktop から参照できません');
    const st = await fs.stat(sourcePath, { bigint: true });
    return { operation: 'resume', prepareThread: false, cardId: input.cardId, owner, profileId, org, nativeId: source.nativeId, desktopSessionId: importCLI ? null : source.desktopSessionId, originalDesktopSessionId: source.desktopSessionId || null, sourcePath,
      sourceStamp: `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`, cwd: source.cwd, host: { id: 'local', local: true }, importCLI, url: importCLI ? `claude://resume?session=${source.nativeId}` : `claude://code/continue?session=${source.desktopSessionId}` };
  }
  return { resolve };
}

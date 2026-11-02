// Sidebar groups for guests of the integrated Desktop sidebar (claude-desktop-guests.mjs).
// Desktop keeps manual groups per account in claude_desktop_config.json:
//   preferences.epitaxyPrefs["dframe-group-scopes"]["<account>/<org>"] =
//     { groups: [{ id: "cg-…", name }], assignments: { "code:<sessionId>": id }, order: { id: ["code:<sessionId>", …] } }
// Group IDs differ between accounts, so a guest is placed in the host group with the same
// name: the origin's manual group if it has one, else the session's project folder
// (an account that groups by folder shows "canban" without a manual group). Desktop
// derives the sidebar sections from these assignments. At launch its own cache
// (localStorage dframe-store) wins over the file for the same key, so a placement is a
// proposal: an assignment the user made earlier still decides. The file also holds the MCP server
// config, so it is changed only while Desktop is stopped, only when it round-trips
// byte-for-byte, and only inside the host scope; everything else must stay identical.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { projectName } from './sources/util.mjs';

const SCOPES = 'dframe-group-scopes';
const key = sessionId => `code:${sessionId}`;
const sha = text => crypto.createHash('sha256').update(text).digest('hex');

export const desktopConfigPath = app => path.join(app, 'claude_desktop_config.json');

// Parses the config; null when absent, unreadable or not exactly what we would write back.
export async function readDesktopConfig(file) {
  let bytes;
  try { bytes = await fs.readFile(file); } catch { return null; }
  const text = bytes.toString('utf8');
  // Invalid UTF-8 would decode to replacement characters and change on write.
  if (!Buffer.from(text, 'utf8').equals(bytes)) return null;
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (JSON.stringify(data, null, 2) !== text) return null;
  return { data, text, sha: sha(bytes) };
}

const scopeOf = (data, scope) => data?.preferences?.epitaxyPrefs?.[SCOPES]?.[scope] || null;
const uniqueGroup = (scope, name) => {
  const clean = typeof name === 'string' ? name.trim() : '';
  const hits = clean ? (scope?.groups || []).filter(g => typeof g?.name === 'string' && g.name.trim() === clean && typeof g.id === 'string') : [];
  return hits.length === 1 ? hits[0] : null;
};

// Where each guest goes in the host's manual groups. Read-only.
// guests: [{ sessionId, account, org, cwd }]
export function planGuestGroups(data, hostScope, guests) {
  const host = scopeOf(data, hostScope);
  const out = [];
  for (const g of guests) {
    const k = key(g.sessionId);
    if (host?.assignments && k in host.assignments) { out.push({ sessionId: g.sessionId, skip: 'preexisting' }); continue; }
    const origin = scopeOf(data, `${g.account}/${g.org}`);
    const originGroupId = origin?.assignments?.[k];
    let target = null, via = null;
    if (originGroupId) {
      // The origin's own group decides; no folder fallback when the host lacks it.
      const name = (origin.groups || []).find(x => x?.id === originGroupId)?.name;
      target = uniqueGroup(host, name); via = 'origin-group';
    } else {
      target = uniqueGroup(host, projectName(g.cwd)); via = 'project';
    }
    out.push(target ? { sessionId: g.sessionId, groupId: target.id, name: target.name, via } : { sessionId: g.sessionId, skip: 'no-group' });
  }
  return out;
}

// Applies changes to the host scope only and verifies nothing else moved.
// `expectSha`: the file must still be the version the change was planned on.
async function editHostScope(file, hostScope, expectSha, change) {
  const current = await readDesktopConfig(file);
  if (!current) throw new Error('Desktop の設定ファイルをそのまま読み書きできません');
  if (expectSha && current.sha !== expectSha) throw new Error('Desktop の設定ファイルが計画後に変わりました');
  const next = structuredClone(current.data);
  const scope = next.preferences?.epitaxyPrefs?.[SCOPES]?.[hostScope];
  if (!scope) return { changed: false, sha: current.sha };
  change(scope);
  const strip = d => { const c = structuredClone(d); if (c.preferences?.epitaxyPrefs?.[SCOPES]) delete c.preferences.epitaxyPrefs[SCOPES][hostScope]; return c; };
  if (!isDeepStrictEqual(strip(current.data), strip(next))) throw new Error('グループ以外の設定が変わるため中止しました');
  const text = JSON.stringify(next, null, 2);
  if (text === current.text) return { changed: false, sha: current.sha };
  const tmp = `${file}.canban-${crypto.randomUUID()}.tmp`;
  const mode = (await fs.stat(file)).mode & 0o777;
  await fs.writeFile(tmp, text, { mode });
  // Last check before the swap: another writer would be overwritten.
  if (sha(await fs.readFile(file)) !== current.sha) { await fs.unlink(tmp).catch(() => {}); throw new Error('Desktop の設定ファイルが書き込み中に変わりました'); }
  await fs.rename(tmp, file);
  return { changed: true, sha: sha(text) };
}

export async function assignGuestGroups(file, hostScope, plan, expectSha) {
  const adds = plan.filter(p => p.groupId);
  if (!adds.length) return { changed: false };
  return editHostScope(file, hostScope, expectSha, scope => {
    scope.assignments ||= {};
    scope.order ||= {};
    for (const p of adds) {
      if (!(scope.groups || []).some(g => g?.id === p.groupId)) continue;
      scope.assignments[key(p.sessionId)] = p.groupId;
      const list = Array.isArray(scope.order[p.groupId]) ? scope.order[p.groupId] : (scope.order[p.groupId] = []);
      if (!list.includes(key(p.sessionId))) list.push(key(p.sessionId));
    }
  });
}

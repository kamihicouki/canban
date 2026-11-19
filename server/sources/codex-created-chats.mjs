// Codex が create_thread で生成した「作成されたチャット」の親子関係を読み取り専用で抽出する。
// thread_spawn_edges（サブエージェント）や attached_thread_parent_id（サイドチャット）とは独立に扱う。
import fs from 'node:fs';
import path from 'node:path';
import { listDir, queryReadOnly, rolloutFile } from './readonly.mjs';
import { LOCAL_HOST, sessionKey } from './util.mjs';

const DELEGATION_ENVELOPE = /^<codex_delegation>\s*<source_thread_id>([^<>]+)<\/source_thread_id>\s*<input>[\s\S]*?<\/input>\s*<\/codex_delegation>$/;
const decodeXmlEntities = (text) => text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const contentText = (content) => Array.isArray(content)
  ? content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
  : (typeof content === 'string' ? content : '');

const homeCaches = new Map(); // homeDir -> { resolved: Map<nativeId, parentNativeId>, miss: Map<nativeId, { histSig, rolloutSig }> }

function cacheFor(home) {
  const key = home || '__default';
  let entry = homeCaches.get(key);
  if (!entry) {
    entry = { resolved: new Map(), miss: new Map() };
    homeCaches.set(key, entry);
  }
  return entry;
}

export function resetCreatedChatCache() {
  homeCaches.clear();
}

/**
 * 完全な <codex_delegation> 封筒から作成元スレッド ID のみを抽出する。
 * 引用文・壊れたタグ・自己参照は拒否する。
 */
export function extractCreatedChatParent(raw, childNativeId = null) {
  if (typeof raw !== 'string') return null;
  const match = DELEGATION_ENVELOPE.exec(raw.trim());
  if (!match) return null;
  const source = decodeXmlEntities(match[1].trim());
  if (!source || source.length > 160) return null;
  if (childNativeId && source === childNativeId) return null;
  return source;
}

/**
 * thread_history_<n>.sqlite の 1 レコード JSON から親スレッド ID を抽出する。
 */
export function parseCreatedParentFromHistoryItem(itemJson, childNativeId = null) {
  let obj;
  try {
    obj = typeof itemJson === 'string' ? JSON.parse(itemJson) : itemJson;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const isCreate = (obj.type === 'functionCallOutput' || obj.type === 'FunctionCallOutput')
    && obj.namespace === 'codex_app' && obj.name === 'create_thread';
  if (isCreate) return extractCreatedChatParent(obj.output, childNativeId);
  const isUser = obj.type === 'userMessage' || obj.type === 'UserMessage';
  if (isUser) {
    const raw = Array.isArray(obj.content) ? contentText(obj.content) : (typeof obj.text === 'string' ? obj.text : null);
    return extractCreatedChatParent(raw, childNativeId);
  }
  return null;
}

/**
 * rollout JSONL の先頭バイト列から作成元スレッド ID を抽出する（thread_history が無い場合のフォールバック）。
 */
export function readCreatedParentFromRolloutHead(rolloutPath, childNativeId = null, maxBytes = 512 * 1024) {
  const target = rolloutFile(rolloutPath);
  if (!target || target.endsWith('.zst')) return null;
  let fd;
  try {
    fd = fs.openSync(target, 'r');
    const st = fs.fstatSync(fd);
    const len = Math.min(st.size, maxBytes);
    if (len <= 0) return null;
    const buf = Buffer.allocUnsafe(len);
    const read = fs.readSync(fd, buf, 0, len, 0);
    const lines = buf.subarray(0, read).toString('utf8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const p = record?.payload;
      if (!p) continue;
      let raw = null;
      if (record.type === 'response_item' && p.type === 'function_call_output' && p.namespace === 'codex_app' && p.name === 'create_thread') {
        raw = p.output;
      } else if (record.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'FunctionCallOutput' && p.item.namespace === 'codex_app' && p.item.name === 'create_thread') {
        raw = p.item.output;
      } else if (record.type === 'event_msg' && p.type === 'user_message') {
        raw = p.message;
      } else if (record.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'UserMessage') {
        raw = contentText(p.item.content);
      }
      const parent = extractCreatedChatParent(raw, childNativeId);
      if (parent) return parent;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  return null;
}

/**
 * 指定 home 配下で最大番号の thread_history_<n>.sqlite を返す。
 */
export async function findHistoryDb(home) {
  if (!home) return null;
  const entries = await listDir(home);
  let best = null;
  for (const e of entries) {
    const m = /^thread_history_(\d+)\.sqlite$/.exec(e.name);
    if (m && e.isFile() && (!best || Number(m[1]) > best.n)) {
      best = { n: Number(m[1]), file: path.join(home, e.name) };
    }
  }
  return best?.file ?? null;
}

function fileSig(p) {
  if (!p) return '-';
  try {
    const st = fs.statSync(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '-';
  }
}

/**
 * agent_created_thread セッションの親スレッド ID をバッチ解決して返す。
 * 確定した親子はホーム別キャッシュに保持し、未解決のみシグネチャ変化時に再確認する。
 */
export async function resolveCreatedChatParents(home, sessions) {
  const candidates = (sessions || []).filter((s) => s.agent === 'codex' && !s.subagent && s.threadSource === 'agent_created_thread');
  const result = new Map();
  if (!candidates.length) return result;

  const cache = cacheFor(home);
  const histDb = await findHistoryDb(home);
  const histSig = histDb ? `${histDb}|${fileSig(histDb)}|${fileSig(`${histDb}-wal`)}` : '-';
  const pending = [];

  for (const s of candidates) {
    const hit = cache.resolved.get(s.nativeId);
    if (hit) {
      result.set(s.nativeId, hit);
      continue;
    }
    const rSig = fileSig(rolloutFile(s.sourcePath));
    const miss = cache.miss.get(s.nativeId);
    if (miss && miss.histSig === histSig && miss.rolloutSig === rSig) continue;
    pending.push({ s, rSig });
  }

  if (pending.length && histDb) {
    try {
      queryReadOnly(histDb, (db) => {
        const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_items'").get();
        if (!hasTable) return;
        const CHUNK = 350;
        const ids = pending.map((x) => x.s.nativeId);
        for (let i = 0; i < ids.length; i += CHUNK) {
          const slice = ids.slice(i, i + CHUNK);
          const placeholders = slice.map(() => '?').join(',');
          const rows = db.prepare(
            `SELECT thread_id, item_json FROM thread_items WHERE thread_id IN (${placeholders}) AND item_type IN ('functionCallOutput', 'userMessage') AND rollout_ordinal < 60 ORDER BY rollout_ordinal ASC`,
          ).all(...slice);
          for (const row of rows) {
            if (cache.resolved.has(row.thread_id)) continue;
            const parent = parseCreatedParentFromHistoryItem(row.item_json, row.thread_id);
            if (parent) {
              cache.resolved.set(row.thread_id, parent);
              cache.miss.delete(row.thread_id);
              result.set(row.thread_id, parent);
            }
          }
        }
      });
    } catch {
      // thread_history がロック・破損している場合もフォールバックで続行
    }
  }

  for (const { s, rSig } of pending) {
    if (result.has(s.nativeId)) continue;
    const parent = s.sourcePath ? readCreatedParentFromRolloutHead(s.sourcePath, s.nativeId) : null;
    if (parent) {
      cache.resolved.set(s.nativeId, parent);
      cache.miss.delete(s.nativeId);
      result.set(s.nativeId, parent);
    } else {
      cache.miss.set(s.nativeId, { histSig, rolloutSig: rSig });
    }
  }

  return result;
}

/**
 * 同一ホーム・ホスト内のセッション配列へ createdParentId / createdChildren を付与する。
 * 循環する辺は無視し、既存のサブエージェント属性 (parentId / children / subagent) は変更しない。
 */
export function attachCreatedChatEdges(sessions, parentByChild, host = LOCAL_HOST) {
  if (!parentByChild?.size || !sessions?.length) return;
  const byNative = new Map(sessions.filter((s) => s.agent === 'codex').map((s) => [s.nativeId, s]));
  const hasCycle = (childId, parentId) => {
    const seen = new Set([childId]);
    let cur = parentId;
    while (cur) {
      if (seen.has(cur)) return true;
      seen.add(cur);
      cur = parentByChild.get(cur);
    }
    return false;
  };
  const added = new Map(); // parentNativeId -> Set<childSessionId>
  for (const [childNativeId, parentNativeId] of parentByChild) {
    const child = byNative.get(childNativeId);
    if (!child || !parentNativeId || childNativeId === parentNativeId || hasCycle(childNativeId, parentNativeId)) continue;
    child.createdParentId = sessionKey('codex', host, parentNativeId);
    const parent = byNative.get(parentNativeId);
    if (!parent) continue;
    let set = added.get(parentNativeId);
    if (!set) {
      set = new Set(parent.createdChildren || []);
      added.set(parentNativeId, set);
    }
    if (!set.has(child.id)) {
      set.add(child.id);
      (parent.createdChildren ||= []).push(child.id);
    }
  }
}

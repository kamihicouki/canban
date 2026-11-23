// The original human request is loaded on demand from an already resolved local session.
// Never use the tail, cleaned previews, provider discovery or decompression as origin evidence.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { keepsEarlierHistory } from './sources/readonly.mjs';
import { isHumanPrompt, textOf } from './sources/claude.mjs';
import { cleanPrompt } from './sources/util.mjs';

export const ORIGIN_HEAD_BYTES = 1024 * 1024;
export const ORIGIN_TEXT_MAX = 100000;
// `rollout-<time>-<thread>_<log>.jsonl`: Codex names only the log a revert creates this way.
const REVERTED_LOG = /-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}_[0-9a-f-]{36}\.jsonl$/;
const META_BYTES = 256 * 1024;

// Codex restarts a thread's listed excerpt at the request after a revert. It is still the first
// request after a revert to the very start. Where the log cannot tell, it is not claimed.
export async function excerptIsOrigin(session) {
  if (session?.agent !== 'codex' || !REVERTED_LOG.test(session.sourcePath || '')) return true;
  if (session.host && session.host.local !== true) return false;
  let handle;
  try {
    handle = await fsp.open(session.sourcePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) return false;
    const buffer = Buffer.alloc(META_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, META_BYTES, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    if (end < 0) return false;
    const record = JSON.parse(buffer.toString('utf8', 0, end));
    return record?.type === 'session_meta' && !keepsEarlierHistory(record) && !unsafeHead(record);
  } catch {
    return false; // compressed, missing or mid-write
  } finally {
    await handle?.close();
  }
}

function unsafeHead(record) {
  return record.type === 'compacted' || record.subtype === 'compact_boundary' || record.isCompactSummary ||
    (record.type === 'session_meta' && (record.payload?.forked_from_id || record.payload?.source?.subagent));
}

function humanText(agent, record) {
  if (agent === 'claude') return isHumanPrompt(record) ? textOf(record.message?.content) : null;
  if (record.type !== 'event_msg') return null;
  const payload = record.payload;
  if (payload?.type === 'user_message') return typeof payload.message === 'string' ? payload.message : '';
  if (payload?.type === 'item_completed' && payload.item?.type === 'UserMessage') {
    const content = payload.item.content;
    return Array.isArray(content) ? content.filter(block => typeof block?.text === 'string').map(block => block.text).join('\n') : '';
  }
  return null;
}

export async function readSessionOrigin(session) {
  const observedAt = new Date().toISOString();
  const result = (state, item, reason, complete = false) => ({ state, item, reason, observedAt, source: 'session-log-head', complete });
  const unavailable = reason => result('unavailable', null, reason);
  if (!['codex', 'claude'].includes(session?.agent)) return unavailable('このエージェントの最初の依頼は取得できません');
  if (session.host && session.host.local !== true) return unavailable('リモートの会話の先頭は取得できません');
  if (session.subagent || session.parentId || session.cloud || session.sourceKind === 'cloud') return unavailable('派生またはクラウドの会話の先頭は確認できません');
  const file = session.sourcePath;
  if (typeof file !== 'string' || !path.isAbsolute(file) || !file.endsWith('.jsonl') || file.includes('#')) {
    return unavailable('ローカルの非圧縮JSONLログがありません');
  }
  let handle;
  try {
    // O_NONBLOCK also lets an unexpected FIFO fail the regular-file check promptly.
    handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile()) return unavailable('会話ログが通常ファイルではありません');
    const buffer = Buffer.alloc(Math.min(stat.size, ORIGIN_HEAD_BYTES));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const head = buffer.subarray(0, length);
    const end = head.lastIndexOf(10);
    if (end < 0) return unavailable('上限内に完全な会話ログの行がありません');
    for (const line of head.subarray(0, end).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); }
      catch { return unavailable('会話の先頭に読み取れない行があり、最初の依頼を確認できません'); }
      if (!record || typeof record !== 'object') return unavailable('会話ログの形式を確認できません');
      if (unsafeHead(record)) return unavailable('要約または派生した会話の先頭のため、最初の依頼を確認できません');
      if (keepsEarlierHistory(record)) return unavailable('途中まで巻き戻した会話のため、最初の依頼は以前のログにあります');
      const raw = humanText(session.agent, record);
      if (raw === null) continue;
      if (!raw.trim()) return unavailable('最初の依頼に読み取れるテキストがありません');
      // Classify known app-only context using the shared parser, but always return raw text.
      if (!cleanPrompt(raw)) {
        const content = session.agent === 'claude' ? record.message?.content : record.payload?.item?.content;
        if (Array.isArray(content) && content.some(block => !['text', 'Text', 'input_text'].includes(block?.type))) {
          return unavailable('最初の依頼に読み取れるテキストがありません');
        }
        continue;
      }
      const complete = raw.length <= ORIGIN_TEXT_MAX;
      let text = raw.slice(0, ORIGIN_TEXT_MAX);
      // Keep the exact prefix while avoiding a split UTF-16 surrogate pair.
      if (!complete && /[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
      const item = { k: 'user', text, at: typeof record.timestamp === 'string' ? record.timestamp : null };
      return result(complete ? 'available' : 'partial', item, complete ? null : '最初の依頼が文字数上限を超えたため、先頭部分を表示しています', complete);
    }
    return unavailable(stat.size > head.length ? '先頭の読取り上限内に最初の依頼がありません' : '完全なログの行から最初の依頼を確認できません');
  } catch {
    return unavailable('ローカルの会話ログを読み取れません');
  } finally {
    await handle?.close();
  }
}

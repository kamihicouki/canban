import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSessionOrigin, ORIGIN_HEAD_BYTES, ORIGIN_TEXT_MAX } from '../server/session-origin.mjs';

const line = value => `${JSON.stringify(value)}\n`;
const prompt = (text, timestamp = '2026-11-15T00:00:00Z') => ({ type: 'event_msg', timestamp, payload: { type: 'user_message', message: text } });
async function withLog(body, run, session = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-origin-'));
  const sourcePath = path.join(dir, 'session.jsonl');
  fs.writeFileSync(sourcePath, body);
  try { await run({ agent: 'codex', sourcePath, ...session }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('origin preserves the first raw human prompt and source timestamp beyond the feed tail', async () => {
  const text = '  <cu_window_hints>画面</cu_window_hints>\n依頼\n ';
  const first = line({ type: 'session_meta', payload: { id: 'a' } }) + line(prompt(text));
  for (const suffix of ['', line({ type: 'other', data: 'x'.repeat(ORIGIN_HEAD_BYTES * 2) }) + line(prompt('later'))]) {
    await withLog(first + suffix, async session => {
      const origin = await readSessionOrigin(session);
      assert.equal(origin.state, 'available');
      assert.deepEqual(origin.item, { k: 'user', text, at: '2026-11-15T00:00:00Z' });
      assert.equal(origin.complete, true);
      assert.equal(origin.reason, null);
      assert.equal(origin.source, 'session-log-head');
      assert.ok(Number.isFinite(Date.parse(origin.observedAt)));
    });
  }
});

test('Codex metadata and response messages do not masquerade as the initial human request', async () => {
  const body = line({ type: 'session_meta', payload: { first_user_message: 'metadata' } }) +
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions' }] } }) +
    line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: '<tag>raw</tag>' }] } } });
  await withLog(body, async session => {
    const origin = await readSessionOrigin(session);
    assert.equal(origin.item.text, '<tag>raw</tag>');
    assert.equal(origin.item.at, null);
  });
});

test('Claude excludes tool results, sidechains and metadata while preserving raw text', async () => {
  const body = [
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'result' }] } },
    { type: 'user', isMeta: true, message: { content: 'metadata' } },
    { type: 'user', isSidechain: true, message: { content: 'sidechain' } },
    { type: 'user', message: { content: [{ type: 'text', text: '  <system-reminder>raw</system-reminder>\n人の依頼' }] } },
  ].map(line).join('');
  await withLog(body, async session => {
    const origin = await readSessionOrigin(session);
    assert.equal(origin.state, 'available');
    assert.equal(origin.item.text, '  <system-reminder>raw</system-reminder>\n人の依頼');
    assert.equal(origin.item.at, null);
  }, { agent: 'claude' });
});

test('a complete oversized prompt is explicitly partial without altering its prefix', async () => {
  const text = '依'.repeat(ORIGIN_TEXT_MAX + 20);
  await withLog(line(prompt(text)), async session => {
    const origin = await readSessionOrigin(session);
    assert.equal(origin.state, 'partial');
    assert.equal(origin.complete, false);
    assert.equal(origin.item.text, text.slice(0, ORIGIN_TEXT_MAX));
    assert.ok(origin.reason);
  });
});

test('oversized first lines and unfinished lines cannot silently skip to a later prompt', async () => {
  for (const body of [line(prompt('x'.repeat(ORIGIN_HEAD_BYTES + 1))), JSON.stringify(prompt('unfinished')), '{broken}\n' + line(prompt('later'))]) {
    await withLog(body, async session => {
      const origin = await readSessionOrigin(session);
      assert.equal(origin.state, 'unavailable');
      assert.equal(origin.item, null);
      assert.equal(origin.complete, false);
      assert.ok(origin.reason);
    });
  }
});

test('unsupported, remote, compressed, subagent and missing logs are unavailable', async () => {
  const cases = [
    { agent: 'gemini', sourcePath: '/missing.jsonl' },
    { agent: 'codex', sourcePath: '/missing.jsonl', host: { id: 'remote' } },
    { agent: 'claude', sourcePath: '/missing.jsonl.zst' },
    { agent: 'codex', sourcePath: '/missing.jsonl', subagent: true },
    { agent: 'codex', sourcePath: '/missing.jsonl' },
    { agent: 'codex' },
  ];
  for (const session of cases) {
    const origin = await readSessionOrigin(session);
    assert.equal(origin.state, 'unavailable');
    assert.equal(origin.item, null);
    assert.ok(origin.reason);
  }
});

test('compacted or forked log heads cannot assert the initial request', async () => {
  for (const record of [
    { type: 'compacted', payload: {} },
    { type: 'system', subtype: 'compact_boundary' },
    { type: 'user', isCompactSummary: true, message: { content: 'summary' } },
    { type: 'session_meta', payload: { forked_from_id: 'parent' } },
  ]) {
    await withLog(line(record) + line(prompt('later')), async session => {
      assert.equal((await readSessionOrigin(session)).state, 'unavailable');
    });
  }
});

test('a human request without readable text cannot be replaced by a later request', async () => {
  for (const [agent, record] of [
    ['claude', { type: 'user', message: { content: [{ type: 'image', source: { type: 'base64', data: 'image' } }] } }],
    ['codex', { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'image' }] } } }],
  ]) {
    await withLog(line(record) + line(prompt('later')), async session => {
      assert.equal((await readSessionOrigin(session)).state, 'unavailable');
    }, { agent });
  }
});

test('context-only app messages are skipped while tagged human requests retain every raw character', async () => {
  const raw = '  <system-reminder>ctx</system-reminder>\nREADME を直して  ';
  for (const agent of ['claude', 'codex']) {
    const record = text => agent === 'claude' ? { type: 'user', message: { content: text } } : prompt(text);
    await withLog(line(record('<system-reminder>ctx</system-reminder>')) + line(record(raw)), async session => {
      const origin = await readSessionOrigin(session);
      assert.equal(origin.state, 'available');
      assert.equal(origin.item.text, raw);
    }, { agent });
  }
});

test('an image request with context-only text remains unavailable instead of skipping the request', async () => {
  const first = { type: 'user', message: { content: [{ type: 'text', text: '<system-reminder>ctx</system-reminder>' }, { type: 'image', source: { data: 'image' } }] } };
  const later = { type: 'user', message: { content: 'later' } };
  await withLog(line(first) + line(later), async session => {
    assert.equal((await readSessionOrigin(session)).state, 'unavailable');
  }, { agent: 'claude' });
});

// Codex 0.171 revert: a new rollout file that keeps a prefix of an older one (`history_base`).
const reverted = base => line({ type: 'session_meta', payload: { id: 'a', history_mode: 'paginated', ...(base === undefined ? {} : { history_base: base }) } });

test('a reverted Codex thread cannot present the request after the revert as the initial one', async () => {
  const base = { thread_id: 'a', end_ordinal_exclusive: 5, end_byte_offset: 900 };
  await withLog(reverted(base) + line(prompt('巻き戻し後の依頼')), async session => {
    const origin = await readSessionOrigin(session);
    assert.equal(origin.state, 'unavailable');
    assert.equal(origin.item, null);
    assert.equal(origin.complete, false);
    assert.match(origin.reason, /巻き戻/);
  });
});

test('a paginated log without a kept prefix still starts at its own first request', async () => {
  for (const base of [undefined, null]) {
    await withLog(reverted(base) + line(prompt('最初の依頼')), async session => {
      const origin = await readSessionOrigin(session);
      assert.equal(origin.state, 'available');
      assert.equal(origin.item.text, '最初の依頼');
    });
  }
});

test('a fork that inherits a prefix is explained as a fork, not as a revert', async () => {
  const meta = line({ type: 'session_meta', payload: { id: 'b', forked_from_id: 'a', history_base: { thread_id: 'a', end_ordinal_exclusive: 5, end_byte_offset: 900 } } });
  await withLog(meta + line(prompt('fork 後の依頼')), async session => {
    const origin = await readSessionOrigin(session);
    assert.equal(origin.state, 'unavailable');
    assert.match(origin.reason, /派生/);
  });
});

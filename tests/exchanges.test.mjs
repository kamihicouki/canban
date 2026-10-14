import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseExchangeRecords, ExchangeIndex } from '../server/exchanges.mjs';

const session = (nativeId, extra = {}) => ({ id: `codex:${nativeId}`, nativeId, agent: 'codex', title: nativeId, ...extra });
const receipt = (source, text, id = 'm1', at = '2026-10-14T01:00:00Z') => ({ timestamp: at, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id, content: [{ type: 'text', text: `<codex_delegation>\n<source_thread_id>${source}</source_thread_id>\n<input>${text}</input>\n</codex_delegation>` }] } } });

test('only complete received envelopes establish a directed exchange; quoted and malformed inputs stay ordinary text', () => {
  const good = receipt('a', '比較 &lt; 3 &amp; 確認');
  const quote = receipt('a', 'x', 'q');
  quote.payload.item.content[0].text = `引用: ${quote.payload.item.content[0].text}`;
  const malformed = receipt('a', 'x', 'bad');
  malformed.payload.item.content[0].text = '<codex_delegation><source_thread_id>a</source_thread_id></codex_delegation>';
  const events = parseExchangeRecords([good, good, quote, malformed], session('b'));
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'a');
  assert.equal(events[0].target, 'b');
  assert.equal(events[0].text, '比較 < 3 & 確認');
});

test('repeated messages with different IDs are preserved; requesting a send alone is not a delivery', () => {
  const events = parseExchangeRecords([receipt('a', '同じ本文', '1'), receipt('a', '同じ本文', '2'),
    { type: 'response_item', payload: { type: 'function_call', name: 'send_message_to_thread', arguments: '{"threadId":"b","prompt":"依頼"}' } }], session('b'));
  assert.equal(events.length, 2);
});

test('Codex Desktop tool-output deliveries are collected once by their fco ID, including cross-read boundaries', async () => {
  const raw = receipt('a', 'received').payload.item.content[0].text;
  const output = { timestamp: '2026-10-14T01:00:00Z', type: 'response_item', payload: { type: 'function_call_output', id: 'fco_1', namespace: 'codex_app', name: 'send_message_to_thread', output: raw } };
  const completed = { ...output, type: 'event_msg', payload: { type: 'item_completed', item: { ...output.payload, type: 'FunctionCallOutput' } } };
  assert.equal(parseExchangeRecords([output, completed], session('b')).length, 1);
  assert.equal(parseExchangeRecords([completed], session('b'))[0].text, 'received');
  assert.equal(parseExchangeRecords([{ ...output, payload: { ...output.payload, namespace: 'unrelated_tool' } }], session('b')).length, 0);
});

test('legacy user_message and modern item_completed copies of one receipt are not counted twice', () => {
  const modern = receipt('a', 'received', 'message-1');
  const legacy = { timestamp: modern.timestamp, type: 'event_msg', payload: { type: 'user_message', message: modern.payload.item.content[0].text } };
  assert.equal(parseExchangeRecords([legacy, modern], session('b')).length, 1);
});

test('append boundaries reconcile legacy copies and fco copies while preserving distinct deliveries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canban-exchanges-'));
  try {
    const file = path.join(root, 'b.jsonl');
    const modern = receipt('a', 'first', 'modern');
    const legacy = { timestamp: modern.timestamp, type: 'event_msg', payload: { type: 'user_message', message: modern.payload.item.content[0].text } };
    const sessions = [session('a'), session('b', { sourcePath: file })];
    const index = new ExchangeIndex();
    await fs.writeFile(file, JSON.stringify(legacy) + '\n'); await index.sync(sessions);
    await fs.appendFile(file, JSON.stringify(modern) + '\n'); await index.sync(sessions);
    assert.equal(index.view('codex:b').events.length, 1);
    const output = { timestamp: modern.timestamp, type: 'response_item', payload: { type: 'function_call_output', id: 'fco_2', namespace: 'codex_app', name: 'send_message_to_thread', output: receipt('a', 'second').payload.item.content[0].text } };
    await fs.appendFile(file, JSON.stringify(output) + '\n'); await index.sync(sessions);
    const copy = { ...output, type: 'event_msg', payload: { type: 'item_completed', item: { ...output.payload, type: 'FunctionCallOutput' } } };
    await fs.appendFile(file, JSON.stringify(copy) + '\n'); await index.sync(sessions);
    assert.equal(index.view('codex:b').events.length, 2);
    assert.equal(index.summary('codex:b').received, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('explicit completed multi-agent interactions are collected without converting agent state into request completion', () => {
  const events = parseExchangeRecords([{ timestamp: '2026-10-14T01:00:00Z', type: 'event_msg', payload: {
    type: 'collab_agent_interaction_end', call_id: 'c', sender_thread_id: 'a', receiver_thread_id: 'child', prompt: '調査してください', status: 'running',
  } }], session('a'));
  assert.equal(events[0].source, 'a');
  assert.equal(events[0].target, 'child');
  assert.equal(events[0].text, '調査してください');
});

test('index exposes reciprocal directions and peer counts, preserves agent provenance, refreshes append/truncation/deletion', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canban-exchanges-'));
  try {
    const file = path.join(root, 'b.jsonl');
    const childFile = path.join(root, 'child.jsonl');
    await fs.writeFile(file, JSON.stringify(receipt('a', 'first', '1')) + '\n');
    await fs.writeFile(childFile, JSON.stringify(receipt('a', 'sub', 's')) + '\n');
    const sessions = [session('a', { children: ['codex:child'] }), session('b', { sourcePath: file }), session('child', { sourcePath: childFile, parentId: 'codex:a', subagent: true })];
    const index = new ExchangeIndex();
    await index.sync(sessions);
    assert.equal(index.summary('codex:a').sent, 1);
    assert.equal(index.summary('codex:b').received, 1);
    assert.equal(index.view('codex:a').events.find(e => e.peer.id === 'codex:child').peer.relation, 'subagent');
    assert.equal(index.view('codex:a').agents.length, 1);
    assert.deepEqual(index.view('codex:child').agents.map(a => a.id), ['codex:a']);
    await fs.appendFile(file, JSON.stringify(receipt('a', 'second', '2', '2026-10-14T01:01:00Z')) + '\n');
    await index.sync(sessions);
    assert.deepEqual(index.view('codex:b').events.map(e => e.text), ['second', 'first']);
    await fs.writeFile(file, JSON.stringify(receipt('unknown', 'replacement', '3')) + '\n');
    await index.sync(sessions);
    assert.equal(index.summary('codex:a').sent, 0);
    assert.equal(index.view('codex:b').events[0].peer.available, false);
    await fs.unlink(file);
    await index.sync(sessions);
    assert.equal(index.view('codex:b').events.length, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('equal native IDs on different hosts never merge; a truncated initial tail declares partial history', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canban-exchanges-'));
  try {
    const file = path.join(root, 'remote.jsonl');
    await fs.writeFile(file, '\n'.repeat(400) + JSON.stringify(receipt('a', 'remote', 'r')) + '\n');
    const sessions = [session('a'), session('b'), session('a', { id: 'codex:remote:a', host: { id: 'remote', local: false } }), session('b', { id: 'codex:remote:b', host: { id: 'remote', local: false } })];
    const index = new ExchangeIndex();
    await index.sync(sessions);
    assert.equal(index.summary('codex:a').sent, 0);
    // A separate locally readable home must also not borrow the default account's sender.
    await index.sync([session('a'), session('b', { id: 'other:b', homeDir: root, sourcePath: file })]);
    assert.equal(index.summary('codex:a').sent, 0);
    const short = new ExchangeIndex({ tailBytes: 350 });
    await short.sync([session('b', { sourcePath: file })]);
    assert.equal(short.view('codex:b').partial, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

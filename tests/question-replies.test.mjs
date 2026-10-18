import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPrompt } from '../server/sources/util.mjs';
import { codexItems } from '../server/feed.mjs';

const reply = entries => `<send_user_message_question_reply>\n${JSON.stringify(entries)}\n</send_user_message_question_reply>`;

test('a question reply displays the question and the selected answer without transport metadata', () => {
  const raw = reply([{ questionItemId: '["request_user_input_async","call_private",0]',
    question: '定期チェックの頻度は？', answer: '6時間ごと' }]);
  assert.equal(cleanPrompt(raw), '質問: 定期チェックの頻度は？\n\n回答: 6時間ごと');
});

test('multiple replies preserve their order, multiline text and question/answer pairing', () => {
  const raw = reply([
    { questionItemId: 'q1', question: '表示する内容は？\n本文と結果を選べます。', answer: '本文\n結果も読む' },
    { questionItemId: 'q2', question: 'テーマは？', answer: 'ダーク' },
  ]);
  assert.equal(cleanPrompt(raw), '質問: 表示する内容は？\n本文と結果を選べます。\n\n回答: 本文\n結果も読む\n\n質問: テーマは？\n\n回答: ダーク');
});

test('literal context tags inside a question or answer are preserved as user text', () => {
  const raw = reply([{ question: '<environment_context>例</environment_context>の意味は？',
    answer: '<system-reminder>参照用の文字</system-reminder>' }]);
  assert.equal(cleanPrompt(raw), '質問: <environment_context>例</environment_context>の意味は？\n\n回答: <system-reminder>参照用の文字</system-reminder>');
});

test('injected context surrounding the reply is still removed', () => {
  const raw = '<environment_context>実行環境</environment_context>\n' + reply([{ question: '頻度は？', answer: '6時間ごと' }]);
  assert.equal(cleanPrompt(raw), '質問: 頻度は？\n\n回答: 6時間ごと');
});

test('surrounding injected context cannot erase literal tags inside the reply envelope', () => {
  const raw = '<environment_context>実行環境</environment_context>\n' +
    reply([{ question: 'Q', answer: '<system-reminder>my answer</system-reminder>\n</send_user_message_question_reply>' }]) +
    '\n<system-reminder>外側の情報</system-reminder>';
  assert.equal(cleanPrompt(raw), '質問: Q\n\n回答: <system-reminder>my answer</system-reminder>\n</send_user_message_question_reply>');
});

test('unrecognized or incomplete reply payloads remain readable as their original text', () => {
  for (const raw of [
    '<send_user_message_question_reply>{broken}</send_user_message_question_reply>',
    reply([]), reply([{ question: '質問', answer: { selected: '回答' } }]),
    reply([{ question: '質問' }]), reply([{ question: 42, answer: '回答' }]),
    reply([{ question: '質問', answer: '回答' }, null]),
  ]) assert.equal(cleanPrompt(raw), raw);
});

test('ordinary messages and quoted examples are not mistaken for app replies', () => {
  const example = reply([{ question: '質問', answer: '回答' }]);
  for (const raw of ['6時間ごと', `例:\n${example}`, `\`\`\`xml\n${example}\n\`\`\``]) {
    assert.equal(cleanPrompt(raw), raw);
  }
});

test('both Codex log formats retain a reply as one user message with its original identity and time', () => {
  const text = reply([{ questionItemId: 'q1', question: 'テーマは？', answer: 'ライト' }]);
  for (const payload of [
    { type: 'user_message', message: text },
    { type: 'item_completed', item: { type: 'UserMessage', id: 'reply-1', content: [{ type: 'text', text }] } },
  ]) {
    const items = codexItems([{ timestamp: '2026-10-13T03:00:00+09:00', type: 'event_msg', payload }]);
    assert.equal(items.length, 1);
    assert.equal(items[0].k, 'user');
    assert.equal(items[0].text, '質問: テーマは？\n\n回答: ライト');
    assert.equal(items[0].at, '2026-10-13T03:00:00+09:00');
    if (payload.item) assert.equal(items[0].id, 'reply-1');
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../ui/task-detail.js', import.meta.url), 'utf8');
function helpers() {
  const context = vm.createContext({ STATUS_LABELS: { running: '実行中', completed: '完了' } });
  vm.runInContext(code + '\nthis.api = { taskHandoffQuote, appendTaskHandoffDraft };', context);
  return context.api;
}
test('handoff quote separates observed session status from proposed actions and never invents message time', () => {
  const { taskHandoffQuote } = helpers();
  const quote = taskHandoffQuote({ description: '目的の原文\n二行目', nextAction: '比較する', latestNoteSummary: { text: '報告', at: '2026-01-01T00:00:00Z' } }, { links: [{ title: '担当', status: 'completed', updatedAt: '2099-12-31T23:59:00Z', last: '返答原文' }] });
  assert.match(quote, /目的の原文\n二行目/);
  assert.match(quote, /提案[\s\S]*比較する/);
  assert.match(quote, /担当.*完了/);
  assert.match(quote, /返答原文/);
  assert.doesNotMatch(quote, /2099|23:59|人が確認|仕事は完了/);
});

test('report save retries with the same request ID, retains draft and selection, and never launches an agent', async () => {
  class Element {
    constructor(tag, attrs = {}, ...children) { this.tag = tag; Object.assign(this, attrs); this.children = children.flat().filter(Boolean); }
    // Native ParentNode.replaceChildren stringifies null/undefined; unlike h(), it does not omit them.
    replaceChildren(...children) { this.children = children.map(child => child instanceof Element ? child : String(child)); }
  }
  const calls = [], notices = [];
  let attempts = 0;
  const task = { description: '目的', nextAction: null, nextActionReport: null, revision: 0, notes: [], totalNotes: 0, nextCursor: null };
  const context = vm.createContext({
    h: (...args) => new Element(...args), keycap: () => [], STATUS_LABELS: {}, fmtDate: value => value,
    crypto: { randomUUID: () => 'retry-id' }, toast: message => notices.push(message),
    bridge: { async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'canban_get_task') return { task };
      if (name === 'canban_append_task_note') { if (!attempts++) throw new Error('通信失敗'); return { saved: true }; }
      throw new Error('unexpected agent action');
    } },
  });
  vm.runInContext(code + '\nthis.section = taskHandoffSection;', context);
  const prompt = { value: '下書き  原文\n', selectionStart: 2, selectionEnd: 5, focus() {}, dispatchEvent() {} };
  const composer = { draft: {} }, p = { id: 'task:test', taskCard: { links: [], handoff: { revision: 0 } } };
  const section = context.section(p, p.taskCard, prompt, composer);
  assert.equal(section.children[0].children.includes('null'), false, 'loading handoff must not render literal null');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(section.children[0].children.includes('null'), false, 'empty latest report must not render literal null');
  const history = section.children[4].children[0];
  await p.refreshTaskHandoff();
  assert.equal(section.children[4].children[0], history, 'unchanged live updates preserve the disclosure DOM and keyboard focus');
  await p.appendTaskReport();
  await p.appendTaskReport();
  const writes = calls.filter(call => call.name === 'canban_append_task_note');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].args.clientRequestId, writes[1].args.clientRequestId);
  assert.equal(writes[0].args.text, prompt.value);
  assert.equal(prompt.value, '下書き  原文\n');
  assert.equal(prompt.selectionStart, 2); assert.equal(prompt.selectionEnd, 5);
  assert.deepEqual([...new Set(calls.map(call => call.name))], ['canban_get_task', 'canban_append_task_note']);
});
test('quoting appends to existing draft exactly, dispatches input, and never sends or replaces a selection', () => {
  const { appendTaskHandoffDraft } = helpers();
  const events = [];
  const input = { value: '入力中の原文  \n', selectionStart: 2, selectionEnd: 4, dispatchEvent: e => events.push(e.type), focus() {} };
  appendTaskHandoffDraft(input, '引継ぎ原文', class { constructor(type) { this.type = type; } });
  assert.equal(input.value, '入力中の原文  \n\n\n引継ぎ原文');
  assert.deepEqual(events, ['input']);
  appendTaskHandoffDraft(input, '引継ぎ原文', class { constructor(type) { this.type = type; } });
  assert.equal(input.value, '入力中の原文  \n\n\n引継ぎ原文', 'repeated shortcut does not duplicate the same quote');
});

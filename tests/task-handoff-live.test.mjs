import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Store } from '../server/store.mjs';
import { taskTools } from '../server/tools/tasks.mjs';
import { taskHandoffSummary } from '../server/task-handoff.mjs';

const source = fs.readFileSync(new URL('../ui/task-detail.js', import.meta.url), 'utf8');
const overlay = fs.readFileSync(new URL('../ui/card-overlay.js', import.meta.url), 'utf8');
const reconcile = overlay.slice(overlay.indexOf('function reconcileCards('), overlay.indexOf('// ---- sheets:', overlay.indexOf('function reconcileCards(')));
class Element {
  constructor(tag, attrs = {}, ...children) { this.tag = tag; Object.assign(this, attrs); this.children = children.flat().filter(Boolean); }
  replaceChildren(...children) { this.children = children.map(child => child instanceof Element ? child : String(child)); }
  get textContent() { return this.text ?? this.children.map(child => child.textContent ?? child).join(''); }
  set textContent(text) { this.text = text; this.children = []; }
}
async function setup(t, holdFirst = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-handoff-live-'));
  const store = new Store(dir), other = new Store(dir);
  t.after(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { cardId } = await store.createTask({ title: '共同の仕事', description: '仕事の目的' });
  await store.appendTaskNote({ taskId: cardId, text: '最初の報告', nextAction: '提案A', expectedRevision: 0, clientRequestId: 'initial' });
  const tools = new Map(taskTools({ store }).map(tool => [tool.name, tool]));
  const pending = [], calls = [];
  let release, started, failReads = false;
  const firstStarted = new Promise(resolve => { started = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const boardCard = async () => { const c = (await store.load()).cards[cardId]; return { ...c, id: cardId, handoff: taskHandoffSummary(c), links: [{ id: 'codex:observed', title: '担当会話', status: 'running', last: '担当の返答' }] }; };
  const p = { id: cardId, kind: 'task', taskCard: await boardCard(), el: new Element('article') };
  const doc = { activeElement: null };
  const prompt = { value: '編集中の文\n', selectionStart: 2, selectionEnd: 4, dispatchEvent() {}, focus() { doc.activeElement = this; }, setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; } };
  const context = vm.createContext({ h: (...args) => new Element(...args), keycap: () => [], STATUS_LABELS: { running: '実行中', waiting: '入力待ち' }, fmtDate: value => value, Event,
    toast() {}, document: doc, panes: [p], paneLayer: { hidden: false }, $: () => null, paintTaskRelated() {}, paneDocked: () => true,
    bridge: { callTool(name, args) {
      calls.push(name);
      const first = calls.length === 1;
      const job = (async () => { if (failReads && name === 'canban_get_task') throw new Error('引継ぎ取得失敗'); const result = (await tools.get(name).handler(args)).structured; if (holdFirst && first) { started(); await hold; } return result; })();
      pending.push(job); return job;
    } },
  });
  vm.runInContext(source + '\n' + reconcile + '\nthis.create = taskHandoffSection; this.reconcile = reconcileCards;', context);
  const section = context.create(p, p.taskCard, prompt, { draft: {} });
  const settle = async () => { for (let i = 0; i < 5; i++) { const count = pending.length; await Promise.all(pending); await new Promise(resolve => setImmediate(resolve)); if (count === pending.length) return; } throw new Error('unbounded handoff refresh'); };
  const update = async () => context.reconcile({ lists: [{ cards: [await boardCard()] }] });
  const append = () => other.appendTaskNote({ taskId: cardId, text: '別エージェントの報告B', nextAction: '提案B', expectedRevision: 1, clientRequestId: 'other-agent' });
  return { p, prompt, doc, section, context, boardCard, calls, append, update, settle, firstStarted, release, other, taskId: cardId, failReads: () => { failReads = true; } };
}

test('normal board reconciliation updates open handoff and quote from another agent without replacing draft or history focus', async t => {
  const f = await setup(t);
  await f.settle();
  const history = f.section.children[4].children[0];
  const historySummary = history.children[0]; history.open = true;
  f.doc.activeElement = historySummary;
  const reads = f.calls.length;
  await f.update(); await f.settle();
  assert.equal(f.calls.length, reads, 'unchanged board revision does not re-fetch');
  const changedStatus = await f.boardCard(); changedStatus.links[0].status = 'waiting';
  f.context.reconcile({ lists: [{ cards: [changedStatus] }] }); await f.settle();
  assert.match(f.section.textContent, /入力待ち/);
  assert.equal(f.calls.length, reads, 'session status does not re-fetch saved task');
  assert.equal(f.section.children[4].children[0], history);
  assert.equal(history.children[0], historySummary);
  await f.append(); await f.update(); await f.settle();
  assert.match(f.section.textContent, /提案B/);
  assert.match(f.section.textContent, /別エージェントの報告B/);
  assert.equal(f.prompt.value, '編集中の文\n');
  assert.equal(f.prompt.selectionStart, 2); assert.equal(f.prompt.selectionEnd, 4);
  assert.equal(f.section.children[4].children[0], history);
  assert.equal(history.open, true); assert.equal(f.doc.activeElement, historySummary);
  f.p.quoteTaskHandoff();
  assert.match(f.prompt.value, /提案B/); assert.doesNotMatch(f.prompt.value, /提案A/);
});

test('board revision arriving during an older read is coalesced into one follow-up before allowing a quote', async t => {
  const f = await setup(t, true);
  await f.firstStarted;
  await f.append(); await f.update(); await f.update();
  const before = f.prompt.value;
  f.p.quoteTaskHandoff(); assert.equal(f.prompt.value, before, 'unconfirmed quote is not inserted');
  f.release(); await f.settle();
  assert.equal(f.calls.length, 2, 'one follow-up read coalesces identical board changes');
  assert.match(f.section.textContent, /提案B/);
  f.p.quoteTaskHandoff(); assert.match(f.prompt.value, /提案B/); assert.doesNotMatch(f.prompt.value, /提案A/);
});

test('refresh retains previously opened history pages and their note nodes', async t => {
  const f = await setup(t);
  await f.settle();
  for (let i = 0; i < 11; i++) await f.other.appendTaskNote({ taskId: f.taskId, text: `既読報告${i}`, clientRequestId: `history${i}` });
  await f.update(); await f.settle();
  await f.p.loadMoreTaskNotes(); await f.settle();
  const details = f.section.children[4].children[0], body = details.children[1];
  const lastReadNote = body.children.at(-1);
  assert.match(lastReadNote.textContent, /既読報告10/);
  await f.other.appendTaskNote({ taskId: f.taskId, text: 'あとから届いた報告', clientRequestId: 'new-report' });
  await f.update(); await f.settle();
  assert.ok(body.children.includes(lastReadNote), 'refresh must keep already loaded pages and their reading anchor');
  await f.p.loadMoreTaskNotes(); await f.settle();
  assert.match(body.children.at(-1).textContent, /あとから届いた報告/);
});

test('a filtered-out open task refreshes reports while labelling linked session states as a previous snapshot', async t => {
  const f = await setup(t);
  await f.settle();
  await f.append();
  f.context.reconcile({ lists: [] }); await f.settle();
  assert.match(f.section.textContent, /提案B/);
  assert.match(f.section.textContent, /前回一覧.*未確認/);
  assert.equal(f.prompt.value, '編集中の文\n');
  f.p.quoteTaskHandoff();
  assert.match(f.prompt.value, /提案B/);
  assert.match(f.prompt.value, /前回一覧.*未確認/);
});

test('failed forced refresh never re-enables quoting an old task just because its revision matches the old board', async t => {
  const f = await setup(t);
  await f.settle();
  f.failReads();
  assert.equal(await f.p.refreshTaskHandoff(true), false);
  assert.match(f.section.textContent, /引継ぎは未確認/);
  const before = f.prompt.value;
  f.p.quoteTaskHandoff();
  assert.equal(f.prompt.value, before);
  assert.equal(f.section.children[3].children[0].disabled, true, 'quote button remains disabled after failed read');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read = name => fs.readFileSync(new URL(`../ui/${name}`, import.meta.url), 'utf8');

function fixture(cards) {
  const state = { board: { lists: [{ id: 'work', cards }] } }, document = { activeElement: null };
  class Node {
    constructor(tag, attrs = {}, ...children) {
      this.tag = tag; this.attrs = attrs; this.dataset = {}; this.children = []; this.events = {}; this.scrollTop = 0;
      Object.assign(this, attrs);
      for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
      this.append(...children);
    }
    append(...children) { for (const c of children.flat().filter(Boolean)) { this.children.push(c); if (c instanceof Node) c.parent = this; } }
    replaceChildren(...children) { this.children = []; this.append(...children); this.scrollTop = 0; }
    addEventListener(name, fn) { this.events[name] = fn; }
    matches(selector) {
      const attr = selector.match(/\[([^=]+)="([^"]+)"\]/);
      if (attr && this.attrs[attr[1]] !== attr[2]) return false;
      const cls = selector.match(/^\.([\w-]+)/);
      return cls ? (this.class || '').split(' ').includes(cls[1]) : this.tag === selector;
    }
    querySelectorAll(selector) { return this.children.flatMap(c => c instanceof Node ? [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)] : []); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
    contains(node) { return node === this || this.children.some(c => c instanceof Node && c.contains(node)); }
    setAttribute(k, v) { this.attrs[k] = v; }
    focus() { document.activeElement = this; }
    scrollIntoView() {}
  }
  let root;
  const opened = [], resumed = [];
  const ctx = { state, document, CSS: { escape: x => x }, h: (...args) => new Node(...args),
    timelineOn: () => true, paneDocked: () => false, panes: [], PANE_MODES: [],
    faceGlyph: () => new Node('span'), faceWho: () => new Node('span'), dotPill: () => null, exchangePill: () => null,
    fmtDate: x => String(x), relTime: x => String(x), prefetchSession() {},
    openCard: id => opened.push(id), resume: id => resumed.push(id),
    $: (selector, parent = root) => parent?.querySelector(selector.replace(/^#board /, '')),
    $$: selector => root.querySelectorAll(selector.replace(/^#board /, '')),
  };
  const timeline = read('lifetime.js').slice(read('lifetime.js').indexOf('const TIMELINE_GROUP_CAP ='));
  const model = vm.runInNewContext(read('lifetime-model.js') + '\n' + timeline + '\n' + read('inbox.js') + '\n({ renderInbox, refreshInboxList, inboxStep, inboxSelect });', ctx);
  root = model.renderInbox(state.board);
  return { state, root, model, document, opened, resumed, rows: () => root.querySelectorAll('.irow'), list: () => root.querySelector('.inbox-list') };
}
const children = () => [
  { id: 'old', title: '古い会話', status: 'completed', updatedAt: 1 },
  { id: 'run', title: '実行中', status: 'running', activity: '型を調査', updatedAt: 4 },
  { id: 'wait', title: '質問待ち', status: 'waiting', signals: { wait: 'question', waitText: '追加しますか？' }, updatedAt: 2 },
  { id: 'error', title: '中断', status: 'aborted', updatedAt: 3 },
];

test('the timeline keeps a job and its urgent sessions together without duplicating standalone sessions', () => {
  const links = children();
  const f = fixture([{ id: 'job', title: '決済フォーム', kind: 'task', status: 'waiting', links, updatedAt: 4 }, links[2]]);
  assert.deepEqual(f.rows().map(r => r.dataset.cardId), ['job', 'wait', 'error', 'run']);
  const waiting = f.root.querySelector('.irow[data-card-id="wait"]');
  assert.equal(waiting.querySelector('.irow-w').text, '質問: 追加しますか？');
  assert.equal(waiting.attrs.role, 'option');
  const more = f.root.querySelector('.irow-more');
  assert.equal(more.tag, 'button'); assert.equal(more.closest('.irow'), null);
  more.onclick();
  assert.deepEqual(f.rows().map(r => r.dataset.cardId), ['job', 'wait', 'error', 'run', 'old']);
});

test('keyboard next enters the child session and refreshing only the list preserves focus and scroll', () => {
  const links = children();
  const f = fixture([{ id: 'job', title: '仕事', kind: 'task', status: 'waiting', links, updatedAt: 4 }]);
  f.model.inboxStep(1);
  assert.equal(f.opened.at(-1), 'wait');
  assert.equal(f.document.activeElement.dataset.cardId, 'wait');
  f.list().scrollTop = 123;
  links[2].signals.waitText = '更新後の質問';
  f.model.refreshInboxList();
  assert.equal(f.list().scrollTop, 123);
  assert.equal(f.document.activeElement.dataset.cardId, 'wait');
  assert.equal(f.document.activeElement.querySelector('.irow-w').text, '質問: 更新後の質問');
  assert.equal(f.opened.length, 1, 'list updates never reopen the selected conversation');
});

test('collapsing keeps a selected late child visible without changing the opened card', () => {
  const f = fixture([{ id: 'job', title: '仕事', kind: 'task', status: 'waiting', links: children(), updatedAt: 4 }]);
  f.root.querySelector('.irow-more').onclick();
  f.model.inboxSelect('old', { focus: true });
  f.root.querySelector('.irow-more').onclick();
  assert.deepEqual(f.rows().map(r => r.dataset.cardId), ['job', 'wait', 'error', 'old']);
  assert.equal(f.document.activeElement.dataset.cardId, 'old');
  assert.equal(f.opened.at(-1), 'old');
});

test('when a live update removes the more button, focus returns to its task row', () => {
  const task = { id: 'job', title: '仕事', kind: 'task', status: 'waiting', links: children(), updatedAt: 4 };
  const f = fixture([task]);
  f.root.querySelector('.irow-more').focus();
  task.links = task.links.slice(0, 2);
  f.model.refreshInboxList();
  assert.equal(f.document.activeElement.dataset.cardId, 'job');
  assert.equal(f.opened.length, 0);
});


test('timeline o continues sessions through the guarded resume action and leaves tasks alone', () => {
  const f = fixture([{ id: 'job', title: '仕事', kind: 'task', status: 'waiting', links: children(), updatedAt: 4 }]);
  const press = (row, extra = {}) => {
    const event = { target: row, key: 'o', preventDefault() { this.prevented = true; }, stopPropagation() {}, ...extra };
    row.events.keydown(event);
    return event;
  };
  const task = f.rows()[0], session = f.rows()[1];
  assert.equal(press(task).prevented, undefined);
  assert.equal(press(session).prevented, true);
  assert.deepEqual(f.resumed, [session.dataset.cardId]);
  press(session, { ctrlKey: true });
  press(session, { target: session.children[0] });
  assert.equal(f.resumed.length, 1, 'typing and modified keys never resume a session');
});

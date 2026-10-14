import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture() {
  const src = fs.readFileSync(new URL('../ui/card-overlay.js', import.meta.url), 'utf8');
  const detach = src.slice(src.indexOf('function restorePaneReading('), src.indexOf('function newPane('));
  const paint = src.slice(src.indexOf('function renderPaneKeepingDrafts('), src.indexOf('async function changeSessionCardState('));
  const live = { feeds: new Map() }, panes = [], paneCache = new Map();
  const workspace = { draftValues: new Map(), hasDrafts: () => false };
  const feed = (height = 1000) => ({ scrollTop: height, scrollHeight: height, clientHeight: 200 });
  const context = { live, panes, paneCache, workspace, PANE_CACHE_MAX: 16,
    promptDrafts: new Map(), clearInterval() {}, cardSizeObserver: { unobserve() {} },
    atFeedEnd: el => el.scrollHeight - el.scrollTop - el.clientHeight < 48,
    scrollFeedToEnd: f => { f.list.scrollTop = f.list.scrollHeight; },
    $: (selector, el) => selector === '.feed' ? el.feed : selector === '.th-conv' ? { replaceChildren(list) { el.feed = list; } } : null,
    renderPane(p, d) { p.d = d; p.el.feed = feed(d.height); live.feeds.set(p.id, { list: p.el.feed }); },
    renderFeed(d, p) { const list = feed(d.height); live.feeds.set(p.id, { list }); return list; },
  };
  vm.runInNewContext(detach + paint + '\nthis.detach = detachPane; this.paint = renderPaneKeepingDrafts; this.show = typeof restorePaneReading === "function" ? restorePaneReading : () => {};', context);
  const card = id => {
    const el = { feed: feed(), requestEditor: false, querySelector() { return this.requestEditor; }, querySelectorAll: () => [],
      remove() { if (this.feed) this.feed.scrollTop = 0; } }; // Detached DOM cannot be relied on for a visible scroll position.
    el.feed.scrollTop = 100;
    const p = { id, el }; panes.push(p); live.feeds.set(id, { list: el.feed }); return p;
  };
  return { card, paint: (p, d = { feed: {}, height: 1000 }) => { context.show(p); context.paint(p, d); }, show: context.show, detach: context.detach };
}

test('timeline card repaint preserves the position while reading earlier messages', () => {
  const f = fixture(), p = f.card('a'); f.paint(p); assert.equal(p.el.feed.scrollTop, 100);
});
test('timeline card repaint follows new content when the reader was at the end', () => {
  const f = fixture(), p = f.card('a'); p.el.feed.scrollTop = 800;
  f.paint(p, { feed: {}, height: 1100 }); assert.equal(p.el.feed.scrollTop, 1100);
});
test('timeline selection remembers each conversation independently', () => {
  const f = fixture(), a = f.card('a'); f.detach(a);
  const b = f.card('b'); b.el.feed.scrollTop = 300; f.detach(b);
  f.paint(a); f.paint(b);
  assert.equal(a.el.feed.scrollTop, 100); assert.equal(b.el.feed.scrollTop, 300);
});
test('a task selection does not overwrite a cached session position', () => {
  const f = fixture(), p = f.card('a'); f.detach(p);
  const task = f.card('task'); task.el.feed = null; f.detach(task);
  f.paint(p); assert.equal(p.el.feed.scrollTop, 100);
});
test('refreshing a conversation with a request editor preserves its reading position', () => {
  const f = fixture(), p = f.card('a'); p.el.requestEditor = true;
  f.paint(p); assert.equal(p.el.feed.scrollTop, 100);
});

test('scrolling while a reselected conversation loads takes precedence over its cached position', () => {
  const f = fixture(), p = f.card('a'); f.detach(p); f.show(p);
  p.el.feed.scrollTop = 300; f.paint(p); assert.equal(p.el.feed.scrollTop, 300);
});

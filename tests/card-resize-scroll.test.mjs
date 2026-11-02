import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function resizeFixture() {
  const overlay = fs.readFileSync(new URL('../ui/card-overlay.js', import.meta.url), 'utf8');
  const realtime = fs.readFileSync(new URL('../ui/realtime.js', import.meta.url), 'utf8');
  const observer = overlay.slice(overlay.indexOf('const cardSizeObserver ='), overlay.indexOf('const applyCardWidths ='));
  const scrolling = realtime.slice(realtime.indexOf('const atFeedEnd ='), realtime.indexOf('function paintFeedFoot'));
  const list = { scrollTop: 800, scrollHeight: 1000, clientHeight: 200 };
  const target = { isConnected: true, style: { setProperty() {} } };
  const feed = { list, newBtn: { hidden: false } };
  const frames = [];
  let resize;
  const live = { feeds: new Map([['fixture', feed]]) };
  vm.runInNewContext(scrolling + observer, {
    panes: [{ id: 'fixture', el: target }], live,
    ResizeObserver: class { constructor(callback) { resize = callback; } },
    requestAnimationFrame: callback => frames.push(callback),
  });
  return { list, target, feed, live, resize: () => resize([{ target, contentRect: { height: 650 } }]),
    flush: () => frames.splice(0).forEach(callback => callback()) };
}

test('a queued card resize cannot send a reader who scrolled up back to the end', () => {
  const f = resizeFixture();
  f.resize();
  f.list.scrollTop = 100; // User scrolls after observing the resize, before the next frame.
  f.flush();
  assert.equal(f.list.scrollTop, 100);
});

test('a card resize keeps following when the reader stays at the end', () => {
  const f = resizeFixture();
  f.resize();
  f.list.scrollHeight = 1100;
  f.flush();
  assert.equal(f.list.scrollTop, 1100);
  assert.equal(f.feed.newBtn.hidden, true);
});

test('a queued resize never scrolls a detached card or a replacement feed', () => {
  for (const replace of [false, true]) {
    const f = resizeFixture();
    f.resize();
    if (replace) f.live.feeds.set('fixture', { list: {} });
    else f.target.isConnected = false;
    f.flush();
    assert.equal(f.list.scrollTop, 800);
  }
});

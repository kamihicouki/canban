// Optional browser regression: node --test tests/conversation-scroll.browser.mjs
// Requires Playwright and its Chromium. CANBAN_PLAYWRIGHT_PACKAGE may point to an
// existing package.json; CANBAN_BROWSER_EXECUTABLE may select an installed Chrome.
// Uses assembled UI styles and feed functions with fictional data, without a host.
import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { boardHtml } from '../server/ui.mjs';

test('conversation scrolling stays inside the feed across layouts and live updates', async t => {
  const require = createRequire(process.env.CANBAN_PLAYWRIGHT_PACKAGE || import.meta.url);
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CANBAN_BROWSER_EXECUTABLE ? { executablePath: process.env.CANBAN_BROWSER_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const html = boardHtml();
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const previews = fs.readFileSync(new URL('../ui/message-preview.js', import.meta.url), 'utf8');
  const helpers = source.slice(source.indexOf('function h('), source.indexOf('const colorVar ='));
  // The folded conversation (feedPush, tool groups, edit summary) lives in thread.js, the feed itself in realtime.js.
  const folded = source.slice(source.indexOf('const TOOL_KINDS = ['), source.indexOf('// ---- the thread layout ----'));
  const feed = source.slice(source.indexOf('const TOOL_ICONS ='), source.indexOf('// ---- the long poll ----'));
  assert.ok(helpers && folded && feed, 'the feed code must still be found in board.html');

  // The session card is the thread layout (renderThreadPane): the conversation fills .th-conv above the input dock.
  for (const layout of [
    { width: 1400, height: 320 },
    { width: 1400, height: 560 },
    { width: 1400, height: 800 },
    { width: 1400, height: 800, side: true },
    { width: 390, height: 560, stack: true },
  ]) await t.test(`${layout.width}px / ${layout.height}px${layout.side ? ' / 詳細パネル' : ''}`, async () => {
    const page = await browser.newPage({ viewport: { width: layout.width, height: 900 } });
    try {
      await page.setContent(`<style>${css}</style>
        <div class="pane-layer${layout.stack ? ' stack' : ''}">
          <div class="pane-stage"><div class="pane-row">
            <article class="pane" data-kind="session" style="height:${layout.height}px">
              <div class="th-head">会話スクロール検証</div>
              <div class="th-title"><h2>架空のセッション</h2></div>
              <div class="th-body">
                <div class="th-main">
                  <div class="th-conv" data-sec="conv"></div>
                  <div class="th-dock" data-sec="send"><textarea rows="3">入力欄</textarea></div>
                </div>
                <aside class="th-side"${layout.side ? '' : ' hidden'}><div class="th-side-b" style="height:1600px">詳細</div></aside>
              </div>
            </article>
          </div></div>
        </div>`);
      await page.addScriptTag({ content: String.raw`${helpers}
        const live = { feeds: new Map() }, panes = [], STATUS_LABELS = { idle: '完了' }, WAIT_TEXT = {};
        const $ = (s, el = document) => el.querySelector(s), $$ = (s, el = document) => [...el.querySelectorAll(s)];
        const picon = () => '', exchangeModel = { messageText: text => text, delivery: () => null };
        const paintChoices = () => {}, kickLive = () => {}, refreshDispatch = () => {}, openCard = () => {}, paintThreadStat = () => {};
        const paintExchangeTimeline = () => {}, scheduleExchangeRefresh = () => {}, renderSignals = () => document.createElement('div');
        const activityText = value => value || '', fmtDate = () => '', mdHtml = text => text;
        ${previews}
        ${folded}
        ${feed}
        const pane = { id: 'fixture', el: document.querySelector('.pane') };
        const items = Array.from({ length: 80 }, (_, i) => i % 2
          ? { k: 'assistant', text: '架空の返答 ' + i, at: '2026-10-16T00:00:00Z' }
          : { k: 'user', text: '架空の依頼 ' + i, at: '2026-10-16T00:00:00Z' });
        items.splice(1, 0, { k: 'tool', id: 'tool:1', state: 'ok', name: 'Bash', summary: '架空の実行結果',
          out: Array.from({ length: 50 }, (_, i) => '結果 ' + i).join('\n') });
        document.querySelector('.th-conv').append(renderFeed({ session: { id: 'fixture', status: 'idle' },
          feed: { items, offset: 1, size: 1 } }, pane));
        window.fixture = live.feeds.get('fixture');
      ` });
      const metrics = () => page.evaluate(() => {
        const f = window.fixture, body = f.list.closest('.th-conv'), column = f.list.closest('.th-body');
        return { top: f.list.scrollTop, max: f.list.scrollHeight - f.list.clientHeight,
          bodyTop: body.scrollTop, bodyHeight: body.clientHeight, bodyContent: body.scrollHeight,
          columnTop: column.scrollTop, stageTop: document.querySelector('.pane-stage').scrollTop };
      });
      const wheel = async delta => {
        await page.locator('.feed').hover({ position: { x: 30, y: 10 } });
        await page.mouse.wheel(0, delta);
        await page.waitForTimeout(150);
      };
      const initial = await metrics();
      assert.ok(initial.bodyContent <= initial.bodyHeight + 1, 'footer must fit without a second scrollbar');
      assert.ok(initial.max > 0, 'long conversation must overflow inside the feed');
      await wheel(200);
      assert.ok((await metrics()).top > 0, 'wheel scrolls the conversation');
      await wheel(-200);
      assert.ok((await metrics()).top < 200, 'wheel can scroll back up');

      for (const end of ['top', 'bottom']) {
        await page.evaluate(end => { const el = window.fixture.list; el.scrollTop = end === 'top' ? 0 : el.scrollHeight; }, end);
        await wheel(end === 'top' ? -200 : 200);
        const m = await metrics();
        assert.equal(m.bodyTop, 0, 'wheel must not move the conversation area');
        assert.equal(m.columnTop, initial.columnTop, 'wheel must not move the card body');
        assert.equal(m.stageTop, initial.stageTop, 'wheel must not move the dashboard');
      }

      await page.evaluate(() => { window.fixture.list.scrollTop = 200; });
      const reading = (await metrics()).top;
      await page.evaluate(() => applyFeed(window.fixture, { items: [{ k: 'commentary', text: '新着' }], offset: 2, size: 2 }));
      assert.equal((await metrics()).top, reading, 'live updates preserve the reading position');
      assert.equal(await page.locator('.feed-new').isVisible(), true);
      await page.evaluate(() => scrollFeedToEnd(window.fixture));
      await page.evaluate(() => applyFeed(window.fixture, { items: [{ k: 'commentary', text: '次の新着' }], offset: 3, size: 3 }));
      const following = await metrics();
      assert.ok(Math.abs(following.top - following.max) < 1, 'live updates follow the end when already there');

      await page.evaluate(() => {
        const list = window.fixture.list;
        list.scrollTop = 0;
        list.querySelector('.tg-head').click();
        list.querySelector('.fi-tool').open = true;
        list.scrollTop = list.querySelector('pre').getBoundingClientRect().top - list.getBoundingClientRect().top;
      });
      const beforeTool = (await metrics()).top;
      await page.locator('.fi-tool pre').hover({ position: { x: 30, y: 5 } });
      await page.mouse.wheel(0, 100);
      await page.waitForTimeout(150);
      assert.ok(await page.locator('.fi-tool pre').evaluate(el => el.scrollTop > 0), 'expanded tool output scrolls');
      assert.equal((await metrics()).top, beforeTool, 'scrolling inside tool output leaves the conversation in place');
    } finally { await page.close(); }
  });
});

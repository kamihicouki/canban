// Optional browser regression: node --test tests/conversation-scroll.browser.mjs
// Requires Playwright and its Chromium. CANBAN_PLAYWRIGHT_PACKAGE may point to an
// existing package.json; CANBAN_BROWSER_EXECUTABLE may select an installed Chrome.
// Uses assembled UI styles and feed functions with fictional data, without a host.
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
  const helpers = source.slice(source.indexOf('function h('), source.indexOf('const colorVar ='));
  const feed = source.slice(source.indexOf('const TOOL_ICONS ='), source.indexOf('// ---- the long poll ----'));

  for (const layout of [
    { width: 1400, col: 'main', height: 64 },
    { width: 1400, col: 'main', height: 180 },
    { width: 1400, col: 'main', height: 460 },
    { width: 1400, col: 'side', height: 460 },
    { width: 390, col: 'main', height: 180, stack: true },
  ]) await t.test(`${layout.width}px / ${layout.col} / ${layout.height}px`, async () => {
    const page = await browser.newPage({ viewport: { width: layout.width, height: 900 } });
    try {
      await page.setContent(`<style>${css}</style>
        <div class="pane-layer${layout.stack ? ' stack' : ''}" style="left:0">
          <div class="pane-stage scrolls"><div class="pane-canvas">
            <article class="pane" data-size="L" style="left:12px;top:12px;width:860px;height:800px">
              <div class="pane-h">会話スクロール検証</div><div class="pane-b">
                <div class="pcol" data-col="main"></div><div class="column-split"></div>
                <div class="pcol" data-col="side"></div>
              </div>
            </article>
          </div></div>
        </div>`);
      await page.addScriptTag({ content: String.raw`${helpers}
        const live = { feeds: new Map() }, STATUS_LABELS = { idle: '完了' }, WAIT_TEXT = {};
        const $ = (s, el = document) => el.querySelector(s);
        const kickLive = () => {}, updateNoteLine = () => {}, refreshDispatch = () => {};
        const activityText = value => value || '', fmtDate = () => '', mdHtml = text => text;
        ${feed}
        const pane = { el: document.querySelector('.pane') };
        const column = document.querySelector('.pcol[data-col="${layout.col}"]');
        const section = h('section', { class: 'psec', 'data-sec': 'conv',
          style: { '--section-height': '${layout.height}px' } },
          h('div', { class: 'psec-h', text: '会話' }), h('div', { class: 'psec-b' }));
        column.append(section, h('div', { style: { height: '900px' }, text: '次のセクション' }));
        const items = Array.from({ length: 80 }, (_, i) => ({ k: 'commentary', text: '会話 ' + i }));
        items[0] = { k: 'tool', id: 'tool:1', state: 'ok', name: 'exec', summary: '架空の実行結果',
          out: Array.from({ length: 50 }, (_, i) => '結果 ' + i).join('\n') };
        section.querySelector('.psec-b').append(renderFeed({ session: { id: 'fixture', status: 'idle' },
          feed: { items, offset: 1, size: 1 } }, pane));
        window.fixture = live.feeds.get('fixture');
      ` });
      const metrics = () => page.evaluate(() => {
        const f = window.fixture, body = f.list.closest('.psec-b'), column = f.list.closest('.pcol');
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
        assert.equal(m.bodyTop, 0, 'wheel must not move the section');
        assert.equal(m.columnTop, initial.columnTop, 'wheel must not move the card column');
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
        list.querySelector('details').open = true;
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

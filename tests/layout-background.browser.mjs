// Optional browser regression: node --test tests/layout-background.browser.mjs
// Uses assembled application CSS under the transparent document canvas of an MCP host.
// CANBAN_PLAYWRIGHT_PACKAGE and CANBAN_BROWSER_EXECUTABLE select an existing browser runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { boardHtml } from '../server/ui.mjs';

test('application paints the board when the host makes the document transparent', async t => {
  const require = createRequire(process.env.CANBAN_PLAYWRIGHT_PACKAGE || import.meta.url);
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CANBAN_BROWSER_EXECUTABLE ? { executablePath: process.env.CANBAN_BROWSER_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const css = boardHtml().match(/<style>([\s\S]*?)<\/style>/)[1];
  for (const theme of ['light', 'dark']) {
    for (const layout of ['board']) {
      await t.test(`${layout} / ${theme}`, async () => {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        try {
          await page.setContent(`<html data-theme="${theme}"><head><style>${css}</style></head>
            <body style="background: transparent !important">
              <div class="app-content"><header class="topbar">canban</header>
                <div class="boardbar">ボード</div><div class="shell">
                  <aside class="sidebar">ワークスペース</aside><main class="board"></main>
                </div></div>
            </body></html>`);
          const surface = await page.locator('.app-content').evaluate(el => {
            const style = getComputedStyle(el), rect = el.getBoundingClientRect();
            return { image: style.backgroundImage, width: rect.width, height: rect.height,
              start: style.getPropertyValue('--board-bg').trim(), end: style.getPropertyValue('--board-bg-2').trim(),
              bodyImage: getComputedStyle(document.body).backgroundImage };
          });
          assert.equal(surface.bodyImage, 'none', 'host canvas reset must remain in effect');
          assert.match(surface.image, /^linear-gradient\(/, 'application must paint its own background');
          assert.equal(surface.width, 1280);
          assert.equal(surface.height, 800);
          assert.notEqual(surface.start, surface.end, 'the board keeps its two-color gradient');
          assert.match(surface.image, theme === 'light' ? /rgb\(0, 121, 191\)/ : /rgb\(11, 42, 74\)/);
        } finally { await page.close(); }
      });
    }
  }
});

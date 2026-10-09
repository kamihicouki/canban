// Isolated acceptance: fictional dot cache, no cloud API or agent execution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { makeFixtures } from './helpers.mjs';
import { dotFixture } from './fixtures/dots.mjs';
import { Store } from '../server/store.mjs';

test('dot visibility, cloud restrictions and board/time-axis screenshots in Chrome', { timeout: 120000 }, async t => {
  const root = path.resolve('.'), fx = makeFixtures();
  await fs.mkdir(path.join(root, '.local'), { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, '.local/dots-browser-'));
  await fs.writeFile(path.join(fx.codexHome, '.codex-global-state.json'), JSON.stringify(dotFixture()));
  const store = new Store(dir); await store.load();
  const task = await store.createTask({ title: '予約ページの改善', description: 'dotの調査を受け取って次の作業へ進めます。' });
  await store.linkSession({ taskId: task.cardId, sessionId: 'codex:dot-related' });
  const port = 5000 + Math.floor(Math.random() * 1000);
  const host = spawn(process.execPath, ['tests/dev-host.mjs', String(port)], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    CANBAN_DATA_DIR: dir, CANBAN_CODEX_HOME: fx.codexHome, CANBAN_CLAUDE_HOME: fx.claudeHome, CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir,
    CANBAN_LAUNCH_DRYRUN: '1', CANBAN_BACKGROUND: '0', CANBAN_SEARCH_INDEX: '0', CANBAN_GH: path.join(root, 'tests/fake-gh.sh'), CANBAN_GLAB: path.join(root, 'tests/fake-glab.sh'), FAKE_GH_DATA: '/dev/null' } });
  t.after(async () => { try { process.kill(-host.pid, 'SIGTERM'); } catch {} await store.close(); fx.cleanup(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dev host did not start')), 30000);
    host.stdout.on('data', d => { if (d.toString().includes('dev host:')) { clearTimeout(timer); resolve(); } });
    host.on('exit', c => { clearTimeout(timer); reject(new Error(`host exited ${c}`)); });
  });
  const require = createRequire(process.env.CANBAN_PLAYWRIGHT_PACKAGE || import.meta.url), { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, ...(process.env.CANBAN_BROWSER_EXECUTABLE ? { executablePath: process.env.CANBAN_BROWSER_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const palette = async text => { await page.keyboard.press('Meta+k'); await page.locator('.palette input').fill(text); await page.locator('.palette .picker-row').first().click(); };
  const call = (name, args = {}) => page.evaluate(async ({ name, args }) => (await (await fetch('/rpc', { method: 'POST', body: JSON.stringify({ name, arguments: args }) })).json()).result, { name, args });
  await page.goto(`http://127.0.0.1:${port}/direct?theme=light`);
  await page.locator(`.card[data-card-id="${task.cardId}"]`).waitFor();
  assert.equal(await page.locator('.card[data-card-id="codex:dot-created"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'dotを除く を外す' }).count(), 1);
  await page.locator('#sideBtn').focus(); await page.keyboard.press('Shift+v');
  await page.locator('.card.face[data-card-id="codex:dot-created"] .dot-pill').waitFor({ timeout: 10000 }).catch(async e => {
    await page.screenshot({ path: path.join(dir, 'failure.png') });
    console.error('dot state', await page.locator('#filterChips').innerText(), errors);
    throw e;
  });
  await palette('dotのセッションだけ表示');
  await page.locator('.filter-chip').filter({ hasText: 'dotだけ' }).waitFor();
  assert.equal(await page.locator('.card.face:not(.task):not([data-card-id="codex:dot-created"])').count(), 0);
  await page.getByRole('button', { name: 'dotだけ を外す' }).click();
  await page.locator('.card.face[data-card-id="codex:dot-created"]').waitFor();
  await page.locator('#q').fill('zz-no-matching-session-for-dot-clear');
  await page.locator('.card.face').first().waitFor({ state: 'hidden' });
  await palette('絞り込みをすべて解除');
  await page.locator('.card.face[data-card-id="codex:dot-created"]').waitFor();
  assert.equal(await page.locator('#q').inputValue(), '');
  assert.equal(await page.locator('.filter-chip').count(), 0);
  await page.locator('#sideBtn').focus();
  const screenshots = path.join(root, 'docs/design/dot-sessions'); await fs.mkdir(screenshots, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await palette(`色: ${theme === 'light' ? 'ライト' : 'ダーク'}`);
    await page.screenshot({ path: path.join(screenshots, `board-${theme}.png`) });
    await page.keyboard.press('i'); await page.locator('.irow[data-card-id="codex:dot-created"] .dot-pill').waitFor();
    await page.locator(`.irow[data-card-id="${task.cardId}"]`).click();
    await page.locator('.inbox-main .flink-row .glyph[aria-label="状態未取得"]').waitFor();
    await page.screenshot({ path: path.join(screenshots, `timeline-${theme}.png`) });
    await page.keyboard.press('i'); await page.locator('.card.face[data-card-id="codex:dot-created"]').waitFor();
  }
  await page.locator('.card.face[data-card-id="codex:dot-created"]').click();
  await page.locator('.pane .dot-pill').waitFor();
  assert.equal(await page.locator('.pane textarea[aria-label="送るプロンプト"]').count(), 0);
  assert.ok(await page.getByText('状態未取得', { exact: true }).count());
  await page.keyboard.press('d'); await page.locator('.th-side:not([hidden])').waitFor();
  assert.equal(await page.locator('.resume-box').getByRole('button', { name: '新規ウィンドウ', exact: true }).count(), 0);
  await page.locator('.th-side details[data-sec="detail"] summary').click();
  await page.getByText('保存済み情報の更新', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(screenshots, 'detail-dark.png') });
  const terminal = await call('canban_open_session', { cardId: 'codex:dot-created', route: 'terminal' });
  assert.equal(terminal.isError, true); assert.match(JSON.stringify(terminal), /クラウド/);
  const changes = await call('canban_get_changes', { cardId: 'codex:dot-created', path: '/cloud/never-read' });
  assert.equal(changes.structuredContent.result.available, false);
  const archive = await call('canban_set_session_card_state', { cardId: 'codex:dot-created', action: 'archive' });
  assert.equal(archive.isError, true);
  await store.updateLaunchSettings({ route: 'terminal' });
  const opened = await call('canban_open_session', { cardId: 'codex:dot-created' });
  assert.equal(opened.structuredContent.route, 'desktop'); assert.equal(opened.structuredContent.url, 'codex://threads/dot-created?hostId=durable');
  await page.keyboard.press('Escape'); await page.locator('#paneLayer').waitFor({ state: 'hidden' });
  await page.locator(`.card.face[data-card-id="${task.cardId}"]`).click();
  await page.locator('.pane .start-grid').waitFor();
  assert.match(await page.locator('.pane .start-grid').innerText(), /このマシン/);
  await page.locator('.pane .start-grid button').click();
  assert.doesNotMatch(await page.locator('.popover').innerText(), /Codex Cloud/);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape'); await page.locator('#paneLayer').waitFor({ state: 'hidden' });
  // Legacy reply path: a session with no desktop route and dispatch switched off.
  await page.route('**/rpc', async route => {
    const a = route.request().postDataJSON();
    if (a.name !== 'canban_get_session' || a.arguments?.cardId !== 'claude:c2') return route.continue();
    const response = await route.fetch(), json = await response.json();
    json.result.structuredContent.launch.desktop = null;
    json.result.structuredContent.dispatch.settings.enabled = false;
    await route.fulfill({ response, json });
  });
  await page.locator('#sideBtn').focus(); await page.keyboard.press('i');
  await page.locator('.irow[data-card-id="claude:c2"]').click();
  await page.getByText('指示の送信は設定でオフになっています。', { exact: true }).waitFor();
  assert.doesNotMatch(await page.locator('.inbox-main').innerText(), /\bnull\b/);
  await page.locator('#sideBtn').focus(); await page.keyboard.press('i');
  await page.locator('.side-sec-filters button').filter({ hasText: /^dotだけ$/ }).click();
  await page.locator('.filter-chip').filter({ hasText: 'dotだけ' }).waitFor();
  await page.reload(); await page.locator('.filter-chip').filter({ hasText: 'dotだけ' }).waitFor();
  assert.deepEqual(errors, []);
});

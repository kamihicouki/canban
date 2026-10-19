// Isolated fictional categories. Only UI preferences may be written; no prompt or approval is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { makeFixtures } from './helpers.mjs';
test('category navigation remains selectable without remembering names', { timeout: 120000 }, async t => {
  const fx = makeFixtures(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-categories-'));
  const root = path.resolve('.'), port = 6200 + Math.floor(Math.random() * 300);
  const host = spawn(process.execPath, ['tests/dev-host.mjs', String(port)], { cwd: root, env: { ...process.env,
    CANBAN_DATA_DIR: dir, CANBAN_CODEX_HOME: fx.codexHome, CANBAN_CLAUDE_HOME: fx.claudeHome, CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir,
    CANBAN_LAUNCH_DRYRUN: '1', CANBAN_BACKGROUND: '0', CANBAN_SEARCH_INDEX: '0', CANBAN_GH: path.join(root, 'tests/fake-gh.sh'), CANBAN_GLAB: path.join(root, 'tests/fake-glab.sh'), FAKE_GH_DATA: '/dev/null',
  } });
  t.after(() => { host.kill(); fx.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://localhost:${port}`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  const { chromium } = createRequire(process.env.CANBAN_PLAYWRIGHT_PACKAGE || import.meta.url)('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CANBAN_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }), errors = [], prohibited = [];
  page.on('pageerror', e => errors.push(e.message));
  const directories = Array.from({ length: 30 }, (_, i) => ({ id: `fiction-${i}`, name: i === 29 ? '名前を忘れたプロジェクト' : `架空カテゴリ ${String(i).padStart(2,'0')}`, color: 'blue', count: i % 5 }));
  await page.route('**/rpc', async route => {
    const req = route.request(), name = req.method() === 'POST' ? req.postDataJSON()?.name : '';
    if (/^canban_(send_prompt|dispatch|approve|start_session)/.test(name)) { prohibited.push(name); return route.abort(); }
    if (name === 'canban_get_board') {
      const res = await route.fetch(), json = await res.json();
      json.result.structuredContent.directories = directories;
      return route.fulfill({ response: res, json });
    }
    return route.continue();
  });
  await page.goto(`http://localhost:${port}/direct`);
  await page.locator('#sidebar .side-dir').first().waitFor();
  const shotDir = process.env.CANBAN_CATEGORY_SHOTS;
  if (shotDir) fs.mkdirSync(shotDir, { recursive: true });
  const before = process.env.CANBAN_CATEGORY_BEFORE === '1';
  const metrics = { viewport: '1280x800', categories: 31, initialRows: await page.locator('#sidebar .side-dir').count() };
  if (before) {
    for (const theme of ['light','dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      if (shotDir) await page.screenshot({ path: path.join(shotDir, `before-${theme}.png`) });
    }
    console.log(JSON.stringify(metrics)); return;
  }
  assert.equal(metrics.initialRows, 5);
  await page.getByRole('button', { name: 'すべてのカテゴリ…', exact: true }).click();
  const picker = page.locator('.category-picker'), search = picker.getByRole('searchbox');
  assert.equal(await picker.locator('.category-choice').count(), 31, 'empty search exposes every category including zero counts');
  await picker.getByRole('button', { name: '名前を忘れたプロジェクト', exact: false }).filter({ has: page.locator('.grow') }).click();
  await page.locator('#sidebar .side-dir[data-dir-id="fiction-29"]').waitFor();
  assert.equal(await page.locator('#sidebar .side-dir').count(), 6, 'unpinned selected category remains visible');
  await page.getByRole('button', { name: 'すべてのカテゴリ…', exact: true }).click();
  await search.fill('名前を忘れた');
  assert.equal(await picker.locator('.category-choice').count(), 1);
  const savedPins = page.waitForResponse(r => r.url().endsWith('/rpc') && r.request().postDataJSON()?.name === 'canban_save_ui_state');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Alt+p');
  assert.equal(await picker.getByRole('button', { name: '名前を忘れたプロジェクト を固定解除', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('Tab');
  assert.equal(await picker.locator('.category-pin').evaluate(el => el === document.activeElement), true, 'pin is its own keyboard target');
  await page.keyboard.press('Escape');
  await savedPins;
  await page.reload();
  await page.locator('#sidebar .side-dir[data-dir-id="fiction-29"]').waitFor();
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('sk:categoryPins'))), ['fiction-0','fiction-1','fiction-2','fiction-3','fiction-4','fiction-29']);
  // Existing global sidebar search must still find categories outside the pinned set.
  await page.getByRole('searchbox', { name: 'サイドバーを絞り込み' }).fill('架空カテゴリ 28').catch(async () => page.getByRole('textbox', { name: 'サイドバーを絞り込み' }).fill('架空カテゴリ 28'));
  await page.locator('#sidebar .side-dir[data-dir-id="fiction-28"]').waitFor();
  await page.locator('.side-filter').first().fill('');
  const command = async label => { await page.keyboard.press('Meta+k'); await page.locator('.palette input').fill(label); await page.locator('.palette .picker-row').filter({ hasText: label }).click(); };
  for (const [layout, label] of [['trello','Trello'],['classic','定番'],['rail','レール'],['omni','オムニバー'],['hud','ライブ HUD']]) {
    await command(`レイアウト: ${label}`);
    await page.locator('#sideBtn').focus(); await page.keyboard.press('Alt+c');
    await picker.waitFor(); assert.equal(await picker.locator('.category-choice').count(), 31);
    await page.keyboard.press('Escape');
  }
  await command('レイアウト: Trello');
  for (const view of ['board','timeline']) {
    if (view === 'timeline') await command('時間軸で表示');
    await page.getByRole('button', { name: 'すべてのカテゴリ…', exact: true }).click();
    for (const theme of ['light','dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      if (shotDir) await page.screenshot({ path: path.join(shotDir, `${view}-${theme}.png`) });
    }
    await page.keyboard.press('Escape');
  }
  await page.keyboard.press('Meta+k');
  await page.locator('.palette input').fill('すべてのカテゴリを選ぶ'); await page.keyboard.press('Enter');
  await picker.waitFor();
  await search.fill('存在しない名前'); assert.equal(await picker.locator('.category-choice').count(), 0);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.equal(await picker.isVisible(), true);
  await page.keyboard.press('Escape');
  await page.locator('.side-sec-lanes button').filter({ hasText: /^カテゴリ$/ }).click();
  await page.keyboard.press('Alt+c');
  assert.equal(await picker.count(), 0, 'category lanes cannot acquire a hidden directory filter');
  await page.keyboard.press('Meta+k');
  await page.locator('.palette input').fill('すべてのカテゴリを選ぶ');
  assert.equal(await page.locator('.palette .picker-row').count(), 0);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('sk:filters')).directory), '');
  await page.locator('.side-sec-lanes button').filter({ hasText: /^なし$/ }).click();
  await page.getByRole('button', { name: 'すべてのカテゴリ…', exact: true }).click();
  const pinned = picker.locator('.category-pin[aria-pressed="true"]');
  while (await pinned.count()) await pinned.first().click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#sidebar .side-dir').count(), 0, 'an explicit empty pinned list remains empty');
  assert.equal(await page.getByRole('button', { name: 'すべてのカテゴリ…', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'カテゴリを管理', exact: true }).count(), 1);
  assert.deepEqual(errors, []); assert.deepEqual(prohibited, []);
  metrics.emptyPinnedRows = await page.locator('#sidebar .side-dir').count();
  console.log(JSON.stringify(metrics));
});

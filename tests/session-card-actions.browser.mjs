// Browser integration and 1280x800 screenshots with fictional source data.
// Run with CANBAN_PLAYWRIGHT_PACKAGE and CANBAN_BROWSER_EXECUTABLE if using an existing browser runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { makeFixtures } from './helpers.mjs';
const require = createRequire(process.env.CANBAN_PLAYWRIGHT_PACKAGE || import.meta.url);
const { chromium } = require('playwright');
const root = process.cwd(), fx = makeFixtures();
function writable(dir) { fs.chmodSync(dir,0o755); for (const entry of fs.readdirSync(dir,{withFileTypes:true})) { const target=path.join(dir,entry.name); if(entry.isDirectory()) writable(target); else fs.chmodSync(target,0o644); } }
writable(fx.codexHome);
fs.writeFileSync(path.join(fx.codexHome,'.canban-lifecycle-fixture'),'fixture');
fs.mkdirSync(path.join(root, '.local'), {recursive:true});
const dataDir = fs.mkdtempSync(path.join(root, '.local/session-actions-data-'));
const output = path.join(root, '.local/session-actions-screenshots');
fs.mkdirSync(output, { recursive: true });
const host = spawn(process.execPath, ['tests/dev-host.mjs', '4598'], { cwd: root, env: { ...process.env, CANBAN_DATA_DIR: dataDir, CANBAN_CODEX_BIN: path.join(root,'tests/fixtures/codex-lifecycle.mjs'), CANBAN_CODEX_HOME: fx.codexHome, CANBAN_CLAUDE_HOME: fx.claudeHome, CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir, CANBAN_LAUNCH_DRYRUN: '1', CANBAN_SEARCH_INDEX: '0', CANBAN_GH: path.join(root, 'tests/fake-gh.sh'), CANBAN_GLAB: path.join(root, 'tests/fake-glab.sh'), FAKE_GH_DATA: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'] });
let hostLog = ''; host.stdout.on('data', b => hostLog += b); host.stderr.on('data', b => hostLog += b);
let browser;
try {
  for (let i=0; i<100; i++) { try { if ((await fetch('http://localhost:4598')).ok) break; } catch {} await new Promise(r => setTimeout(r,100)); }
  browser = await chromium.launch({ headless: true, ...(process.env.CANBAN_BROWSER_EXECUTABLE ? {executablePath:process.env.CANBAN_BROWSER_EXECUTABLE} : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/direct', async route => { const response = await route.fetch(); const html = await response.text(); const i = html.lastIndexOf('})();'); assert.ok(i > 0); await route.fulfill({response, body: html.slice(0,i) + 'globalThis.__test = {setThemePref,state,load,bridge,openCard,closeCards};\n' + html.slice(i)}); });
  await page.goto('http://localhost:4598/direct');
  await page.waitForSelector('.card[data-card-id="codex:t1"]');
  await page.locator('.card[data-card-id="codex:t1"]').click();
  await page.waitForSelector('[data-pane-key="z"]');
  for (const theme of ['light', 'dark']) for (const layout of ['board']) {
    await page.evaluate(({theme,layout}) => { __test.setThemePref(theme); }, {theme,layout});
    await page.waitForTimeout(150);
    const actions = page.locator('.dsec[data-sec="actions"]');
    await assert.doesNotReject(() => actions.getByRole('button', { name: /アーカイブ/ }).click({trial:true}));
    await page.screenshot({path: path.join(output, `${layout}-${theme}.png`)});
  }
  await page.evaluate(() => { __test.setThemePref('light'); });
  const prompt = page.locator('.pane .prompt-composer textarea').first();
  await prompt.fill('入力途中の文章');
  await prompt.press('Escape');
  await page.keyboard.press('Delete');
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({state:'visible'});
  await page.screenshot({path: path.join(output,'delete-confirmation.png')});
  assert.match(await page.locator(':focus').innerText(), /キャンセル/);
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'detached'});
  assert.equal(await prompt.inputValue(), '入力途中の文章');
  await page.locator('.pane').first().focus();
  await page.keyboard.press('z');
  await page.waitForSelector('.pane', {state:'detached'});
  assert.equal(await page.locator('.card[data-card-id="codex:t1"]').count(), 0);
  await page.evaluate(async () => { __test.state.filters.includeArchived = true; await __test.load(); });
  await page.waitForSelector('.card[data-card-id="codex:t1"].is-archived');
  await page.locator('.card[data-card-id="codex:t1"]').click();
  await page.getByRole('button', { name: /アーカイブから戻す/ }).click();
  await page.waitForSelector('.pane', {state:'detached'});
  assert.equal(await page.locator('.card[data-card-id="codex:t1"].is-archived').count(), 0);
  // The palette must keep the session that was focused before its own input took focus.
  const taskId = await page.evaluate(async () => {
    const task = await __test.bridge.callTool('canban_create_task', {title:'Palette owner'});
    await __test.bridge.callTool('canban_link_session', {taskId:task.cardId,sessionId:'codex:t1'});
    await __test.load(); await __test.openCard(task.cardId); return task.cardId;
  });
  await page.locator('.pane[data-kind="session"]').focus();
  await page.keyboard.press('Meta+k');
  const paletteInput = page.locator('.popover.palette input');
  await paletteInput.fill('セッションと会話履歴を削除');
  await page.keyboard.press('Enter');
  await page.getByRole('dialog').waitFor({state:'visible'});
  assert.match(await page.getByRole('dialog').innerText(), /ログイン修正/);
  await page.keyboard.press('Escape');
  await page.evaluate(async taskId => {
    __test.closeCards(); await __test.bridge.callTool('canban_delete_task',{cardId:taskId}); await __test.load();
  }, taskId);
  await page.locator('.card[data-card-id="codex:t1"]').click();
  await page.getByRole('button', { name: /セッションを削除/ }).click();
  await page.getByRole('dialog').getByRole('button', {name:'セッションを削除',exact:true}).click();
  await page.waitForSelector('dialog', {state:'detached'});
  assert.equal(await page.locator('.card[data-card-id="codex:t1"]').count(), 0);
  await page.evaluate(async () => { __test.state.filters.includeArchived = true; await __test.load({refresh:true}); });
  assert.equal(await page.locator('.card[data-card-id="codex:t1"]').count(), 0);
  assert.equal(fs.existsSync(path.join(fx.codexHome,'sessions/rollout-a.jsonl')), false);
  await page.locator('.card[data-card-id="claude:c2"]').click();
  assert.equal(await page.locator('[data-pane-key="z"]').isDisabled(), true);
  assert.match(await page.locator('.dsec[data-sec="actions"]').innerText(), /Claudeで操作/);
  assert.equal(await page.getByText('ボードから隠す',{exact:true}).count(), 0);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,screenshots:11,viewport:'1280x800',layouts:5,themes:2,archiveRestore:true,deleteCancelDraft:true,deletePersists:true,nativeFixtureHistoryDeleted:true,claudeUnsupportedIsExplicit:true,browserErrors:errors}));
} catch(e) { console.error(e); console.error(hostLog.slice(-2000)); process.exitCode=1; }
finally { await browser?.close(); host.kill('SIGTERM'); fx.cleanup(); fs.rmSync(dataDir, {recursive:true,force:true}); }

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { boardHtml } from '../server/ui.mjs';

test('Desktop waiting and cancellation retain the composer draft with keyboard actions', async t => {
  const { chromium } = createRequire(process.env.CANBAN_PLAYWRIGHT_PACKAGE || import.meta.url)('playwright');
  t.diagnostic('launch isolated Chrome');
  const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  t.after(() => browser.close());
  const html = boardHtml(), script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const helpers = script.slice(script.indexOf('function h('), script.indexOf('const colorVar ='));
  t.diagnostic('open fixture page');
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  t.diagnostic('render fixture');
  await page.setContent('<div id="feedback" role="status"></div>');
  await page.addScriptTag({ content: `${helpers}
    const accountName = a => a === 'claude:a' ? 'A' : 'B';
    const bridge = { callTool: async name => ({result:{state:name==='canban_get_start_session'?'opened':'cancelled'}}) };
    const sessionRunsInCloud = () => false;
    ${fs.readFileSync(new URL('../ui/task-quick-add.js',import.meta.url),'utf8')}
    taskQuickAdd.feedback = document.querySelector('#feedback');
    taskQuickAdd.targets = { desktopCapabilities: { activeAccount:'claude:a', accountSwitch:true } };
    taskQuickAdd.sessionDraft = {agent:'claude',route:'desktop',account:'claude:b',prompt:'保持する本文',attachments:{imageIds:['img-a']},startRequest:{clientRequestId:'pending'}};
    taskQuickAdd.paintSessionState = () => {};
    window.ui = taskQuickAdd;
    window.ui.showSessionFeedback({state:'waiting-for-quit',reason:'Desktopを保存して終了してください'});
  ` });
  assert.match(await page.locator('#feedback').textContent(), /保存して終了/);
  const cancel = page.getByRole('button', { name: '開始待機を取り消す' });
  await cancel.focus(); await page.keyboard.press('Enter');
  assert.match(await page.locator('#feedback').textContent(), /取り消/);
  assert.deepEqual(await page.evaluate(() => [ui.sessionDraft.prompt, ui.sessionDraft.attachments.imageIds]), ['保持する本文',['img-a']]);
  assert.match(await page.evaluate(() => { ui.sessionDraft.startRequest = null; return ui.sessionActionLabel(); }), /A → B に切り替えて開く/);
  await page.evaluate(() => { ui.showSessionFeedback({state:'waiting-for-login',reason:'状態を確認できません'}); });
  assert.match(await page.locator('#feedback').textContent(), /状態を確認できません/);
  await page.evaluate(() => { ui.dialog={open:true}; ui.sessionDraft.startRequest={clientRequestId:'resuming'}; ui.showSessionFeedback({state:'waiting-for-quit'}); });
  await page.waitForFunction(() => ui.sessionDraft.startResult?.state === 'opened', null, {timeout:6000});
});

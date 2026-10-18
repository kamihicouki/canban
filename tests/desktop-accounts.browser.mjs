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
    taskQuickAdd.sessionDraft = {agent:'claude',route:'desktop',account:'claude:cli',desktopAccount:'claude:b',prompt:'保持する本文',attachments:{imageIds:['img-a']},startRequest:{clientRequestId:'pending'}};
    taskQuickAdd.paintSessionState = () => {};
    window.ui = taskQuickAdd;
    window.ui.showSessionFeedback({state:'waiting-for-quit',reason:'Desktopを保存して終了してください'});
  ` });
  assert.match(await page.locator('#feedback').textContent(), /保存して終了/);
  const cancel = page.getByRole('button', { name: '開始待機を取り消す' });
  await cancel.focus(); await page.keyboard.press('Enter');
  assert.match(await page.locator('#feedback').textContent(), /取り消/);
  assert.deepEqual(await page.evaluate(() => [ui.sessionDraft.prompt, ui.sessionDraft.attachments.imageIds]), ['保持する本文',['img-a']]);
  assert.match(await page.evaluate(() => { ui.sessionDraft.startRequest = null; return ui.sessionActionLabel(); }), /B で Claude を開く/);
  assert.match(await page.evaluate(() => { ui.sessionDraft.route='terminal'; return ui.sessionActionLabel(); }), /Claude Codeを開始/);
  await page.evaluate(() => { ui.sessionDraft.route='desktop'; });
  await page.evaluate(() => { ui.showSessionFeedback({state:'waiting-for-login',reason:'状態を確認できません'}); });
  assert.match(await page.locator('#feedback').textContent(), /状態を確認できません/);
  await page.evaluate(() => { ui.dialog={open:true}; ui.sessionDraft.startRequest={clientRequestId:'resuming'}; ui.showSessionFeedback({state:'waiting-for-quit'}); });
  await page.waitForFunction(() => ui.sessionDraft.startResult?.state === 'opened', null, {timeout:6000});

  const accountsPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await accountsPage.route('http://localhost/**', route => route.fulfill({contentType:'text/html',body:'<button id="accountsBtn">アカウント</button><main></main>'}));
  await accountsPage.goto('http://localhost/accounts-fixture');
  await accountsPage.addScriptTag({ content: `${helpers}
    const $ = selector => document.querySelector(selector);
    const state = {board:{accounts:{accounts:[{key:'claude:a',agent:'claude',label:'A'},{key:'claude:b',agent:'claude',label:'B'},{key:'claude:c',agent:'claude',label:'C'}]}}};
    let pending = {account:'claude:b',active:true};
    const bridge = {callTool:async(name,input)=>{
      if(name==='canban_desktop_accounts')return {result:{accountSwitch:false,profiles:[{account:'claude:a',active:true}],pending}};
      if(input.type==='cancel'){pending.active=false;return {result:{state:'cancelled'}};}
      if(input.type==='begin-login'){pending={account:input.account,active:true};return {result:{state:'waiting-for-login'}};}
      return {result:{state:'prepared'}};
    }};
    ${fs.readFileSync(new URL('../ui/accounts.js',import.meta.url),'utf8')}
    document.querySelector('main').append(desktopAccountsSection());
  ` });
  await accountsPage.waitForFunction(() => document.querySelector('.acct-desktop [role="status"]') && !document.querySelector('.acct-desktop [role="status"]').textContent.includes('確認中'), null, {timeout:3000});
  assert.equal(await accountsPage.getByRole('button', { name: '初回接続を取り消す', exact: true }).count(), 1, await accountsPage.locator('main').textContent());
  await accountsPage.getByRole('button', { name: '初回接続を取り消す', exact: true }).click();
  await accountsPage.waitForFunction(() => !document.querySelector('.acct-desktop-actions')?.textContent.includes('Desktop の接続を確認'), null, {timeout:3000});
  const resume = accountsPage.getByRole('button', { name: /初回接続を再開/ });
  assert.equal(await resume.count(), 1);
  await resume.focus(); await accountsPage.keyboard.press('Enter');
  await accountsPage.getByRole('button', { name: '初回接続を取り消す', exact: true }).click();
  await accountsPage.getByLabel('Desktop に接続するアカウント').selectOption('claude:c');
  await accountsPage.getByRole('button', { name: '別の Desktop を初回接続', exact: true }).click();
  await accountsPage.waitForFunction(() => document.querySelector('.acct-desktop-actions')?.textContent.includes('Desktop の接続を確認'));
});

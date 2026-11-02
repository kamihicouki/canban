import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { boardHtml } from '../server/ui.mjs';

test('Desktop picker is searchable inside a dialog, independent of CLI, and retains resume cancellation', async t => {
  const {chromium}=createRequire(process.env.CANBAN_PLAYWRIGHT_PACKAGE||import.meta.url)('playwright');
  const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1280,height:800}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const html=boardHtml(), script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const helpers=script.slice(script.indexOf('function h('),script.indexOf('const colorVar ='));
  await page.route('http://localhost/**', r=>r.fulfill({contentType:'text/html',body:'<button id="accountsBtn">アカウント</button><dialog><main></main></dialog><div id="resume"></div>'}));
  await page.goto('http://localhost/desktop-fixture');
  await page.addScriptTag({content:`${helpers}
    const $=s=>document.querySelector(s), state={board:{accounts:{accounts:[{key:'claude:a',agent:'claude'},{key:'claude:b',agent:'claude'},{key:'claude:c',agent:'claude'}]}}};
    const accountName=a=>({'claude:a':'A','claude:b':'B','claude:c':'C'}[a]||a), picon=()=>'', keycap=()=>[];
    const taskQuickAdd={dialog:null}, calls=[], toasts=[]; const toast=(...x)=>toasts.push(x);
    const view={accountSwitch:true,activeAccount:'claude:a',lastAccount:'claude:b',profiles:[{account:'claude:a',active:true},{account:'claude:b',active:false}],setup:{}};
    const bridge={callTool:async(name,args)=>{calls.push({name,args});return name==='canban_desktop_accounts'?{result:view}:name==='canban_open_session'?{state:'waiting-for-quit',clientRequestId:args.clientRequestId,account:args.desktopAccount,reason:'保存して終了してください'}:name==='canban_get_start_session'?{result:{state:'waiting-for-quit'}}:{result:{state:'cancelled'}};}};
    const accountsMenu=()=>{window.setupOpened=true;};
    ${fs.readFileSync(new URL('../ui/popover.js',import.meta.url),'utf8')}
    ${fs.existsSync(new URL('../ui/desktop-accounts.js',import.meta.url))?fs.readFileSync(new URL('../ui/desktop-accounts.js',import.meta.url),'utf8'):''}
    window.fixture={calls,view};
  `});
  assert.equal(await page.evaluate(()=>typeof desktopAccountPicker),'function','cards and creation need the same Desktop picker');
  await page.evaluate(()=>{document.querySelector('dialog main').append(desktopAccountPicker({key:'create',onChange:a=>window.selected=a}));document.querySelector('dialog').showModal();});
  await page.waitForFunction(()=>window.selected==='claude:b');
  await page.getByRole('button',{name:'Desktop の起動アカウント',exact:true}).click();
  await page.getByRole('textbox',{name:'Desktop の起動アカウントを絞り込み'}).fill('claude:a');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>window.selected),'claude:a');
  assert.equal(await page.evaluate(()=>fixture.calls.some(c=>c.name==='canban_set_claude_execution')),false);
  await page.evaluate(()=>document.querySelector('dialog').close());
  await page.evaluate(()=>{document.querySelector('#resume').append(desktopResumeControl('claude:test'));});
  await page.getByRole('button',{name:/B で Claude を開く/}).click();
  await page.waitForFunction(()=>document.querySelector('#resume').textContent.includes('保存して終了'));
  await page.getByRole('button',{name:'再開待機を取り消す',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#resume').textContent.includes('取り消しました'));
  assert.equal(await page.evaluate(()=>fixture.calls.filter(c=>c.name==='canban_open_session').length),1);
  assert.equal(await page.evaluate(()=>fixture.calls.find(c=>c.name==='canban_open_session').args.desktopAccount),'claude:b');
  await page.evaluate(()=>{fixture.view.pendingLaunches=[{operation:'resume',cardId:'claude:restored',account:'claude:a',clientRequestId:'persisted-resume',state:'waiting-for-quit',reason:'終了待ちを復元'}];document.querySelector('#resume').replaceChildren(desktopResumeControl('claude:restored'));});
  await page.waitForFunction(()=>document.querySelector('#resume').textContent.includes('終了待ちを復元'));
  await page.getByRole('button',{name:'再開待機を取り消す',exact:true}).click();
  assert.equal(await page.evaluate(()=>fixture.calls.filter(c=>c.name==='canban_cancel_start_session').at(-1).args.clientRequestId),'persisted-resume');
  await page.evaluate(async()=>{
    fixture.view.accountSwitch=false;fixture.view.pendingLaunches=[];
    desktopAccounts.resumes.clear();
    document.querySelector('#resume').replaceChildren(desktopResumeControl('claude:verification-required'));
    await desktopAccounts.refresh();
  });
  const gatedLaunch=page.locator('#resume [data-resume-desktop]');
  await page.waitForFunction(()=>document.querySelector('#resume [data-resume-desktop]').textContent.includes('B'));
  assert.equal(await gatedLaunch.isEnabled(),false,'an unverified account switch must not promise to open Desktop');
  assert.match(await gatedLaunch.innerText(),/保持確認/);
  assert.match(await page.locator('#resume').innerText(),/Desktop の現在のアカウント: A/);
  await page.getByRole('button',{name:'Desktop の接続・保持確認',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.setupOpened),true);
  await page.evaluate(()=>{fixture.view.activeAccount='claude:b';window.dispatchEvent(new Event('focus'));});
  await page.waitForFunction(()=>document.querySelector('#resume').textContent.includes('Desktop の現在のアカウント: B'));
  assert.equal(await gatedLaunch.isEnabled(),true,'returning from Desktop refreshes availability without changing the selection');
  assert.match(await gatedLaunch.innerText(),/B で Claude を開く/);
  assert.equal(await page.evaluate(()=>fixture.calls.filter(c=>c.name==='canban_open_session').length),1,'refreshing account status never launches');
  assert.deepEqual(errors,[]);
});

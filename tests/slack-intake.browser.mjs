// Isolated Chrome acceptance; no real Slack, credentials, accounts or user data.
// CANBAN_PLAYWRIGHT_PACKAGE and CANBAN_BROWSER_EXECUTABLE select an existing runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { makeFixtures } from './helpers.mjs';
import { Store } from '../server/store.mjs';
import { SlackStore } from '../server/slack-store.mjs';
import { slackMessage } from '../server/slack-model.mjs';

test('Slack intake through Chrome and ten layout/theme screenshots', { timeout: 120000 }, async t => {
  const root=path.resolve('.'),dir=path.join(root,'.local/slack-browser'),fx=makeFixtures();
  await fs.rm(dir,{recursive:true,force:true}); await fs.mkdir(dir,{recursive:true});
  const store=new Store(dir), db=new SlackStore(dir);await store.load();
  const workspace={id:'TDEMO',name:'プロジェクトチーム',url:'https://example.slack.com/',userId:'UDEMO'};
  const channel={id:'CDEMO',name:'#制作依頼',directory:'__none'};
  await db.saveWorkspace(workspace);await db.selectChannels({workspaceId:workspace.id,channels:[channel]});
  const parent=slackMessage(workspace,channel,{ts:'1791200000.000001',user:'田中',text:'見積もりをお願いします。\n対象は新しい予約ページです。',reply_count:1});
  const reply=slackMessage(workspace,channel,{ts:'1791200010.000001',thread_ts:parent.ts,user:'佐藤',text:'対象は3画面で、来週までにお願いします。'});
  const other=slackMessage(workspace,channel,{ts:'1791200020.000001',user:'田中',text:'確認用の資料を共有します。',files:[{title:'画面仕様.pdf',permalink:'https://example.slack.com/files/FDEMO'}]});
  await db.cache({team:workspace.id,channel:channel.id,messages:[parent,reply,other]});
  const existing=await store.createTask({title:'予約ページの改善',slackSource:other.key});
  const host=spawn(process.execPath,['tests/dev-host.mjs','4528'],{cwd:root,detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,
    CANBAN_DATA_DIR:dir,CANBAN_CODEX_HOME:fx.codexHome,CANBAN_CLAUDE_HOME:fx.claudeHome,CANBAN_CLAUDE_DESKTOP_DIR:fx.desktopDir,
    CANBAN_LAUNCH_DRYRUN:'1',CANBAN_BACKGROUND:'0',CANBAN_SEARCH_INDEX:'0',CANBAN_GH:path.join(root,'tests/fake-gh.sh'),CANBAN_GLAB:path.join(root,'tests/fake-glab.sh'),FAKE_GH_DATA:'/dev/null'}});
  t.after(async()=>{try{process.kill(-host.pid,'SIGTERM');}catch{}await store.close();fx.cleanup();});
  await new Promise((resolve,reject)=>{host.stdout.on('data',d=>{if(d.toString().includes('dev host:'))resolve();});host.stderr.on('data',d=>{if(d.toString().includes('EADDRINUSE'))reject(new Error('browser test port in use'));});host.on('exit',c=>reject(new Error(`host exited ${c}`)));});
  const require=createRequire(process.env.CANBAN_PLAYWRIGHT_PACKAGE || import.meta.url),{chromium}=require('playwright');
  const browser=await chromium.launch({headless:true,...(process.env.CANBAN_BROWSER_EXECUTABLE?{executablePath:process.env.CANBAN_BROWSER_EXECUTABLE}:{})});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/rpc',async route=>{const request=route.request().postDataJSON();if(request.name==='canban_slack_history' && request.arguments.threadTs){await route.fulfill({json:{result:{structuredContent:{result:{messages:[parent,reply],cursor:''}}}}});}else await route.continue();});
  await page.goto('http://127.0.0.1:4528/direct?theme=light');await page.locator('.card').first().waitFor();
  const palette=async text=>{await page.keyboard.press('Meta+k');await page.locator('.palette input').fill(text);await page.locator('.palette .picker-row').first().click();};
  await page.keyboard.press('v');await page.locator('.slack-message').first().waitFor();assert.equal(await page.locator('.slack-timeline').count(),1);
  const screenshots=path.join(root,'docs/design/slack-intake');await fs.mkdir(screenshots,{recursive:true});
  for(const [layout,label] of [['trello','Trello'],['classic','定番'],['rail','レール'],['omni','オムニバー'],['hud','ライブ HUD']])for(const theme of ['light','dark']){
    await palette(`レイアウト: ${label}`);await palette(`色: ${theme==='light'?'ライト':'ダーク'}`);
    await page.screenshot({path:path.join(screenshots,`${layout}-${theme}.png`)});
    assert.equal(await page.locator('.slack-timeline').isVisible(),true);
    const rect=await page.locator('.slack-timeline').boundingBox();assert.ok(rect.width>=270&&rect.x>=0&&rect.y<800);
  }
  await palette('レイアウト: Trello');await palette('色: ライト');
  const message=page.locator(`[data-slack-key="${parent.key}"]`).first();await message.focus();await page.keyboard.press('c');
  await page.locator('dialog[open] input').first().fill('予約ページの見積もり');await page.locator('dialog[open]').getByRole('button',{name:'作成して開く',exact:true}).click();
  await page.locator('dialog[open]').waitFor({state:'hidden'});await page.locator('.slack-source').first().waitFor();assert.equal(await page.locator('.slack-add-prompt').count(),1);
  const prompt=page.locator('.pane .psec[data-sec=send] textarea').first();
  // Explicit source addition only changes the prompt; no agent is dispatched.
  await page.locator('.slack-add-prompt').click();assert.match(await prompt.inputValue(),/見積もりをお願いします/);
  assert.equal((await store.load()).cards[existing.cardId].title,'予約ページの改善');
  await page.screenshot({path:path.join(screenshots,'card-source-light.png')});
  await page.keyboard.press('Escape');await page.keyboard.press('Escape');await page.locator('#paneLayer').waitFor({state:'hidden'});
  await message.getByRole('button',{name:/返信/}).click();await page.locator('.slack-thread .slack-message').waitFor();
  const replyNode=page.locator(`[data-slack-key="${reply.key}"]`).first();await replyNode.focus();await page.keyboard.press('l');await page.locator('.popover .picker-row').filter({hasText:'予約ページの改善'}).click();
  await page.getByText('Slack資料を追加しました',{exact:true}).waitFor();assert.ok((await store.load()).cards[existing.cardId].slackRefs.includes(reply.key));
  await page.locator('.slack-timeline').focus();await page.keyboard.press('Escape');assert.equal(await page.locator('.slack-timeline').count(),0);assert.ok(await page.locator('.card').count());
  await palette('Slackタイムラインを表示');await page.locator('.slack-timeline').waitFor();
  await palette('スイムレーン: カテゴリ');
  await page.screenshot({path:path.join(screenshots,'lanes-light.png')});
  const columns=await page.locator('.slack-timeline,.slack-lanes').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().x));assert.ok(columns[1]>columns[0]);
  await palette('スイムレーン: なし');
  // Below-fold deferred content remains keyboard reachable, with per-message drafts.
  await db.cache({team:workspace.id,channel:channel.id,messages:Array.from({length:12},(_,i)=>slackMessage(workspace,channel,{ts:`17912001${String(i).padStart(2,'0')}.000001`,user:'田中',text:`追加の依頼 ${i}`}))});
  await page.keyboard.press('v');await page.keyboard.press('v');await page.locator('.slack-message.deferred').first().waitFor();
  const deferred=page.locator('.slack-message.deferred').last();await deferred.focus();await page.keyboard.press('c');
  await page.locator('dialog[open] input').first().fill('書きかけの依頼');await page.keyboard.press('Escape');await deferred.focus();await page.keyboard.press('c');
  assert.equal(await page.locator('dialog[open] input').first().inputValue(),'書きかけの依頼');await page.keyboard.press('Escape');
  await palette('Slack接続を開く');const token=page.getByLabel('Slackユーザートークン');await token.fill('入力途中の架空文字列');
  await palette('Slackタイムラインを隠す');assert.equal(await token.inputValue(),'入力途中の架空文字列');
  assert.deepEqual(errors,[]);
});

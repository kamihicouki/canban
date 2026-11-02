import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { boardHtml } from '../server/ui.mjs';
import { uploadImage, readPromptImageChunk } from '../server/prompt-input.mjs';

test('saved image thumbnails survive reopening and copy is an explicit keyboard action',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canban-image-browser-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const png=fs.readFileSync(new URL('../assets/canban.png',import.meta.url));
  const ids=Array.from({length:8},()=>{let result;for(let offset=0;offset<png.length;offset+=128*1024)result=uploadImage(dir,{...(result?{id:result.id}:{name:'canban.png',mime:'image/png',size:png.length}),offset,data:png.subarray(offset,offset+128*1024).toString('base64')});return result.id;});
  const {chromium}=createRequire(process.env.CANBAN_PLAYWRIGHT_PACKAGE||import.meta.url)('playwright');
  const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  const html=boardHtml(),css=html.match(/<style>([\s\S]*?)<\/style>/)[1],script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const helpers=script.slice(script.indexOf('function h('),script.indexOf('const colorVar ='));
  await page.route('http://localhost/image-fixture',route=>route.fulfill({contentType:'text/html',body:`<style>${css}</style><div id="form"></div><div id="feedback" role="status"></div>`}));
  await page.goto('http://localhost/image-fixture');
  await page.exposeFunction('nativePreview',args=>readPromptImageChunk(dir,args));
  await page.addScriptTag({content:`${helpers}
    const picon=()=>'', keycap=(...keys)=>h('kbd',{},keys.join(' ')), calls=[];
    const bridge={callTool:async(name,args)=>{calls.push({name,args});return {result:name==='canban_read_prompt_image'?await window.nativePreview(args):name==='canban_cancel_start_session'?{state:'cancelled'}:{state:'copied',count:args.imageIds.length,nextAction:'paste-in-desktop'}};}};
    ${fs.readFileSync(new URL('../ui/prompt-composer.js',import.meta.url),'utf8')}
    ${fs.readFileSync(new URL('../ui/task-quick-add.js',import.meta.url),'utf8')}
    window.ui=taskQuickAdd;ui.paintSessionState=()=>{};ui.feedback=document.querySelector('#feedback');ui.targets={desktopCapabilities:{clipboardImages:true}};
    window.createComposer=()=>{const input=h('textarea');const c=promptComposer(input,{key:'image-draft',context:()=>({agent:'codex'})});document.querySelector('#form').replaceChildren(c.root);return c;};
    window.calls=calls;
  `});
  for(const count of [1,3,8]) {
    await page.evaluate(async ids=>{window.composer=window.createComposer();composer.clear();await composer.restore({prompt:'保持する本文',imageIds:ids});ui.sessionDraft={startRequest:{imageIds:ids},startResult:{state:'opened',imageIds:ids,attachmentState:'pending-paste'}};ui.showSessionFeedback(ui.sessionDraft.startResult);},ids.slice(0,count));
    await page.waitForFunction(n=>document.querySelectorAll('.prompt-image img').length===n && [...document.querySelectorAll('.prompt-image img')].every(i=>i.naturalWidth>0),count);
    const before=await page.evaluate(()=>calls.filter(c=>c.name==='canban_copy_prompt_images').length);
    await page.evaluate(()=>{window.composer=window.createComposer();});
    assert.equal(await page.locator('.prompt-image img').count(),count);
    const button=page.getByRole('button',{name:'画像をコピー',exact:true});await button.focus();await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('#feedback').textContent.includes('画像をコピーしました'));
    assert.equal(await page.evaluate(()=>calls.filter(c=>c.name==='canban_copy_prompt_images').length),before+1);
    assert.match(await page.locator('#feedback').textContent(),/⌘V/);
  }
  assert.equal(await page.evaluate(()=>calls.some(c=>c.name==='canban_upload_prompt_image')),false);
  await page.evaluate(()=>{ui.sessionDraft.startRequest.clientRequestId='image-wait';ui.showSessionFeedback({state:'waiting-for-quit',reason:'Desktopの終了待ち'});});
  await page.getByRole('button',{name:'開始待機を取り消す'}).click();
  await page.waitForFunction(()=>ui.sessionDraft.startResult.state==='cancelled');
  assert.equal(await page.locator('.prompt-image img').count(),8);
  assert.equal(await page.evaluate(()=>ui.sessionDraft.startRequest.imageIds.length),8);
});

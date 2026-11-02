import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { uploadImage } from '../server/prompt-input.mjs';
import { copyPromptImages } from '../server/prompt-clipboard.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/9l0AAAAASUVORK5CYII=','base64');
async function fixture(t) {const dir=await fs.mkdtemp(path.join(os.tmpdir(),'canban-clipboard-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
const upload=dir=>uploadImage(dir,{name:'画像.png',mime:'image/png',size:png.length,data:png.toString('base64')}).id;

test('copy requires explicit UI authority and unsupported OS leaves the clipboard unchanged',async t=>{
  const dataDir=await fixture(t),imageIds=[upload(dataDir)];let calls=0;
  const run=async()=>{calls++;return JSON.stringify({copied:true,count:1});};
  await assert.rejects(copyPromptImages({dataDir,imageIds},{platform:'darwin',run}),/UI/);
  assert.equal((await copyPromptImages({dataDir,imageIds},{platform:'linux',run,uiAuthorized:true})).state,'unsupported');assert.equal(calls,0);
});

test('tampering, paths, oversized metadata and nine images never reach the pasteboard',async t=>{
  const dataDir=await fixture(t),id=upload(dataDir);let calls=0;
  const options={platform:'darwin',uiAuthorized:true,run:async()=>{calls++;return '{}';}};
  for(const imageIds of [['/etc/passwd'],Array(9).fill(id)]) await assert.rejects(copyPromptImages({dataDir,imageIds},options));
  const metaFile=path.join(dataDir,'prompt-images',id+'.json'),meta=JSON.parse(await fs.readFile(metaFile,'utf8'));
  await fs.writeFile(metaFile,JSON.stringify({...meta,size:10*1024*1024+1}));
  await assert.rejects(copyPromptImages({dataDir,imageIds:[id]},options));
  await fs.writeFile(metaFile,JSON.stringify(meta));await fs.writeFile(path.join(dataDir,'prompt-images',id+'.png'),'tampered');
  await assert.rejects(copyPromptImages({dataDir,imageIds:[id]},options));assert.equal(calls,0);
});

test('eight validated file URLs preserve input order and never claim automatic attachment',async t=>{
  const dataDir=await fixture(t),imageIds=Array.from({length:8},()=>upload(dataDir));let captured;
  const result=await copyPromptImages({dataDir,imageIds},{platform:'darwin',uiAuthorized:true,run:async(file,args)=>{captured={file,args};return JSON.stringify({copied:true,count:8});}});
  assert.equal(result.state,'copied');assert.equal(result.nextAction,'paste-in-desktop');
  assert.deepEqual(captured.args.slice(3),imageIds.map(id=>path.join(dataDir,'prompt-images',id+'.png')));
  assert.equal(captured.file,'osascript');assert.equal(captured.args[1],'JavaScript');assert.equal(result.attached,undefined);
});

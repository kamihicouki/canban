import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { prepareCodexDesktop } from '../server/codex-desktop-start.mjs';
const host={id:'remote-ssh-discovered:fixture',alias:'fixture',local:false};
const request={host,cwd:'/work',clientRequestId:'native-1'};
const threadId='a40b900b-67bb-4ee4-8b3b-2ea07df72e5f';

test('invalid input fails before remote operations and results bind host cwd and closed writer',async()=>{
  let calls=0;
  const pool={prepareDesktop:async()=>{calls++;return {state:'prepared',threadId,hostId:host.id,cwd:'/work',writerClosed:true};}};
  for(const invalid of [{cwd:'relative'},{clientRequestId:'../bad'}]) await assert.rejects(prepareCodexDesktop({...request,...invalid},{pool}));
  assert.equal(calls,0);
  assert.equal((await prepareCodexDesktop(request,{pool})).state,'prepared');
  for(const patch of [{hostId:'other'},{cwd:'/other'},{writerClosed:false}]) {
    const result=await prepareCodexDesktop(request,{pool:{prepareDesktop:async()=>({state:'prepared',threadId,hostId:host.id,cwd:'/work',writerClosed:true,...patch})}});
    assert.equal(result.state,'uncertain');
  }
});

test('disconnect is uncertain and never invokes a CLI turn or fallback',async()=>{
  const result=await prepareCodexDesktop(request,{pool:{prepareDesktop:async()=>{throw Error('disconnected');}}});
  assert.equal(result.state,'uncertain');assert.equal(result.hostId,host.id);
});

// Exercise the actual remote reservation and JSON-RPC protocol with a tiny fake CLI.
test('retry prepares one thread and releases the writer before a separate read',async t=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'canban-remote-prepare-'));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const bin=path.join(home,'bin');await fs.mkdir(bin);await fs.mkdir(path.join(home,'work'));
  await fs.writeFile(path.join(bin,'codex'),`#!${process.execPath}\nconst fs=require('fs'),path=require('path'),rl=require('readline');
    const h=process.env.HOME;fs.appendFileSync(path.join(h,'events'),'connect\\n');
    rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;
      fs.appendFileSync(path.join(h,'events'),m.method+'\\n');
      let result={};if(m.method==='thread/start'){if(m.params.model!=='gpt-6.1-sol')throw Error('model');result={thread:{id:${JSON.stringify(threadId)},cwd:m.params.cwd}};fs.writeFileSync(path.join(h,'thread'),JSON.stringify(result.thread));}
      if(m.method==='thread/read')result={thread:JSON.parse(fs.readFileSync(path.join(h,'thread')))};
      if(process.env.CANBAN_FAKE_BREAK==='1'&&m.method==='thread/start')process.exit(1);
      process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});
    process.on('exit',()=>fs.appendFileSync(path.join(h,'events'),'closed\\n'));`,{mode:0o700});
  const script=await fs.readFile(new URL('../server/remote/dispatch.py',import.meta.url),'utf8');
  const call=(clientRequestId='native-1', breakAfterStart=false)=>new Promise((resolve,reject)=>{
    const child=spawn('python3',['-'],{env:{...process.env,HOME:home,CANBAN_FAKE_BREAK:breakAfterStart?'1':'0',PATH:bin+':'+process.env.PATH},stdio:['pipe','pipe','pipe']});let out='';
    child.stdout.on('data',x=>{out+=x;});child.on('error',reject);child.on('exit',()=>{try{resolve(JSON.parse(out));}catch{reject(Error(out));}});
    child.stdin.end('ARGS = '+JSON.stringify({mode:'desktop_prepare_codex',clientRequestId,cwd:path.join(home,'work')})+'\n'+script);
  });
  const a=await call(),b=await call();
  assert.equal(a.state,'prepared');assert.equal(b.threadId,a.threadId);assert.equal(a.writerClosed,true);
  const events=(await fs.readFile(path.join(home,'events'),'utf8')).trim().split('\n');
  assert.equal(events.filter(x=>x==='thread/start').length,1);assert.equal(events.filter(x=>x==='turn/start').length,0);
  assert.ok(events.indexOf('closed')<events.indexOf('thread/read'));
  const lost=await call('lost-response',true), again=await call('lost-response',true);
  assert.equal(lost.state,'uncertain');assert.equal(again.state,'uncertain');
  assert.equal((await fs.readFile(path.join(home,'events'),'utf8')).split('thread/start').length-1,2);
});

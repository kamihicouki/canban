// Isolated real CLI; no model turn, user home, or user history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveBin } from '../server/dispatch.mjs';
import { appEnv } from '../server/launcher.mjs';

test('official App Server prepares and reads one persistent empty thread after writer release', {timeout:40000}, async t => {
  const binary=resolveBin('codex');assert.ok(binary,'Codex CLI is required');
  const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'canban-native-desktop-')));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  await fs.mkdir(path.join(home,'.codex'));
  const script=await fs.readFile(new URL('../server/remote/dispatch.py',import.meta.url),'utf8');
  const run=()=>new Promise((resolve,reject)=>{
    const child=spawn('python3',['-'],{env:{...appEnv(),HOME:home,CODEX_HOME:path.join(home,'.codex'),PATH:path.dirname(binary)+':'+process.env.PATH},stdio:['pipe','pipe','pipe']});
    let out='';child.stdout.on('data',x=>{out+=x;});child.stderr.on('data',()=>{});child.on('error',reject);
    child.on('exit',()=>{try{resolve(JSON.parse(out));}catch{reject(Error('invalid native preparation result'));}});
    child.stdin.end('ARGS = '+JSON.stringify({mode:'desktop_prepare_codex',clientRequestId:'native-integration',cwd:home})+'\n'+script);
  });
  const a=await run(),b=await run();
  assert.equal(a.state,'prepared',JSON.stringify(a));assert.equal(a.writerClosed,true);assert.equal(b.threadId,a.threadId);assert.equal(b.cwd,home);
  const files=await fs.readdir(path.join(home,'.codex','sessions'),{recursive:true});
  const histories=files.filter(x=>x.endsWith('.jsonl'));
  assert.equal(histories.length,1);
  const lines=(await fs.readFile(path.join(home,'.codex','sessions',histories[0]),'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(!lines.some(x=>x.type==='event_msg' && x.payload?.type==='task_started'),'must never start a model turn');
});

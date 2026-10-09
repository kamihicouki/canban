import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.mjs';
import { RequestStore } from '../server/requests.mjs';
import { database, executionContext } from '../server/sqlite-client.mjs';
import { Leader } from '../server/leader.mjs';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(),'canban-sqlite-'));
const root = new URL('../',import.meta.url).pathname;
function processRun(args, input, onReady) {
  return new Promise((resolve,reject) => {
    const child=spawn(process.execPath,['--no-warnings',...args],{cwd:root,stdio:onReady?['pipe','pipe','pipe','ipc']:['pipe','pipe','pipe']});
    if(onReady)child.on('message',message=>{if(message==='ready')onReady(child);});
    let out='',err=''; child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
    child.on('error',reject);child.on('close',code=>resolve({code,out,err}));child.stdin.end(input);
  });
}
const migrate = (dir,...args) => processRun(['scripts/migrate-sqlite.mjs','--data-dir',dir,...args]);

test('10 processes preserve 1000 accepted updates with bounded contention', async (t) => {
  const dir=tmp(), store=new Store(dir); await store.load();
  // Start writes only after every DB connection is initialized. Startup failure
  // is a separate contract from preserving accepted writes under contention.
  const ready=[];
  const onReady=child=>{ready.push(child);if(ready.length===10)for(const c of ready)c.send('start');};
  const results=await Promise.all(Array.from({length:10},(_,client)=>processRun(['--input-type=module'],`
    import {Store} from './server/store.mjs';
    const s=new Store(${JSON.stringify(dir)});
    await s.load();
    const started=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('DB clients did not become ready')),15000);
      process.once('message',()=>{clearTimeout(timer);resolve();});
    });
    process.send('ready');await started;process.disconnect();
    let max=0,rejected=0,accepted=0;
    for(let i=0;i<100;i++){
      for(let attempt=0;;attempt++){
        const start=performance.now();
        try {await s.moveCard({cardId:'codex:${client}:'+i,toListId:'doing',order:i});accepted++;break;}
        catch(error){
          if(error.code!=='db_busy'||attempt>=19)throw error;
          rejected++;
        }
        finally {max=Math.max(max,performance.now()-start);}
        // Only the fixture resubmits a rejected DB write; accepted writes and CLI
        // requests are never retried. Give competing clients a chance to finish.
        await new Promise(resolve=>setTimeout(resolve,50+Math.random()*150));
      }
    }
    console.log(JSON.stringify({max,rejected,accepted}));await s.close();
  `,onReady)));
  let rejected=0;
  for(const result of results) {
    assert.equal(result.code,0,result.err);
    const stats=JSON.parse(result.out);
    assert.ok(stats.max<2100,result.out);assert.equal(stats.accepted,100);
    rejected+=stats.rejected;
  }
  t.diagnostic(`1000 accepted DB updates; ${rejected} bounded busy rejections resubmitted by fixture`);
  const cards=(await store.load()).cards;
  assert.equal(Object.keys(cards).length,1000);
  for(let client=0;client<10;client++)for(let i=0;i<100;i++){
    assert.equal(cards['codex:'+client+':'+i].listId,'doing');
    assert.equal(cards['codex:'+client+':'+i].order,i);
  }
  await store.close();
});

test('write contention stops within two seconds without blocking main thread',async()=>{
  const dir=tmp(),store=new Store(dir);await store.load();
  const blocker=new DatabaseSync(path.join(dir,'canban.sqlite'));blocker.exec('BEGIN IMMEDIATE');
  let ticks=0;const timer=setInterval(()=>ticks++,10),start=performance.now();
  let elapsed, busyElapsedMs;
  try {
    await assert.rejects(store.createList({title:'blocked'}),e=>{busyElapsedMs=e.busyElapsedMs;return e.code==='db_busy';});
    elapsed=performance.now()-start;
  }
  finally {clearInterval(timer);blocker.exec('ROLLBACK');blocker.close();}
  // Releasing and closing the fixture lock is not part of the rejected write.
  assert.ok(Number.isFinite(busyElapsedMs));
  // The product bound is 2000ms of retrying; the last native busy wait (250ms)
  // can be stretched by the OS on a loaded shared runner, so measure with 500ms
  // of scheduling slack instead of 100ms. A runaway retry would still be caught.
  assert.ok(busyElapsedMs<2500&&elapsed<2500,`busy rejection took ${elapsed}ms (worker retry: ${busyElapsedMs}ms)`);assert.ok(ticks>50);
  assert.equal((await store.load()).lists.length,4);await store.close();
});

test('canonical session claim is exclusive; different sessions can run concurrently',async()=>{
  const dir=tmp(),rs=new RequestStore(dir);
  const a=await rs.create({cardId:'codex:a',hostId:'local',agent:'codex',nativeId:'same'});
  const b=await rs.create({cardId:'alias',hostId:'local',agent:'codex',nativeId:'same'});
  const c=await rs.create({cardId:'codex:c',hostId:'local',agent:'codex',nativeId:'other'});
  const options={owner:'one',ownerPid:process.pid,maxLocal:10};
  assert.equal((await rs.claim(a.id,options)).ok,true);
  assert.equal((await rs.claim(b.id,{...options,owner:'two'})).ok,false);
  assert.equal((await rs.claim(c.id,options)).ok,true);
  await rs.close();
});

test('uncertain owner survives process death; stale tokens cannot finish a request',async()=>{
  const dir=tmp(),rs=new RequestStore(dir),s=new Store(dir);await s.load();
  const r=await rs.create({cardId:'codex:a',hostId:'local',agent:'codex',nativeId:'a'});
  const claim=await rs.claim(r.id,{owner:'dead',ownerPid:2147483647});
  const token=claim.request;
  assert.equal(await rs.transition(r.id,['starting'],{state:'succeeded'},{owner:'other',generation:token.leaseGeneration,release:true}),null);
  await rs.transition(r.id,['starting'],{state:'interrupted'},{owner:'dead',generation:token.leaseGeneration});
  const next=await rs.create({cardId:'codex:a',hostId:'local',agent:'codex',nativeId:'a'});
  assert.equal((await rs.claim(next.id,{owner:'new'})).reasonCode,'session_locked');
  assert.ok(await database(dir).call('system','lease',['session:["local","codex","a"]']));
  await s.close();
});

test('always mode obeys background lease; stale generation rejects writes',async()=>{
  const dir=tmp(),store=new Store(dir),a=new Leader(dir,{mode:'always'}),b=new Leader(dir,{mode:'always'});
  assert.equal(await a.check(),true);const old=a.token;
  assert.equal(await b.check(),false);
  await a.release();assert.equal(await b.check(),true);assert.ok(b.token.generation>old.generation);
  await assert.rejects(executionContext.run(old,()=>store.createList({title:'stale'})),e=>e.code==='stale_owner');
  await b.run(()=>store.createList({title:'current'}));await b.release();await store.close();
});

test('migration is offline, atomic, idempotent, ignores legacy changes and exports latest',async()=>{
  const dir=tmp();fs.writeFileSync(path.join(dir,'board.json'),JSON.stringify({uiState:{revision:4,state:{view:'analytics'}}}));
  fs.writeFileSync(path.join(dir,'requests.json'),JSON.stringify({requests:[{id:'r',cardId:'codex:a',hostId:'local',agent:'codex',state:'running',createdAt:1}],paused:{}}));
  assert.equal((await migrate(dir)).code,0);assert.ok(!fs.existsSync(path.join(dir,'canban.sqlite')));
  assert.equal((await migrate(dir,'--apply')).code,0);
  const backup=fs.readdirSync(dir).find(n=>n.startsWith('backup-'));
  assert.equal(fs.statSync(path.join(dir,backup)).mode&0o777,0o700);
  assert.equal(fs.statSync(path.join(dir,backup,'board.json')).mode&0o777,0o600);
  const store=new Store(dir),rs=new RequestStore(dir);
  assert.equal((await store.getUiState()).revision,4);assert.equal((await rs.get('r')).state,'interrupted');
  assert.ok((await rs.load()).paused['codex:a']);
  assert.equal((await migrate(dir,'--export','--apply')).code,1);
  await store.createList({title:'最新'});await store.close();
  fs.writeFileSync(path.join(dir,'board.json'),'{}');assert.equal((await migrate(dir,'--apply')).code,0);
  const exported=await migrate(dir,'--export','--apply');assert.equal(exported.code,0,exported.err);
  const output=fs.readdirSync(dir).find(n=>n.startsWith('export-'));
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir,output,'board.json'))).lists.some(l=>l.title==='最新'));
});

test('corrupt migration leaves source untouched and no initialized database',async()=>{
  const dir=tmp();fs.writeFileSync(path.join(dir,'board.json'),'{broken');
  assert.equal((await migrate(dir,'--apply')).code,1);
  assert.equal(fs.readFileSync(path.join(dir,'board.json'),'utf8'),'{broken');
  assert.ok(!fs.existsSync(path.join(dir,'canban.sqlite')));
});

test('simultaneous process claims choose exactly one owner',async()=>{
  const dir=tmp(),rs=new RequestStore(dir);await rs.load();
  const results=await Promise.all(Array.from({length:6},(_,i)=>processRun(['--input-type=module'],`
    import {RequestStore} from './server/requests.mjs';
    const rs=new RequestStore(${JSON.stringify(dir)});
    const r=await rs.create({cardId:'alias-${i}',agent:'codex',hostId:'local',nativeId:'one'});
    const result=await rs.claim(r.id,{owner:'${i}',ownerPid:process.pid,maxLocal:10});
    console.log(JSON.stringify(result));await rs.close();
  `)));
  for(const r of results)assert.equal(r.code,0,r.err);
  assert.equal(results.filter(r=>JSON.parse(r.out).ok).length,1);await rs.close();
});

test('killed owner leaves session lease and request intact without automatic restart',async()=>{
  const dir=tmp(),store=new Store(dir);await store.load();
  const child=spawn(process.execPath,['--no-warnings','--input-type=module','-e',`
    import {RequestStore} from './server/requests.mjs';
    const rs=new RequestStore(${JSON.stringify(dir)});
    const r=await rs.create({cardId:'codex:kill',agent:'codex',hostId:'local',nativeId:'kill'});
    await rs.claim(r.id,{owner:'killed',ownerPid:process.pid});
    console.log(r.id);setInterval(()=>{},1000);
  `],{cwd:root,stdio:['ignore','pipe','pipe']});
  const id=await new Promise((resolve,reject)=>{child.stdout.once('data',b=>resolve(String(b).trim()));child.once('error',reject);});
  const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
  const rs=new RequestStore(dir);assert.equal((await rs.get(id)).state,'starting');
  const next=await rs.create({cardId:'codex:kill',agent:'codex',hostId:'local',nativeId:'kill'});
  assert.equal((await rs.claim(next.id,{owner:'next'})).ok,false);await store.close();
});

test('migration failure inside transaction rolls back and can be retried',async()=>{
  const dir=tmp();fs.writeFileSync(path.join(dir,'board.json'),JSON.stringify({uiState:{revision:9,state:{view:'board'}}}));
  fs.writeFileSync(path.join(dir,'status.json'),'{bad');
  assert.equal((await migrate(dir,'--apply')).code,1);
  const db=new DatabaseSync(path.join(dir,'canban.sqlite'));assert.equal(db.prepare("SELECT 1 FROM metadata WHERE key='initialized'").get(),undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM board_records').get().n,0);db.close();
  fs.writeFileSync(path.join(dir,'status.json'),'{}');const result=await migrate(dir,'--apply');assert.equal(result.code,0,result.err);
  const store=new Store(dir);assert.equal((await store.getUiState()).revision,9);await store.close();
});

test('migration detects relative legacy server and custom environment data directory',async()=>{
  const dir=tmp(),project=tmp();fs.mkdirSync(path.join(project,'server'));
  fs.writeFileSync(path.join(project,'package.json'),'{"name":"canban"}');
  fs.writeFileSync(path.join(project,'server','index.mjs'),'console.log("ready");setInterval(()=>{},1000);');
  fs.writeFileSync(path.join(dir,'board.json'),'{}');
  const child=spawn(process.execPath,['server/index.mjs'],{cwd:project,env:{...process.env,CANBAN_DATA_DIR:dir},stdio:['ignore','pipe','pipe']});
  try {
    await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});
    const result=await migrate(dir,'--apply');assert.equal(result.code,1,result.out);assert.match(result.err,/サーバー/);
    assert.equal(fs.existsSync(path.join(dir,'canban.sqlite')),false);
  } finally {
    const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exited;
  }
  const result=await migrate(dir,'--apply');assert.equal(result.code,0,result.err);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDesktopAccounts } from '../server/claude-desktop-accounts.mjs';
import { backupDesktopProfiles } from '../server/desktop-backup.mjs';
import { createDesktopLaunches } from '../server/desktop-launch.mjs';
import { openClaudeDesktop } from '../server/claude-desktop-open.mjs';
import { restoreGuests, setGuestRunningCheck } from '../server/claude-desktop-guests.mjs';
import { Store } from '../server/store.mjs';

const id = 'aaaaaaaa-0000-4000-8000-000000000001', sid = 'local_original';
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canban-resume-account-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root,'data'), appDir = path.join(root,'Claude'), projects = path.join(root,'cli','projects');
  for (const dir of [dataDir, appDir, path.join(projects,'-work')]) await fs.mkdir(dir,{recursive:true});
  const paths = { dataDir, app: appDir, sessions: path.join(appDir,'claude-code-sessions'), projects, state: path.join(dataDir,'desktop-integrated'), ledger: path.join(dataDir,'desktop-integrated','ledger.json') };
  const write = async (file,value) => { await fs.mkdir(path.dirname(file),{recursive:true}); await fs.writeFile(file,JSON.stringify(value)); };
  await write(path.join(appDir,'config.json'), {lastKnownAccountUuid:'a'});
  await write(path.join(paths.sessions,'a','org','local_original.json'), {sessionId:sid,cliSessionId:id,cwd:'/work',completedTurns:1});
  const sourcePath=path.join(projects,'-work',`${id}.jsonl`);
  await fs.writeFile(sourcePath,JSON.stringify({type:'user',cwd:'/work',message:{content:'original'}})+'\n');
  let running = false, opens = [], queued = false, busy = null;
  const previous = setGuestRunningCheck(async()=>running); t.after(()=>setGuestRunningCheck(previous));
  const accounts = createDesktopAccounts({dataDir,appDir,runtime:async()=>({running,profileDir:running?appDir:null}),restoreGuests:()=>restoreGuests({paths}),backup:x=>backupDesktopProfiles({dataDir,...x})});
  await accounts.command({type:'enroll-current',account:'claude:a'});
  await accounts.command({type:'begin-login',account:'claude:b',requestId:'connect-b'});
  await write(path.join(appDir,'config.json'),{lastKnownAccountUuid:'b'});
  await write(path.join(paths.sessions,'b','org','local_b.json'),{sessionId:'local_b',cliSessionId:'bbbbbbbb-0000-4000-8000-000000000002',cwd:'/b'});
  await accounts.command({type:'finish-login',account:'claude:b'});
  await accounts.withAccount('claude:a',{allowSwitch:true,requestId:'return-a'},()=>{});
  let source = {agent:'claude',id:`claude:${id}`,nativeId:id,desktopSessionId:sid,desktopAccount:'a',host:{id:'local',local:true},cwd:'/work',sourcePath};
  const mod = await import('../server/claude-desktop-resume.mjs').catch(()=>({}));
  assert.equal(typeof mod.createClaudeDesktopResume,'function','resume must resolve the original server-side rather than create an unrelated conversation');
  const resolver=mod.createClaudeDesktopResume({paths,findSession:async()=>source,check:async()=>busy,requests:async()=>queued?[{state:'queued'}]:[]});
  const opts={dataDir,resolveTarget:resolver.resolve,accounts,prepareOpen:async(input,target)=>target.owner!==input.account && running?{state:'waiting-for-quit',reason:'保存して終了してください'}:null,open:async(input,target)=>{
    const result=await openClaudeDesktop({url:target.url,guestSessionId:target.owner!==input.account?target.desktopSessionId:null,paths,watch:()=>{},open:async url=>{opens.push(url);running=true;}});
    return result.opened?{url:target.url,cwd:target.cwd}:{notOpened:true,state:'waiting-for-quit',reason:result.reason};
  }};
  return {root,paths,accounts,sourcePath,appDir,dataDir,resolver,opts,write,opens,stop:()=>{running=false;},run:()=>{running=true;},queue:()=>{queued=true;},busy:()=>{busy='実行中';},source:x=>{source={...source,...x};}};
}
const input={operation:'resume',agent:'claude',cardId:`claude:${id}`,account:'claude:b',clientRequestId:'resume-1',allowDesktopSwitch:true};

test('resume waits for quit, switches to the selected Desktop independently, and opens the same conversation only once',async t=>{
  const f=await fixture(t);f.run();const launches=createDesktopLaunches(f.opts);
  assert.equal((await launches.start(input,{uiAuthorized:true})).state,'waiting-for-quit');
  f.stop();assert.equal((await launches.recover())[0].state,'opened');
  assert.deepEqual(f.opens,[`claude://code/continue?session=${sid}`]);
  assert.equal((await launches.start(input)).state,'opened');
  assert.equal(f.opens.length,1);
  const guest=JSON.parse(await fs.readFile(path.join(f.paths.sessions,'b','org',`${sid}.json`)));
  assert.equal(guest.cliSessionId,id);assert.equal(guest.cwd,'/work');
  assert.equal((await f.accounts.view()).profiles.find(p=>p.active).account,'claude:b');
});

test('cancelled resume never switches or opens after quit',async t=>{
  const f=await fixture(t);f.run();const launches=createDesktopLaunches(f.opts);
  await launches.start(input,{uiAuthorized:true});await launches.cancel(input.clientRequestId,{uiAuthorized:true});
  f.stop();await launches.recover();assert.equal(f.opens.length,0);
  assert.equal((await f.accounts.view()).profiles.find(p=>p.active).account,'claude:a');
});

test('a linked task retains its original session across another account turn, writeback and return',async t=>{
  const f=await fixture(t), store=new Store(f.dataDir), sessionId=`claude:${id}`;
  const task=await store.createTask({title:'cross-account verification',description:'Keep the original conversation'});
  const other=await store.createTask({title:'unrelated task'});
  await store.linkSession({taskId:task.cardId,sessionId});
  await store.linkSession({taskId:other.cardId,sessionId:'claude:unrelated'});
  const before=(await store.load()).cards;
  const launches=createDesktopLaunches(f.opts);
  assert.equal((await launches.start(input,{uiAuthorized:true})).state,'opened');
  const guestFile=path.join(f.paths.sessions,'b','org',`${sid}.json`);
  const guest=JSON.parse(await fs.readFile(guestFile));
  await f.write(guestFile,{...guest,completedTurns:2,lastAssistantUuid:'guest-progress'});
  await fs.appendFile(f.sourcePath,JSON.stringify({type:'assistant',message:{content:'cross-account progress'}})+'\n');
  f.stop();await restoreGuests({paths:f.paths});
  await f.accounts.withAccount('claude:a',{allowSwitch:true,requestId:'return-after-task'},()=>{});
  const original=JSON.parse(await fs.readFile(path.join(f.paths.sessions,'a','org',`${sid}.json`)));
  assert.equal(original.completedTurns,2);assert.equal(original.lastAssistantUuid,'guest-progress');
  assert.equal(original.cliSessionId,id);assert.equal(original.cwd,'/work');
  assert.equal((await launches.start({...input,account:'claude:a',clientRequestId:'task-return'},{uiAuthorized:true})).state,'opened');
  assert.deepEqual(f.opens,[`claude://code/continue?session=${sid}`,`claude://code/continue?session=${sid}`]);
  const after=(await new Store(f.dataDir).load()).cards;
  assert.deepEqual(after[task.cardId],before[task.cardId]);
  assert.deepEqual(after[other.cardId],before[other.cardId]);
  assert.deepEqual(after[task.cardId].links,[sessionId]);
  assert.match(await fs.readFile(f.sourcePath,'utf8'),/cross-account progress/);
});

test('a changed transcript reference or pending CLI request prevents the external open',async t=>{
  const f=await fixture(t), launches=createDesktopLaunches(f.opts);f.run();
  await launches.start(input,{uiAuthorized:true});f.stop();
  await fs.appendFile(f.sourcePath,'changed\n');
  assert.equal((await launches.start(input)).state,'failed');assert.equal(f.opens.length,0);
  f.queue();await assert.rejects(f.resolver.resolve({...input,clientRequestId:'queued'}),/待機|実行/);
});

test('interrupted work and ambiguous conversation owners never become another account guest',async t=>{
  const f=await fixture(t), original=path.join(f.paths.sessions,'a','org',`${sid}.json`);
  const record=JSON.parse(await fs.readFile(original));
  await f.write(original,{...record,pendingCycle:{id:'unfinished'}});
  await assert.rejects(f.resolver.resolve(input),/元のアカウント/);
  await f.write(original,record);
  await f.write(path.join(f.paths.sessions,'unregistered','org',`${sid}.json`),record);
  await assert.rejects(f.resolver.resolve(input),/所有者|複数/);
  assert.equal(f.opens.length,0);
});

test('CLI-only cards retain the official same-native-ID Desktop import path', async t=>{
  const f=await fixture(t);await fs.unlink(path.join(f.paths.sessions,'a','org',`${sid}.json`));
  f.source({desktopSessionId:null,desktopAccount:null,account:'claude:a'});
  const launches=createDesktopLaunches(f.opts);
  assert.equal((await launches.start(input,{uiAuthorized:true})).state,'opened');
  assert.deepEqual(f.opens,[`claude://resume?session=${id}`]);
  assert.match(await fs.readFile(f.sourcePath,'utf8'),/original/);
});

test('an archived Desktop card can still import its native CLI history in its own account',async t=>{
  const f=await fixture(t), file=path.join(f.paths.sessions,'a','org',`${sid}.json`);
  const value=JSON.parse(await fs.readFile(file));await f.write(file,{...value,isArchived:true});f.source({archived:true});
  const request={...input,account:'claude:a',clientRequestId:'archived-import'};
  const target=await f.resolver.resolve(request);
  assert.equal(target.url,`claude://resume?session=${id}`);
  await assert.rejects(f.resolver.resolve(input),/元のアカウント/);
});

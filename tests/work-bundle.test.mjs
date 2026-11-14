import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import {execFileSync} from 'node:child_process';
import {makeFixtures} from './helpers.mjs';
const source = () => fs.readFileSync(new URL('../ui/work-bundle-model.js', import.meta.url), 'utf8');
const model = () => vm.runInNewContext(`${source()}\n({workSuggestions,workBundleDisabledReason,createWorkBundleController})`);
const session = { id: 'codex:one', kind: 'session', cwd: '/repo/app', branch: 'main', statusKnown: true };

test('work candidates use exact machine, folder and nonempty branch, not similar titles', () => {
  const {workSuggestions} = model();
  const tasks = [
    {id:'task:other',title:'same',updatedAt:9,links:[{cwd:'/else',branch:'main'}]},
    {id:'task:weak',updatedAt:8,links:[{cwd:'/repo/app',branch:'other'}]},
    {id:'task:strong',updatedAt:1,links:[{cwd:'/repo/app',branch:'main'}]},
    {id:'task:remote',updatedAt:10,links:[{cwd:'/repo/app',branch:'main',host:{id:'remote'}}]},
  ];
  const found = workSuggestions(session,tasks);
  assert.deepEqual(Array.from(found,x=>[x.taskId,x.strength]),[['task:strong','strong'],['task:weak','weak']]);
  assert.match(found[0].reason,/app.*main/);
  for(const value of [{cwd:''},{statusKnown:false},{dot:{}},{sourceKind:'codex-cloud'}])assert.equal(workSuggestions({...session,...value},tasks).length,0);
  assert.equal(workSuggestions({...session,branch:''},tasks)[0].strength,'weak');
  assert.equal(workSuggestions(session,Array.from({length:8},(_,i)=>({id:`task:${i}`,updatedAt:i,links:[{cwd:session.cwd}]}))).length,5);
});

test('unsupported session kinds have an explicit reason', () => {
 const {workBundleDisabledReason}=model();
 assert.match(workBundleDisabledReason({kind:'task'}),/セッション/);
 assert.match(workBundleDisabledReason({...session,subagent:true}),/サブ/);
 assert.match(workBundleDisabledReason({...session,dot:{}}),/クラウド/);
 assert.equal(workBundleDisabledReason(session),null);
});

async function harness() {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canban-bundle-'));const store=new Store(dir);let mutations=0;
 const read=async()=>{const s=await store.load();return {session,tasks:Object.entries(s.cards).filter(([,c])=>c.kind==='task').map(([id,c])=>({...c,id,links:c.links.map(id=>({id}))})),listId:'doing'};};
 const call=async(name,args)=>{mutations++;return ({canban_create_task:()=>store.createTask({...args,listId:args.list}),canban_link_session:()=>store.linkSession(args),canban_unlink_session:()=>store.unlinkSession(args),canban_delete_task:()=>store.deleteTask(args)})[name]();};
 const ctl=model().createWorkBundleController({read,call,refresh:async()=>{}});
 return {store,ctl,read,get mutations(){return mutations;},close:async()=>{await store.close();fs.rmSync(dir,{recursive:true,force:true});}};
}

test('new bundle is single flight, persists membership, and undo removes only its unchanged task',async()=>{
 const h=await harness();try{
  const [a,b]=await Promise.all([h.ctl.bundle(session.id,{create:true,clientRequestId:'same-request'}),h.ctl.bundle(session.id,{create:true,clientRequestId:'same-request'})]);
  assert.equal(b,null);assert.equal((await h.read()).tasks.length,1);
  assert.equal((await h.read()).tasks[0].links[0].id,session.id);
  await h.ctl.undo(a);assert.equal((await h.read()).tasks.length,0);
  assert.equal(await h.ctl.undo(a),false);
 }finally{await h.close();}
});

test('moving and unlinking undo restores the previous task without overwriting a later manual move',async()=>{
 const h=await harness();try{
  const a=await h.store.createTask({title:'a'}),b=await h.store.createTask({title:'b'}),c=await h.store.createTask({title:'c'});
  await h.store.linkSession({taskId:a.cardId,sessionId:session.id});
  const moved=await h.ctl.bundle(session.id,{taskId:b.cardId});await h.ctl.undo(moved);
  assert.deepEqual((await h.store.load()).cards[a.cardId].links,[session.id]);
  const unlinked=await h.ctl.bundle(session.id,{taskId:a.cardId,unlink:true});await h.ctl.undo(unlinked);
  assert.deepEqual((await h.store.load()).cards[a.cardId].links,[session.id]);
  const later=await h.ctl.bundle(session.id,{taskId:b.cardId});await h.store.linkSession({taskId:c.cardId,sessionId:session.id});
  await assert.rejects(h.ctl.undo(later),/変更/);assert.deepEqual((await h.store.load()).cards[c.cardId].links,[session.id]);
 }finally{await h.close();}
});

test('undo preserves a newly created task edited by someone else',async()=>{
 const h=await harness();try{
  const r=await h.ctl.bundle(session.id,{create:true,clientRequestId:'edit-request'});
  await h.store.updateTask({cardId:r.toTaskId,title:'edited'});
  await h.ctl.undo(r);const s=await h.store.load();assert.equal(s.cards[r.toTaskId].title,'edited');assert.deepEqual(s.cards[r.toTaskId].links,[]);
 }finally{await h.close();}
});

test('failed linking leaves the created task and identifies it in the error',async()=>{
 const tasks=[];const ctl=model().createWorkBundleController({read:async()=>({session,tasks,listId:'inbox'}),refresh:async()=>{},call:async(name,args)=>{if(name==='canban_create_task'){tasks.push({id:'task:created',title:args.title,links:[]});return {cardId:'task:created',title:args.title,links:[]};}throw Error('link failed');}});
 await assert.rejects(ctl.bundle(session.id,{create:true,clientRequestId:'failed-request'}),/task:created/);assert.equal(tasks.length,1);
});

test('atomic expected-owner and expected-task guards reject concurrent changes while old callers remain compatible',async()=>{
 const h=await harness();try{
  const a=await h.store.createTask({title:'a'}),b=await h.store.createTask({title:'b'});
  await h.store.linkSession({taskId:a.cardId,sessionId:session.id});
  await assert.rejects(h.store.linkSession({taskId:b.cardId,sessionId:session.id,expectedTaskId:null}),/変更/);
  await assert.rejects(h.store.unlinkSession({taskId:a.cardId,sessionId:session.id,expectedTaskId:b.cardId}),/変更/);
  const {cardId,...expectedTask}=b;await h.store.updateTask({cardId:b.cardId,title:'changed'});
  await assert.rejects(h.store.deleteTask({cardId:b.cardId,expectedTask}),/変更/);
  assert.equal((await h.store.load()).cards[b.cardId].title,'changed');
 }finally{await h.close();}
});

test('an explicit collect choice never becomes unlink because membership changed while the picker was open',async()=>{
 const h=await harness();try{
  const task=await h.store.createTask({title:'chosen'});
  await h.store.linkSession({taskId:task.cardId,sessionId:session.id});
  const result=await h.ctl.bundle(session.id,{taskId:task.cardId,unlink:false});
  assert.equal(result,null);
  assert.deepEqual((await h.store.load()).cards[task.cardId].links,[session.id]);
  await h.store.unlinkSession({taskId:task.cardId,sessionId:session.id});
  await assert.rejects(h.ctl.bundle(session.id,{taskId:task.cardId,unlink:true}),/変更/);
 }finally{await h.close();}
});


test('opening the real bundle data path is read-only and candidates include already linked session metadata',()=>{
 const fx=makeFixtures();
 try {
  const out=execFileSync(process.execPath,['--no-warnings','--input-type=module','-e',`
    import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(path.join(process.env.CANBAN_CODEX_HOME,'state_5.sqlite'));
    const original=db.prepare("SELECT cwd,git_branch FROM threads WHERE id='t1'").get();
    db.prepare("UPDATE threads SET cwd=?,git_branch=? WHERE id='t3'").run(original.cwd,original.git_branch);db.close();
    const {Store}=await import('./server/store.mjs');const {boardTools}=await import('./server/tools/board.mjs');
    const store=new Store(process.env.CANBAN_DATA_DIR);const task=await store.createTask({title:'Existing work'});
    await store.linkSession({taskId:task.cardId,sessionId:'codex:t3'});
    const before=JSON.stringify(await store.load());
    store.resolvePending=()=>{throw Error('opening picker must not resolve pending launches');};
    store.markAllSeen=()=>{throw Error('opening picker must not mark seen');};
    store.applyAutoMoves=()=>{throw Error('opening picker must not run rules');};
    const api=boardTools({store}).find(t=>t.name==='canban_get_board');
    const code=[fs.readFileSync('ui/work-bundle-model.js','utf8'),fs.readFileSync('ui/work-bundle.js','utf8'),'({readWorkBundle,workSuggestions})'].join(String.fromCharCode(10));
    const view=vm.runInNewContext(code,{bridge:{callTool:async(name,args)=>{if(name!=='canban_get_board')throw Error('picker must not use mark-seen session detail');return(await api.handler(args)).structured;}}});
    const snapshot=await view.readWorkBundle('codex:t1');const suggestions=view.workSuggestions(snapshot.session,snapshot.tasks);
    if(before!==JSON.stringify(await store.load()))throw Error('opening picker changed saved state');
    console.log(JSON.stringify({suggestions,taskId:task.cardId}));process.exit(0);
  `],{cwd:path.resolve(import.meta.dirname,'..'),encoding:'utf8',timeout:30000,env:{...process.env,CANBAN_DATA_DIR:path.join(fx.root,'bundle-data'),CANBAN_CODEX_HOME:fx.codexHome,CANBAN_CLAUDE_HOME:fx.claudeHome,CANBAN_CLAUDE_DESKTOP_DIR:fx.desktopDir,CANBAN_BACKGROUND:'0'}});
  const result=JSON.parse(out);assert.equal(result.suggestions[0]?.taskId,result.taskId);assert.equal(result.suggestions[0]?.strength,'strong');
 }finally{fx.cleanup();}
});

test('picker separates current membership from choices and puts explicit unlink last',()=>{
 const {workBundleChoices}=vm.runInNewContext(`${source()}\n({workBundleChoices})`);
 const current={id:'task:current',title:'いまの仕事',links:[{id:session.id}]};
 const result=workBundleChoices(session,[current]);
 assert.equal(result.current.id,current.id);
 assert.equal(result.items[0].value,'__new');
 assert.equal(result.items.at(-1).value,'__unlink');
 assert.equal(result.items.at(-1).label,'この仕事から外す');
 assert.equal(result.items.some(item=>item.value===current.id),false);
 assert.match(result.explanation,/いまの仕事/);
});

test('selecting the current task without explicit unlink is a no-op',async()=>{
 const h=await harness();try{
  const task=await h.store.createTask({title:'current'});await h.store.linkSession({taskId:task.cardId,sessionId:session.id});
  const before=h.mutations;assert.equal(await h.ctl.bundle(session.id,{taskId:task.cardId}),null);
  assert.equal(h.mutations,before);assert.deepEqual((await h.store.load()).cards[task.cardId].links,[session.id]);
 }finally{await h.close();}
});

test('new membership actions remove stale undo controls, disable command undo while pending, and bind each toast to its own receipt',async()=>{
 let options,shownUndo=null,release,count=0;const undone=[];
 const first={sessionId:'codex:one',toTaskId:'task:first',title:'first'},second={sessionId:'codex:one',toTaskId:null,title:'second'};
 const context={
  createWorkBundleController:()=>({bundle:async()=>++count===1?first:await new Promise(r=>release=r),undo:async r=>(undone.push(r),true)}),
  workBundleDisabledReason:()=>null,workBundleChoices:()=>({current:{id:'task:old'},items:[],explanation:'current'}),
  findCard:()=>({card:{id:'codex:one',kind:'session'}}),panes:[],state:{},document:{activeElement:null,body:{}},paneDocked:()=>false,
  bridge:{callTool:async()=>({lists:[{id:'inbox',cards:[{id:'codex:one',kind:'session',title:'one'}]}]})},
  h:()=>({}),picker:(_,o)=>(options=o,{isConnected:true,refreshItems(){}}),crypto:{randomUUID:()=> 'fixture'},
  toast:()=>{shownUndo=null;},toastAction:(_msg,_label,fn)=>{shownUndo=fn;},load:async()=>{},
 };
 const ui=vm.runInNewContext(fs.readFileSync(new URL('../ui/work-bundle.js',import.meta.url),'utf8')+'\n({workBundlePicker,workBundleUndoAvailable,undoWorkBundle})',context);
 await ui.workBundlePicker({},'codex:one');await options.onPick('__new');const oldUndo=shownUndo;
 const pending=options.onPick('__unlink');assert.equal(shownUndo,null);assert.equal(ui.workBundleUndoAvailable(),false);
 await ui.undoWorkBundle();assert.equal(undone.length,0);
 release(second);await pending;const newUndo=shownUndo;assert.equal(ui.workBundleUndoAvailable(),true);
 await oldUndo();await newUndo();assert.equal(undone[0],first);assert.equal(undone[1],second);
});

test('undo keeps a newly bundled task when a user later adds a manual reference, dependency or derived edge',async()=>{
 for(const kind of ['ref','blocks','derived']){
  const h=await harness();try{
   const receipt=await h.ctl.bundle(session.id,{create:true,clientRequestId:`manual-${kind}`});
   const peer=await h.store.createTask({title:`manual peer ${kind}`});
   const added=await h.store.linkCardRelation({fromId:peer.cardId,toId:receipt.toTaskId,kind});
   assert.equal(await h.ctl.undo(receipt),true);
   const state=await h.store.load();
   assert.ok(state.cards[receipt.toTaskId],'manual relations are an edit even when the task record itself is unchanged');
   assert.deepEqual(state.cards[receipt.toTaskId].links,[],'undo still restores the membership');
   assert.equal(receipt.retainedTask,true);assert.equal(receipt.cleanupUnconfirmed,false);
   assert.equal(state.manualCardRelations[0].id,added.relation.id);
   await h.store.deleteTask({cardId:receipt.toTaskId});
   assert.equal((await h.store.getCardRelations({cardId:peer.cardId})).relations[0].id,added.relation.id,'explicit deletion keeps a missing reference rather than silently deleting the relation');
  }finally{await h.close();}
 }
});

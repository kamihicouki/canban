import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Store,defaultState,normalize} from '../server/store.mjs';
import {makeFixtures} from './helpers.mjs';
import {canonicalManualRelation,addManualRelation,removeManualRelation,queryManualRelations,assertRelationCardId,manualTaskSessionState} from '../server/card-relations.mjs';
const now='2026-11-14T00:00:00.000Z';
const edge=(id,kind,fromId,toId)=>({id,kind,fromId,toId,createdAt:now});
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'canban-relations-'));

test('manual relations canonicalize only undirected refs, reject self edges and preserve remote card IDs',()=>{
 assert.deepEqual(canonicalManualRelation({kind:'ref',fromId:'claude@box:two',toId:'codex:one'}),{kind:'ref',fromId:'claude@box:two',toId:'codex:one'});
 assert.deepEqual(canonicalManualRelation({kind:'ref',fromId:'codex:one',toId:'claude@box:two'}),{kind:'ref',fromId:'claude@box:two',toId:'codex:one'});
 assert.deepEqual(canonicalManualRelation({kind:'blocks',fromId:'codex:one',toId:'claude@box:two'}),{kind:'blocks',fromId:'codex:one',toId:'claude@box:two'});
 for(const kind of ['ref','blocks','derived'])assert.throws(()=>canonicalManualRelation({kind,fromId:'codex:a',toId:'codex:a'}),/自分自身/);
 for(const valid of ['codex:session_uuid_su','claude:会話123','codex@my-box:019a-dbad-44ea-uuid','claude@remote.会社:セッション'])assert.equal(assertRelationCardId(valid),valid);
 for(const invalid of ['codex:has space','codex:has\tTab','codex:bad\u0000id','codex:bad\u001fid'])assert.throws(()=>assertRelationCardId(invalid),/ID/);
 for(const bad of ['','not-a-card','codex:a\n','codex:'])assert.throws(()=>canonicalManualRelation({kind:'ref',fromId:bad,toId:'codex:b'}),/ID/);
});

test('duplicates are idempotent and each directed kind is a DAG while cross-kind dependencies are allowed',()=>{
 const a=addManualRelation([],{kind:'ref',fromId:'codex:a',toId:'claude:b'},{id:'relation-a',createdAt:now});
 const b=addManualRelation(a.relations,{kind:'ref',fromId:'claude:b',toId:'codex:a'},{id:'relation-b',createdAt:now});
 assert.equal(b.created,false);assert.equal(b.relation.id,'relation-a');assert.equal(b.relations.length,1);
 for(const kind of ['blocks','derived']){
  const existing=[edge('relation-a',kind,'codex:a','codex:b'),edge('relation-b',kind,'codex:b','codex:c')];
  assert.throws(()=>addManualRelation(existing,{kind,fromId:'codex:c',toId:'codex:a'},{id:'cycle',createdAt:now}),/循環/);
 }
 const derived=[edge('relation-a','derived','codex:a','codex:b')];
 assert.equal(addManualRelation(derived,{kind:'blocks',fromId:'codex:b',toId:'codex:a'},{id:'relation-b',createdAt:now}).created,true);
});

test('deletion requires the exact expected edge and queries never discard a missing peer',()=>{
 const relation=edge('relation-a','blocks','codex:a','codex:missing'),relations=[relation];
 assert.equal(queryManualRelations(relations,'codex:missing')[0].direction,'incoming');
 assert.equal(queryManualRelations(relations,'codex:a')[0].direction,'outgoing');
 assert.throws(()=>removeManualRelation(relations,{relationId:relation.id,expectedRelation:{...relation,toId:'codex:other'}}),/変更/);
 assert.throws(()=>removeManualRelation(relations,{relationId:relation.id}),/期待/);
 assert.equal(removeManualRelation(relations,{relationId:relation.id,expectedRelation:relation}).removed,true);
 assert.equal(removeManualRelation([],{relationId:relation.id,expectedRelation:relation}).removed,false);
 assert.equal(relations.length,1,'pure queries and removal never mutate the caller input');
});

test('Store isolates manual relations from membership, retains deleted peers, and does not write on read or duplicate links',async()=>{
 const dir=temp(),store=new Store(dir);
 try{
  const a=await store.createTask({title:'a'}),b=await store.createTask({title:'b'});
  await store.linkSession({taskId:a.cardId,sessionId:'codex:session'});
  const linked=await store.linkCardRelation({fromId:a.cardId,toId:b.cardId,kind:'ref'});
  const revision=await store.database.call('system','revision',['board_change']);
  const repeated=await store.linkCardRelation({fromId:b.cardId,toId:a.cardId,kind:'ref'});
  assert.equal(repeated.created,false);assert.equal(repeated.relation.id,linked.relation.id);
  await store.getCardRelations({cardId:a.cardId});
  assert.equal(await store.database.call('system','revision',['board_change']),revision);
  assert.deepEqual((await store.load()).cards[a.cardId].links,['codex:session']);
  await store.deleteTask({cardId:b.cardId});
  assert.equal((await store.getCardRelations({cardId:a.cardId})).relations.length,1);
  assert.equal((await store.linkCardRelation({fromId:a.cardId,toId:b.cardId,kind:'ref'})).created,false,'an existing edge remains idempotent when its peer is unavailable');
  await assert.rejects(store.unlinkCardRelation({relationId:linked.relation.id,expectedRelation:{...linked.relation,kind:'derived'}}),/変更/);
  assert.equal((await store.getCardRelations({cardId:a.cardId})).relations.length,1);
  await store.unlinkCardRelation({relationId:linked.relation.id,expectedRelation:linked.relation});
  assert.deepEqual((await store.load()).manualCardRelations,[]);
  const replacement=await store.linkCardRelation({fromId:a.cardId,toId:'codex:new',kind:'blocks'});
  await store.unlinkCardRelation({relationId:replacement.relation.id,expectedRelation:replacement.relation});
  const later=await store.linkCardRelation({fromId:a.cardId,toId:'codex:new',kind:'blocks'});
  assert.notEqual(later.relation.id,replacement.relation.id);
  assert.equal((await store.unlinkCardRelation({relationId:replacement.relation.id,expectedRelation:replacement.relation})).removed,false);
  assert.equal((await store.getCardRelations({cardId:a.cardId})).relations[0].id,later.relation.id,'stale deletion cannot delete a re-created semantic edge');
  assert.deepEqual(normalize({}).manualCardRelations,[]);
 }finally{await store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('two processes cannot race reciprocal directed edges into a cycle',async()=>{
 const dir=temp(),store=new Store(dir);await store.load();
 try{
  const run=promisify(execFile);
  const script=`import {Store}from'./server/store.mjs';const s=new Store(process.argv[1]);try{const r=await s.linkCardRelation({kind:'blocks',fromId:process.argv[2],toId:process.argv[3]});console.log(JSON.stringify({created:r.created}));}catch(e){console.log(JSON.stringify({rejected:e.message}));}finally{await s.close();}`;
  const results=await Promise.all([['codex:a','codex:b'],['codex:b','codex:a']].map(ids=>run(process.execPath,['--no-warnings','--input-type=module','-e',script,dir,...ids],{cwd:path.resolve(import.meta.dirname,'..')})));
  const states=results.map(r=>JSON.parse(r.stdout));assert.equal(states.filter(r=>r.created).length,1);assert.equal(states.filter(r=>r.rejected?.includes('循環')).length,1);
  assert.equal((await store.load()).manualCardRelations.length,1);
 }finally{await store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('legacy JSON migration and SQLite export/import preserve manual edges without a schema change',async()=>{
 const dir=temp(),restored=temp(),saved=edge('relation-existing','ref','claude@box:old','task:missing');
 try{
  fs.writeFileSync(path.join(dir,'board.json'),JSON.stringify({...defaultState(),manualCardRelations:[saved]}));
  const run=(folder,...args)=>execFileSync(process.execPath,['scripts/migrate-sqlite.mjs','--data-dir',folder,'--apply',...args],{cwd:path.resolve(import.meta.dirname,'..'),encoding:'utf8',env:{...process.env,PATH:'/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'}});
  run(dir);run(dir,'--export');
  const output=path.join(dir,fs.readdirSync(dir).find(n=>n.startsWith('export-')));
  const exported=JSON.parse(fs.readFileSync(path.join(output,'board.json'),'utf8'));assert.deepEqual(exported.manualCardRelations,[saved]);
  fs.copyFileSync(path.join(output,'board.json'),path.join(restored,'board.json'));run(restored);
  const store=new Store(restored);assert.deepEqual((await store.load()).manualCardRelations,[saved]);await store.close();
 }finally{fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(restored,{recursive:true,force:true});}
});

test('public tools resolve archived and unavailable peers without changing original files or stored state',()=>{
 const fx=makeFixtures();try{
  const before=fx.snapshot();
  const script=`const {Store}=await import('./server/store.mjs');const {cardRelationTools}=await import('./server/tools/card-relations.mjs');const store=new Store(process.env.CANBAN_DATA_DIR);const tools=Object.fromEntries(cardRelationTools({store}).map(t=>[t.name,t]));const a=await store.createTask({title:'source'}),b=await store.createTask({title:'peer'});const linked=(await tools.canban_link_card_relation.handler({fromId:a.cardId,toId:'codex:t3',kind:'ref'})).structured;await store.linkCardRelation({fromId:a.cardId,toId:b.cardId,kind:'derived'});await store.deleteTask({cardId:b.cardId});let missingRejected=false;try{await tools.canban_link_card_relation.handler({fromId:a.cardId,toId:'grok:missing',kind:'ref'});}catch{missingRejected=true;}if(!missingRejected)throw Error('new relations must resolve both endpoints');const saved=JSON.stringify(await store.load());const data=(await tools.canban_get_card_relations.handler({cardId:a.cardId})).structured;if(saved!==JSON.stringify(await store.load()))throw Error('reading relations changed saved state');console.log(JSON.stringify({data,linked}));await store.close();`;
  const out=execFileSync(process.execPath,['--no-warnings','--input-type=module','-e',script],{cwd:path.resolve(import.meta.dirname,'..'),encoding:'utf8',env:{...process.env,CANBAN_DATA_DIR:path.join(fx.root,'relation-data'),CANBAN_CODEX_HOME:fx.codexHome,CANBAN_CLAUDE_HOME:fx.claudeHome,CANBAN_CLAUDE_DESKTOP_DIR:fx.desktopDir,CANBAN_BACKGROUND:'0'}});
  const {data}=JSON.parse(out),arch=data.relations.find(r=>r.other.id==='codex:t3'),missing=data.relations.find(r=>r.other.id.startsWith('task:'));
  assert.equal(arch.other.archived,true);assert.equal(arch.other.available,true);assert.equal(missing.other.available,false);assert.equal(missing.other.statusKnown,false);assert.ok(Array.isArray(data.errors));
  for(const[file,hash]of Object.entries(before))assert.equal(fx.snapshot()[file],hash);
 }finally{fx.cleanup();}
});


test('related tasks describe known linked-session states without inventing task completion',()=>{
 const links=[{id:'codex:a',status:'running'},{id:'claude:b',status:'aborted'},{id:'codex:unknown',status:'completed',statusKnown:false}];
 assert.deepEqual(manualTaskSessionState({links}),{status:'aborted',statusKnown:true,statusScope:'linked-sessions',statusPartial:true,linkedSessionCount:3});
 assert.equal(manualTaskSessionState({links:[...links,{id:'claude:wait',status:'waiting'}]}).status,'waiting');
 assert.equal(manualTaskSessionState({links:[{id:'codex:a',status:'completed',statusKnown:false}]}).status,null);
 assert.equal(manualTaskSessionState({links:[],linkedSessionIds:['codex:missing']}).statusKnown,false);
 assert.equal(manualTaskSessionState({links:[]}).linkedSessionCount,0);
 assert.equal(manualTaskSessionState({links:[{id:'codex:a',status:'completed'}]}).statusScope,'linked-sessions');
});

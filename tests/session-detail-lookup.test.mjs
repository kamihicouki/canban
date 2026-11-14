import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionDetailLookup, sessionSnapshotKey, matchingSessionSnapshot } from '../server/session-detail-lookup.mjs';
const row = (id='codex:one') => ({id,nativeId:id.split(':')[1],agent:'codex',host:{local:true},sourcePath:'/fixture/one.jsonl'});
const context = {settings:{accounts:{claudeHomes:[],codexHomes:[]}},remoteHosts:{},cards:{}};
const store = {load:async()=>context};
test('a snapshot is discarded after source invalidation or account, remote and placement changes', () => {
 const snapshot={sessions:[row()],at:44,generation:2,key:sessionSnapshotKey(context)};
 assert.equal(matchingSessionSnapshot(snapshot,context,2),snapshot);
 assert.equal(matchingSessionSnapshot(null,context,2),null);
 assert.equal(matchingSessionSnapshot(snapshot,context,3),null);
 for(const change of [s=>{s.settings.accounts.codexHomes=['/different'];},s=>{s.remoteHosts.one={enabled:true};},s=>{s.cards['codex:one']={listId:'inbox'};}]) {
  const state=structuredClone(context);change(state);assert.equal(matchingSessionSnapshot(snapshot,state,2),null);
 }
});
const full = {session:row('claude:other'),state:context,host:null,sessions:[],coverage:{state:'current',at:50,reason:null}};
function fixture(overrides={}) {
 const called={full:0,local:[],decorate:[]};
 const lookup=createSessionDetailLookup({
  configure(){},findLocalCodex:async id=>{called.local.push(id);return row('codex:'+id);},
  decorate:async s=>{called.decorate.push(s.id);return {...s,status:'completed'};},
  getSnapshot:()=>null,
  fullLookup:async()=>{called.full++;return full;},
  ...overrides,
 });return{lookup,called};
}
test('local Codex detail resolves while the unrelated global listing remains permanently pending',async()=>{
 const f=fixture({fullLookup:()=>new Promise(()=>{})});let timer;
 try {const d=await Promise.race([f.lookup(store,'codex:one'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('detail waited for global listing')),1000);})]);
 assert.equal(d.session.id,'codex:one');assert.equal(d.session.status,'completed');assert.deepEqual(f.called.local,['one']);assert.deepEqual(f.called.decorate,['codex:one']);
 assert.equal(d.state,context);assert.equal(d.host,null);assert.deepEqual(d.sessions,[]);assert.equal(d.coverage.state,'unavailable');assert.ok(d.coverage.reason);
 }finally{clearTimeout(timer);}
});
test('related metadata is explicitly a dated snapshot, rather than invented complete zero results',async()=>{
 const sessions=[row(),row('codex:two')],f=fixture({getSnapshot:()=>({sessions,at:44})});const d=await f.lookup(store,'codex:one');
 assert.equal(d.sessions,sessions);assert.deepEqual(d.coverage,{state:'snapshot',at:44,reason:null});
});
for(const id of ['codex@remote:one','claude:one','gemini:one'])test(id+' preserves the existing provider/remote lookup and permission boundary',async()=>{
 const f=fixture();assert.equal(await f.lookup(store,id),full);assert.equal(f.called.full,1);assert.deepEqual(f.called.local,[]);
});
test('missing local SQL rows keep the existing cloud/not-found resolution instead of inventing a local session',async()=>{
 const f=fixture({findLocalCodex:async()=>null});assert.equal(await f.lookup(store,'codex:one'),full);assert.equal(f.called.full,1);
});
for(const candidate of [{...row(),id:'codex:other'},{...row(),host:{local:false}},{...row(),sourceKind:'codex-cloud'}])test('an inexact, remote or cloud candidate never gains local capabilities: '+JSON.stringify({id:candidate.id,cloud:candidate.sourceKind,remote:candidate.host.local}),async()=>{
 const f=fixture({findLocalCodex:async()=>candidate});assert.equal(await f.lookup(store,'codex:one'),full);assert.equal(f.called.full,1);assert.deepEqual(f.called.decorate,[]);
});
test('lookup errors propagate without a silent fallback through another account or provider',async()=>{
 const f=fixture({findLocalCodex:async()=>{throw Error('source unavailable');}});await assert.rejects(f.lookup(store,'codex:one'),/source unavailable/);assert.equal(f.called.full,0);
});
test('snapshot identity includes account homes, enabled remote state and placed sessions, not notes',()=>{
 const a=structuredClone(context),b=structuredClone(context);b.cards['codex:one']={note:'changed'};
 assert.equal(sessionSnapshotKey(a),sessionSnapshotKey(b));b.settings.accounts.codexHomes=['/another'];assert.notEqual(sessionSnapshotKey(a),sessionSnapshotKey(b));
 b.settings.accounts.codexHomes=[];b.remoteHosts={remote:{enabled:true}};assert.notEqual(sessionSnapshotKey(a),sessionSnapshotKey(b));b.remoteHosts={};b.cards['codex:one'].listId='inbox';assert.notEqual(sessionSnapshotKey(a),sessionSnapshotKey(b));
});

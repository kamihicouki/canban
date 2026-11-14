import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=()=>fs.readFileSync(new URL('../ui/card-relations-model.js',import.meta.url),'utf8');
const model=()=>vm.runInNewContext(source()+'\n({cardRelationLabel,cardRelationPlan,cardRelationExpected,createCardRelationSearch});',{setTimeout,clearTimeout});

test('manual relation labels distinguish reference, prerequisite direction and derivation direction',()=>{
 const m=model();
 assert.match(m.cardRelationLabel({kind:'ref',direction:'undirected'}),/参考.*双方向/);
 assert.match(m.cardRelationLabel({kind:'blocks',direction:'outgoing'}),/このカード.*先/);
 assert.match(m.cardRelationLabel({kind:'blocks',direction:'incoming'}),/相手.*先/);
 assert.match(m.cardRelationLabel({kind:'derived',direction:'outgoing'}),/派生先/);
 assert.match(m.cardRelationLabel({kind:'derived',direction:'incoming'}),/派生元/);
 assert.deepEqual(JSON.parse(JSON.stringify(m.cardRelationPlan('blocks-in','task:a','codex:b'))),{kind:'blocks',fromId:'codex:b',toId:'task:a'});
 assert.deepEqual(JSON.parse(JSON.stringify(m.cardRelationPlan('derived-out','task:a','codex:b'))),{kind:'derived',fromId:'task:a',toId:'codex:b'});
 assert.throws(()=>m.cardRelationPlan('invented','task:a','codex:b'),/種類/);
});

test('unlink expectation contains only the exact persisted edge, not source observations',()=>{
 const m=model(),edge={id:'r1',kind:'ref',fromId:'a',toId:'b',createdAt:'2026-11-14T00:00:00Z',direction:'undirected',other:{title:'another'}};
 assert.deepEqual(JSON.parse(JSON.stringify(m.cardRelationExpected(edge))),{id:'r1',kind:'ref',fromId:'a',toId:'b',createdAt:'2026-11-14T00:00:00Z'});
});

test('all-source target search is debounced, excludes self, and ignores obsolete results and disposed requests',async()=>{
 const m=model(),timers=new Map(),requests=[],changes=[];let next=0;
 const search=m.createCardRelationSearch({cardId:'task:self',setTimer:fn=>{timers.set(++next,fn);return next;},clearTimer:id=>timers.delete(id),search:args=>new Promise((resolve,reject)=>requests.push({args,resolve,reject})),onChange:x=>changes.push(x)});
 const flush=()=>{for(const[id,fn]of timers){timers.delete(id);fn();}};const tick=async()=>{await Promise.resolve();await Promise.resolve();};
 search.update('first');flush();search.update('second');flush();
 assert.deepEqual(JSON.parse(JSON.stringify(requests[1].args)),{q:'second',days:0,includeArchived:true,includeSubagents:true,dotScope:'all',limit:50});
 requests[1].resolve({results:[{cardId:'task:self'},{cardId:'claude:arch',title:'archived',archived:true}],errors:[]});await tick();
 assert.deepEqual(Array.from(changes.at(-1).rows,x=>x.cardId),['claude:arch']);
 requests[0].resolve({results:[{cardId:'old'}]});await tick();assert.equal(changes.at(-1).rows[0].cardId,'claude:arch');
 search.update('third');flush();const count=changes.length;search.dispose();requests[2].resolve({results:[{cardId:'late'}]});await tick();assert.equal(changes.length,count);
});

test('target search failures are visible and do not become a healthy empty result',async()=>{
 const m=model();let task,last;const api=m.createCardRelationSearch({cardId:'task:self',setTimer:fn=>(task=fn,1),clearTimer(){},search:async()=>{throw Error('source unavailable');},onChange:x=>last=x});
 api.update('target');await task();
 assert.equal(last.state,'error');assert.match(last.error,/source unavailable/);
});


test('task relation states describe linked sessions, absence and partial observation without claiming task completion',()=>{
 const text=vm.runInNewContext(source()+'\ncardRelationOtherText');
 assert.match(text({kind:'task',available:true,statusKnown:false,linkedSessionCount:0}),/セッションなし/);
 const partial=text({kind:'task',available:true,statusKnown:true,status:'waiting',linkedSessionCount:3,statusPartial:true},{waiting:'入力待ち'});
 assert.match(partial,/関連セッション: 入力待ち/);assert.match(partial,/一部未取得/);
 assert.match(text({kind:'task',available:false,linkedSessionCount:0}),/カードは未取得/);
 assert.doesNotMatch(text({kind:'task',available:false,linkedSessionCount:0}),/セッションなし/);
});

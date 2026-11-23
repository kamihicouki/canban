import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const c=vm.createContext({});vm.runInContext(fs.readFileSync('ui/card-overlay-model.js','utf8')+';globalThis.api={normalizeCardShape,workspaceLastMessage,workspaceCanReuseOrigin,workspaceOriginExcerpt,workspaceOriginFor,workspaceOriginReverted};',c);
test('new and unknown preferences use workspace; explicit legacy card survives',()=>{
 assert.equal(c.api.normalizeCardShape(undefined),'workspace');assert.equal(c.api.normalizeCardShape('future'),'workspace');assert.equal(c.api.normalizeCardShape('card'),'card');
});
test('current position uses the last observed message without inventing progress',()=>{
 const last=c.api.workspaceLastMessage([{k:'assistant',text:'前の返答',at:'2026-11-15T00:00:00Z'},{k:'tool',text:'tool'},{k:'user',text:'追加依頼',at:null}]);assert.equal(last.k,'user');assert.equal(last.text,'追加依頼');assert.equal(last.at,null);assert.equal(c.api.workspaceLastMessage([]),null);
});
test('tail first message cannot masquerade as the original prompt',()=>{
 const it={k:'user',text:'同じ文'};assert.equal(c.api.workspaceCanReuseOrigin(false,it,[it]),false);assert.equal(c.api.workspaceCanReuseOrigin(true,it,[{k:'user',text:'異なる文'}]),false);assert.equal(c.api.workspaceCanReuseOrigin(true,it,[it]),true);
});
test('the excerpt stands for the first request only when the server says so',()=>{
 const session={preview:'依頼'};
 assert.equal(c.api.workspaceOriginExcerpt({session}),null);assert.equal(c.api.workspaceOriginExcerpt({session,originExcerpt:'origin'}),'依頼');
 for(const originExcerpt of ['reverted','unknown','future'])assert.equal(c.api.workspaceOriginExcerpt({session,originExcerpt}),null);
 assert.equal(c.api.workspaceOriginExcerpt(undefined),null);
 assert.equal(c.api.workspaceOriginReverted({originExcerpt:'reverted'}),true);assert.equal(c.api.workspaceOriginReverted({originExcerpt:'unknown'}),false);assert.equal(c.api.workspaceOriginReverted(undefined),false);
});
test('a fetched origin is dropped once the thread moves to another log',()=>{
 const origin={item:{text:'旧い起点'}},fetched={log:'/a.jsonl',origin};
 assert.equal(c.api.workspaceOriginFor(fetched,{sourcePath:'/a.jsonl'}),origin);assert.equal(c.api.workspaceOriginFor(fetched,{sourcePath:'/b.jsonl'}),null);
 assert.equal(c.api.workspaceOriginFor(undefined,{sourcePath:'/a.jsonl'}),null);assert.equal(c.api.workspaceOriginFor({log:null,origin},{}),origin);
});
test('refreshing a card whose queued request is being edited repaints the origin with the conversation',()=>{
 const src=fs.readFileSync('ui/card-overlay.js','utf8');
 const body=src.slice(src.indexOf('function renderPaneKeepingDrafts('),src.indexOf('async function changeSessionCardState('));
 const painted=[];
 const conv={replaceChildren(...kids){this.kids=kids;}};
 const el={querySelector:q=>q==='.req-row textarea'?{}:null};
 const ctx={live:{feeds:new Map()},$:q=>q==='.th-conv'?conv:null,renderFeed:()=>'feed',paintWorkspaceContext:p=>painted.push(p.d.session.sourcePath)};
 vm.runInNewContext(body+'\nrenderPaneKeepingDrafts',ctx)({id:'codex:a',el,d:{session:{sourcePath:'/a.jsonl'}}},{session:{sourcePath:'/b.jsonl'},feed:{}});
 assert.deepEqual([...conv.kids],['feed']);assert.deepEqual(painted,['/b.jsonl']);
});
test('an origin inserted from a replaced log leaves the conversation even when the new one is unreadable',()=>{
 const src=fs.readFileSync('ui/card-workspace.js','utf8');
 const body=src.slice(src.indexOf('function dropInsertedOrigin('),src.indexOf('async function jumpWorkspaceOrigin('));
 const removed=[];const list={querySelectorAll:q=>q.split(',').map(name=>({remove:()=>removed.push(name)}))};
 const run=vm.runInNewContext(body+'\ndropInsertedOrigin',{live:{feeds:new Map([['codex:a',{list}]])}});
 run({id:'codex:a'});assert.deepEqual(removed,['.ws-origin-message','.ws-origin-gap']);run({id:'codex:missing'});
 const paint=src.slice(src.indexOf('function paintWorkspaceContext('),src.indexOf('function dropInsertedOrigin('));
 assert.match(paint,/if \(p\.workspaceOrigin && !origin\) dropInsertedOrigin\(p\)/);
});
test('a refresh that keeps the conversation does not write the old reading position back',()=>{
 const src=fs.readFileSync('ui/card-overlay.js','utf8');
 const body=src.slice(src.indexOf('function renderPaneKeepingDrafts('),src.indexOf('async function changeSessionCardState('));
 const run=feed=>{
  const list={scrollTop:100},conv={replaceChildren(){}};
  const ctx={live:{feeds:new Map([['codex:a',{list}]])},$:q=>q==='.th-conv'?conv:q==='.feed'?list:null,atFeedEnd:()=>false,renderFeed:()=>'feed',paintWorkspaceContext:()=>{list.scrollTop=40;}};
  vm.runInNewContext(body+'\nrenderPaneKeepingDrafts',ctx)({id:'codex:a',el:{querySelector:()=>({})}},{session:{},feed});
  return list.scrollTop;
 };
 assert.equal(run(null),40,'removing the inserted origin has already moved the scroll position with the text');
 assert.equal(run({}),100,'a rebuilt conversation returns to where it was read');
});

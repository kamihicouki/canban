import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const c=vm.createContext({});vm.runInContext(fs.readFileSync('ui/card-overlay-model.js','utf8')+';globalThis.api={normalizeCardShape,workspaceLastMessage,workspaceCanReuseOrigin,workspaceOriginExcerpt,workspaceOriginFor};',c);
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
 assert.equal(c.api.workspaceOriginExcerpt({session}),null);assert.equal(c.api.workspaceOriginExcerpt({session,excerptIsOrigin:true}),'依頼');
 assert.equal(c.api.workspaceOriginExcerpt({session,excerptIsOrigin:false}),null);assert.equal(c.api.workspaceOriginExcerpt(undefined),null);
});
test('a fetched origin is dropped once the thread moves to another log',()=>{
 const origin={item:{text:'旧い起点'}},fetched={log:'/a.jsonl',origin};
 assert.equal(c.api.workspaceOriginFor(fetched,{sourcePath:'/a.jsonl'}),origin);assert.equal(c.api.workspaceOriginFor(fetched,{sourcePath:'/b.jsonl'}),null);
 assert.equal(c.api.workspaceOriginFor(undefined,{sourcePath:'/a.jsonl'}),null);assert.equal(c.api.workspaceOriginFor({log:null,origin},{}),origin);
});

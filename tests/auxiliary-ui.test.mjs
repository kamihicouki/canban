import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../ui/auxiliary-ui.js',import.meta.url),'utf8');
const model=()=>vm.runInNewContext(source.slice(0,source.indexOf('// Secondary chrome state'))+'\n({normalizeAuxiliaryPrefs,nextAuxiliaryPrefs,auxiliaryModeSummary,auxiliaryLiveCards});');
const plain=x=>JSON.parse(JSON.stringify(x));
test('missing auxiliary preferences use minimal; a legacy pinned preference can be read without rewriting it',()=>{
 const m=model();assert.deepEqual(plain(m.normalizeAuxiliaryPrefs(null)),{ribbon:'minimal',card:'minimal',hud:'minimal',dock:'minimal'});
 assert.equal(m.auxiliaryModeSummary(m.normalizeAuxiliaryPrefs(null,'pinned')),'pinned');
});
test('individual preferences survive other individual changes until an explicit bulk operation',()=>{
 const m=model();let p=m.normalizeAuxiliaryPrefs(null);
 p=m.nextAuxiliaryPrefs(p,'ribbon','pinned');p=m.nextAuxiliaryPrefs(p,'hud','pinned');
 assert.deepEqual(plain(p),{ribbon:'pinned',card:'minimal',hud:'pinned',dock:'minimal'});assert.equal(m.auxiliaryModeSummary(p),'mixed');
 p=m.nextAuxiliaryPrefs(p,null,'minimal');assert.equal(m.auxiliaryModeSummary(p),'minimal');
 p=m.nextAuxiliaryPrefs(p,'card','pinned');assert.equal(p.ribbon,'minimal');assert.equal(p.card,'pinned');
});
test('unknown preference keys and invalid modes do not become persisted settings',()=>{
 const m=model();const p=m.normalizeAuxiliaryPrefs({ribbon:'future-mode',alien:'pinned',hud:'pinned'});
 assert.deepEqual(Object.keys(p),['ribbon','card','hud','dock']);assert.equal(p.ribbon,'minimal');assert.equal(p.hud,'pinned');
 assert.deepEqual(plain(m.nextAuxiliaryPrefs(p,'alien','pinned')),plain(p));
});
test('bulk controls do not overwrite the independent key-guide setting',()=>{
 const bulk=source.slice(source.indexOf('function setAuxiliaryMode('),source.indexOf('function toggleAuxiliaryUi('));
 assert.doesNotMatch(bulk,/setKeyGuidePlace|keyGuide/);
});

test('live summaries count linked and standalone sessions once and never infer unknown state',()=>{
 const m=model(), linked={id:'claude:waiting',status:'waiting',agent:'claude'};
 const board={lists:[{cards:[{id:'task:parent',kind:'task',status:'waiting',links:[linked,{id:'codex:unknown',status:'running',statusKnown:false}]},linked,{id:'codex:run',status:'running'}]}]};
 assert.deepEqual(Array.from(m.auxiliaryLiveCards(board),card=>card.id),['claude:waiting','codex:run']);
});

test('shared adoption restores the individual map without rewriting the independent key-guide preference',()=>{
 const boot=fs.readFileSync(new URL('../ui/boot.js',import.meta.url),'utf8');
 const adopter=boot.slice(boot.indexOf('function adoptSharedUi('),boot.indexOf('async function applySharedUi('));
 const state={},guide={dock:'bl',min:false},writes=[];
 const ctx=vm.createContext({state,keyGuidePlace:guide,sharedUi:{},SHARED_UI_KEYS:['auxiliaryPrefs','keyGuide'],store:{cache(){},set:(...args)=>writes.push(args)},workspace:{navigate(){}},workspacePage:()=> 'home',$:()=>null});
 vm.runInContext(source.slice(0,source.indexOf('// Secondary chrome state'))+'\n'+adopter,ctx);
 ctx.record={revision:4,state:{auxiliaryPrefs:{ribbon:'pinned',card:'minimal',hud:'minimal',dock:'minimal'}}};
 vm.runInContext('adoptSharedUi(record)',ctx);
 assert.deepEqual(plain(state.auxiliaryPrefs),ctx.record.state.auxiliaryPrefs);assert.equal(state.auxiliaryMode,'mixed');assert.equal(ctx.keyGuidePlace,guide);assert.deepEqual(writes,[]);
 ctx.record={revision:5,state:{auxiliaryMode:'pinned'}};vm.runInContext('adoptSharedUi(record)',ctx);
 assert.equal(state.auxiliaryMode,'pinned');assert.equal(ctx.keyGuidePlace,guide);
});

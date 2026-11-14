import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import {makeFixtures} from './helpers.mjs';

test('all-period archive search returns source, status and coverage metadata without changing card IDs',()=>{
  const fx=makeFixtures();
  try {
    const appFile=path.join(fx.codexHome,'.codex-global-state.json');
    const app=JSON.parse(fs.readFileSync(appFile,'utf8'));
    app['electron-persisted-atom-state']={'cloud-aeon-sidebar-cache-v1':{
      hostId:'fixture-cloud',refreshStartedAtMs:Date.now(),
      threads:[{id:'cloud-archive',name:'Cloud保存済み',preview:'架空のクラウド会話',createdAt:1790000000,updatedAt:1790000100,threadSource:'aeon_child',section:'archived'}],
      profilesByThreadId:{'cloud-archive':{id:'fixture-dot',aeon_kind:'orbit',active_root_thread_id:'fixture-root',display_name:'Dot検証'}},
      attachments:[{thread_id:'cloud-archive',is_user_visible:true,parent_thread_id:'fixture-root'}]
    }};
    fs.writeFileSync(appFile,JSON.stringify(app));
    const out=execFileSync(process.execPath,['--no-warnings','--input-type=module','-e',`
      const {Store}=await import('./server/store.mjs');
      const {boardTools}=await import('./server/tools/board.mjs');
      const store=new Store(process.env.CANBAN_DATA_DIR);
      const search=boardTools({store}).find(t=>t.name==='canban_search');
      const {cardId}=await store.createTask({title:'調査を束ねた仕事'});
      await store.linkSession({taskId:cardId,sessionId:'codex:t3'});
      const before=JSON.stringify(await store.load());
      store.resolvePending=()=>{throw Error('search must not resolve pending launches');};
      store.markAllSeen=()=>{throw Error('search must not mark cards as seen');};
      store.applyAutoMoves=()=>{throw Error('search must not run automation rules');};
      const result=await search.handler({q:'調査',days:0,includeArchived:true});
      const sub=await search.handler({q:'review',days:0,includeArchived:true,includeSubagents:true,dotScope:'all'});
      const cloud=await search.handler({q:'Cloud保存済み',days:0,includeArchived:true,includeSubagents:true,dotScope:'all'});
      result.structured.subCheck=sub.structured.results.find(r=>r.cardId==='codex:t2');
      result.structured.cloudCheck=cloud.structured.results.find(r=>r.cardId==='codex:cloud-archive');
      if(before!==JSON.stringify(await store.load()))throw Error('search changed saved user state');
      console.log(JSON.stringify(result.structured));process.exit(0);
    `],{cwd:path.resolve(import.meta.dirname,'..'),encoding:'utf8',timeout:30000,env:{...process.env,CANBAN_DATA_DIR:path.join(fx.root,'data'),CANBAN_CODEX_HOME:fx.codexHome,CANBAN_CLAUDE_HOME:fx.claudeHome,CANBAN_CLAUDE_DESKTOP_DIR:fx.desktopDir,CANBAN_BACKGROUND:'0'}});
    const result=JSON.parse(out),row=result.results.find(r=>r.cardId==='codex:t3');
    assert.ok(row);assert.equal(row.archived,true);assert.equal(row.surface,'cli');assert.equal(row.kind,'session');
    assert.equal(typeof row.status,'string');assert.equal(typeof row.statusKnown,'boolean');assert.ok(Array.isArray(result.errors));
    assert.equal(result.searchCoverage.fulltextDays,90);
    assert.equal(result.searchCoverage.fulltextApplied,false);
    assert.equal(result.subCheck.subagent,true);assert.equal(result.subCheck.surface,'cli');
    assert.equal(result.cloudCheck.surface,'cloud');assert.equal(result.cloudCheck.sourceKind,'codex-cloud');
    assert.equal(result.cloudCheck.dot.name,'Dot検証');assert.equal(result.cloudCheck.archived,true);assert.equal(result.cloudCheck.statusKnown,false);
  }finally{fx.cleanup();}
});


test('a failed remote body search preserves local hits and reports incomplete coverage',async()=>{
  const source=fs.readFileSync(new URL('../server/board.mjs',import.meta.url),'utf8');
  const fn=source.slice(source.indexOf('async function fullTextHits('),source.indexOf('const engines ='));
  const context=vm.createContext({ searchFor:()=>({query:()=>[{id:'local:hit',snippet:'match'}]}),pool:{search:async()=>{throw Error('offline');}} });
  vm.runInContext(fn,context);
  const errors=[];
  const result=await context.fullTextHits({},'query',[{id:'remote',label:'検証ホスト',enabled:true}],errors);
  assert.equal(result.get('local:hit'),'match');assert.equal(result.size,1);assert.match(errors[0],/検証ホスト.*本文検索.*offline/);
});


test('a failed local body index is reported as incomplete while remote hits remain searchable',async()=>{
  const source=fs.readFileSync(new URL('../server/board.mjs',import.meta.url),'utf8');
  const fn=source.slice(source.indexOf('async function fullTextHits('),source.indexOf('const engines ='));
  const context=vm.createContext({searchFor:()=>({query:(q,limit,options)=>{assert.equal(options.strict,true);throw Error('index missing');}}),pool:{search:async()=>new Set(['remote:hit'])}});
  vm.runInContext(fn,context);const errors=[];
  const result=await context.fullTextHits({},'query',[{id:'remote',enabled:true}],errors);
  assert.equal(result.has('remote:hit'),true);assert.match(errors[0],/ローカル.*index missing/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createDesktopLaunches } from '../server/desktop-launch.mjs';
import { prepareLaunchSelection } from '../server/launch-selection.mjs';

test('Chrome grants UI authority to all Desktop actions, and never to unrelated calls', () => {
  const source=fs.readFileSync(new URL('../scripts/chrome-native-host.mjs',import.meta.url),'utf8');
  const forward=source.slice(source.indexOf('function forward('),source.indexOf('const stdout ='));
  const sent=[];const context=vm.createContext({uiToken:'private-test-token',pending:new Map(),reply(){},child:{stdin:{write:line=>sent.push(JSON.parse(line))}}});
  vm.runInContext(forward,context);
  for(const name of ['canban_open_session','canban_acknowledge_desktop_launch','canban_get_desktop_launch_draft','canban_get_board']){
    context.message={jsonrpc:'2.0',id:sent.length+1,method:'tools/call',params:{name,arguments:{clientRequestId:'fixture'}}};
    vm.runInContext('forward(message)',context);
    assert.equal(sent.at(-1).params.arguments.uiToken,name==='canban_get_board'?undefined:'private-test-token',name);
  }
});
function resolver(current){
  const source=fs.readFileSync(new URL('../server/index.mjs',import.meta.url),'utf8');
  const resolve=source.slice(source.indexOf('async function resolveDesktopStart('),source.indexOf('const desktopLaunches ='));
  const ctx=vm.createContext({store:{load:async()=>({cards:{},settings:{accounts:{labels:{}}}})},prepareLaunchSelection,codexLaunchTargets:async()=>({}),LOCAL_HOST:{id:'local',local:true},newSessionLink:()=>({}),promptImages:()=>[],withSkills:x=>x,startAccount:async()=>({account:current()})});
  return vm.runInContext(resolve+'\nresolveDesktopStart',ctx);
}
test('resolved current Codex account is bound into target and source evidence',async()=>{
  const resolve=resolver(()=> 'codex:fixture-a');
  const target=await resolve({agent:'codex',cwd:'/work',prompt:'fictional'});
  assert.equal(target.account,'codex:fixture-a');
  assert.equal(target.selection.account,'codex:fixture-a');
});
test('an implicit Codex account change is rejected before opening',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canban-account-binding-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let checks=0,opens=0;const resolve=resolver(()=>++checks===1?'codex:fixture-a':'codex:fixture-b');
  const service=createDesktopLaunches({dataDir:dir,resolveTarget:resolve,open:async()=>{opens++;return {};}});
  const result=await service.start({agent:'codex',route:'desktop',cwd:'/work',prompt:'fictional',clientRequestId:'binding'});
  assert.equal(result.state,'failed');assert.equal(opens,0);
});

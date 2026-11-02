import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Store } from '../server/store.mjs';
import { launchOnce } from '../server/launcher.mjs';
import { prepareLaunchSelection } from '../server/launch-selection.mjs';
import { sessionSourceView } from '../server/source-model.mjs';
const ref = {provider:'codex',identityDomain:'app-storage',scopeId:'/fixture',kind:'project',nativeId:'p'};
const plain = v => JSON.parse(JSON.stringify(v));
const model = () => new vm.Script(fs.readFileSync(new URL('../ui/task-quick-add-model.js',import.meta.url),'utf8')+'\n({taskSessionRequest,rememberTaskLaunchResult,beginNewTaskRequest})').runInNewContext();
const ui = () => new vm.Script(fs.readFileSync(new URL('../ui/source-facets.js',import.meta.url),'utf8')+'\n({sourceFolders,workingFolderFacets,sourceLane,sourceFolderEntries})').runInNewContext();
const link = folder => ({id:folder,sourceView:sessionSourceView({cwd:folder})});

test('I1 every launch mode and an uncertain launch preserve manual sourceContext', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canban-preserve-plan-'));
  try {
    const store=new Store(dir); const sourceContext=[{ref,relation:'memberOf'}];
    const task=await store.createTask({title:'予定',sourceContext});
    for(const mode of ['folder','preset','projectless']) {
      const selection={mode,selectedRefs:mode==='preset'?[{...ref,nativeId:'other'}]:[]};
      const receipt={requestId:mode,status:'unresolved',sessionId:null,selectedRefs:selection.selectedRefs,appliedRefs:[]};
      await launchOnce(dir,mode,{mode},async()=> { await store.recordLaunch({taskId:task.cardId,selection,receipt});throw new Error('fake launch failure'); });
      const saved=(await store.load()).cards[task.cardId];
      assert.deepEqual(saved.sourceContext,sourceContext,mode);
      assert.equal(saved.launchReceipts.at(-1).status,'unresolved');
    }
    store.close?.();
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('I2 sourceRef is valid only with its matching Codex projectId', async () => {
  const targets={codex:{sourceObservation:{status:'known'},projects:[{id:'p',root:'/r/web',hostId:'local',sourceRef:ref}]}};
  for(const sourceRef of [ref,{...ref,provider:'claude',kind:'environment'},{...ref,kind:'section'},{...ref,provider:'claude',kind:'group'}]) {
    await assert.rejects(prepareLaunchSelection({agent:'codex',cwd:'/r/web',sourceRef},targets),/projectId|プロジェクト|出典/);
  }
  await assert.rejects(prepareLaunchSelection({agent:'codex',projectId:'p',sourceRef:{...ref,kind:'section'}},targets),/プロジェクト|出典/);
  assert.deepEqual((await prepareLaunchSelection({agent:'codex',projectId:'p',sourceRef:ref},targets)).selectedRefs,[ref]);
});

test('I3 legacy folder aliases deduplicate display without rewriting plans or inventing observations', () => {
  const m=ui();
  const card={kind:'task',context:{folder:'web'},links:[link('/r/web')]}; const before=JSON.stringify(card);
  assert.deepEqual(plain(m.sourceFolders(card)),['/r/web']);
  assert.deepEqual(plain(m.sourceFolderEntries(card)),[{folder:'/r/web',origins:['observed','planned']}]);
  const facets=plain(m.workingFolderFacets({lists:[{cards:[card]}]}));
  assert.equal(facets.length,1);assert.equal(facets[0].count,1);
  assert.equal(m.sourceLane(card,'workingFolder').id,'/r/web');
  assert.equal(JSON.stringify(card),before);
  const legacy={kind:'task',context:{folder:'web'},links:[]};
  assert.deepEqual(plain(m.sourceFolders(legacy)),[]);
  assert.equal(m.sourceLane(legacy,'workingFolder').legacyCondition,'web');
  const ambiguous={kind:'task',context:{folder:'web'},links:[link('/a/web'),link('/b/web')]};
  assert.deepEqual(plain(m.sourceFolderEntries(ambiguous)),[{folder:'/a/web',origins:['observed']},{folder:'/b/web',origins:['observed']}]);
  assert.equal(m.sourceLane(ambiguous,'workingFolder').id,'__multiple');
});

test('I4 explicit submit uses the same ID for the same request and a new ID after prompt or settings edits', async () => {
  const m=model(),draft={};let sequence=0,calls=0;
  const id=()=>`request-${++sequence}`;
  const initial={taskId:'task:a',agent:'codex',route:'desktop',cwd:'/r/web',prompt:'first'};
  const first=m.taskSessionRequest(draft,initial,id);
  const fake=async request=> {calls++;return {state:'uncertain',note:'fake unknown launch',receipt:{requestId:request.clientRequestId,status:'unresolved'}};};
  m.rememberTaskLaunchResult(draft,await fake(first));
  assert.equal(m.taskSessionRequest(draft,{...initial},id).clientRequestId,first.clientRequestId);
  assert.equal(calls,1,'editing/preparing never automatically resends');
  const edited=m.taskSessionRequest(draft,{...initial,prompt:'edited'},id);
  assert.notEqual(edited.clientRequestId,first.clientRequestId);assert.equal(edited.prompt,'edited');
  assert.equal(draft.launchHistory[0].result.note,'fake unknown launch');
  const settings=m.taskSessionRequest(draft,{...initial,prompt:'edited',projectId:'p',sourceRef:ref,cwd:''},id);
  assert.notEqual(settings.clientRequestId,edited.clientRequestId);
  assert.equal(settings.projectId,'p');assert.equal(draft.launchHistory[0].result.receipt.status,'unresolved');
  assert.equal(calls,1,'a new launch still requires an explicit caller action');
});

test('m1 the detail path constructs a source view only for its selected session', async () => {
  const {detailSessionState}=await import('../server/board.mjs');let reads=0;
  const unused={id:'other',get sourceMetadata(){reads++;throw new Error('unrelated source view');}};
  const picked=detailSessionState([unused,{id:'picked',agent:'codex',cwd:'/r/web'}],{cards:{}},'picked');
  assert.equal(picked.sourceView.workingLocations.value[0].folder,'/r/web');assert.equal(reads,0);
});

test('I3 an absolute folder lane condition survives the name-based task form and saving', async () => {
  const node=(tag,attrs={},...children)=>({tag,attrs,children:children.flat(),value:attrs.value||'',append(...items){this.children.push(...items);}});
  const source=fs.readFileSync(new URL('../ui/source-facets.js',import.meta.url),'utf8')+'\n'+fs.readFileSync(new URL('../ui/task-quick-add.js',import.meta.url),'utf8')+'\n taskQuickAdd';
  const editor=new vm.Script(source).runInNewContext({h:node});
  const draft={title:'absolute',description:'',listId:'inbox',labels:[],context:{folder:'/r/web'}};
  const form=editor.attributes(draft,{folders:[{name:'web',cwd:'/r/web'}],hosts:[],labels:[],accounts:{accounts:[]}},false,'organization');
  const all=[];const walk=item=>{if(!item||typeof item!=='object')return;all.push(item);for(const child of item.children||[])walk(child);};walk(form);
  const select=all.find(item=>item.tag==='select'&&item.attrs['aria-label']==='作業フォルダ');
  assert.equal(select.value,'/r/web');assert.ok(select.children.some(option=>option.attrs.value==='/r/web'));
  select.attrs.onchange({target:{value:select.value}});
  const saving=new vm.Script(fs.readFileSync(new URL('../ui/task-quick-add-model.js',import.meta.url),'utf8')+'\n saveQuickTaskDraft').runInNewContext();
  let saved;
  await saving(draft,{newRequestId:()=> 'absolute',refresh:async()=>{},callTool:async(name,args)=>{saved=args;return {...args,cardId:'task:absolute',listId:'inbox'};}});
  assert.equal(saved.context.folder,'/r/web');assert.equal(draft.context.folder,'/r/web');
});


test('I4 explicitly starting a new request permits the unchanged payload without losing the uncertain result', () => {
  const m=model(),draft={};let count=0;const next=()=>`new-${++count}`;
  const args={prompt:'same text',cwd:'/r/web',agent:'codex'};
  const first=m.taskSessionRequest(draft,args,next);
  m.rememberTaskLaunchResult(draft,{state:'uncertain',receipt:{requestId:first.clientRequestId,status:'unresolved'}});
  m.beginNewTaskRequest(draft);
  assert.equal(count,1,'the new-request action never launches automatically');
  const second=m.taskSessionRequest(draft,args,next);
  assert.notEqual(second.clientRequestId,first.clientRequestId);assert.equal(second.prompt,first.prompt);
  assert.equal(draft.launchHistory[0].result.receipt.status,'unresolved');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { compactSourceView, sessionSourceView, expandSourceView } from '../server/source-model.mjs';
import { compactCapabilities, capabilitiesFor, expandCapabilities } from '../server/source-capabilities.mjs';
import { prepareLaunchSelection } from '../server/launch-selection.mjs';
const plain = v => JSON.parse(JSON.stringify(v));
const ui = () => new vm.Script(fs.readFileSync(new URL('../ui/source-facets.js', import.meta.url), 'utf8') + '\n({expandUiSourceView,expandUiCapabilities,sourceLane,sourceObservationText,sourceFacetLabel,sourceFacetHint,sourceDetailRows})').runInNewContext();
const ref = { provider:'codex',identityDomain:'app-storage',scopeId:'/fixture',kind:'project',nativeId:'p' };

test('UI transport boundary has server parity for unknown absent stale and relations', () => {
  for (const status of ['unknown','absent','known','stale','unavailable']) {
    const session = { id:'s',sourceMetadata:{codexProject:{ref,name:'同名',source:'fixture',status,observedAt:2}},cwd:'/work',host:{local:true,id:'local'} };
    const wire = compactSourceView(sessionSourceView(session));
    assert.deepEqual(plain(ui().expandUiSourceView(wire)),expandSourceView(wire));
  }
  const wire = compactCapabilities(capabilitiesFor({}));
  assert.deepEqual(plain(ui().expandUiCapabilities(wire)),expandCapabilities(wire));
  assert.match(ui().sourceObservationText(ui().expandUiSourceView({compact:true}).attributes.codexProject),/未取得/);
  assert.match(ui().sourceObservationText({status:'known',value:[],observedAt:null}),/取得時刻不明/);
});
test('native source lanes keep a multi-source task once without inventing a representative', () => {
  const card = {kind:'task',sourceContext:[{ref}],sourceRelations:[{ref:{...ref,nativeId:'q'}}]};
  assert.equal(ui().sourceLane(card,'codexProject').id,'__multiple');
  assert.equal(ui().sourceLane(card,'codexProject').name,'複数');
});
test('environment selection never silently reduces a preset to cwd', async () => {
  await assert.rejects(prepareLaunchSelection({agent:'claude',environmentId:'e',route:'desktop'}, {claude:{environments:[{id:'e',cwd:'/work'}]}}),/完全適用/);
});
test('launch rechecks scope and cloud identity without selecting by name', async () => {
  const targets = {codex:{sourceObservation:{status:'known'},projects:[{id:'p',root:'/work',hostId:'local',sourceRef:ref}],cloudEnvironments:[{id:'cloud'}]}};
  await assert.rejects(prepareLaunchSelection({agent:'codex',projectId:'p',sourceRef:{...ref,scopeId:'/other'},route:'desktop'},targets),/scope/);
  await assert.rejects(prepareLaunchSelection({agent:'codex',runOn:'cloud',cloudEnvironment:'missing'},targets),/環境/);
  const selection = await prepareLaunchSelection({agent:'codex',projectId:'p',sourceRef:ref,route:'desktop'},targets);
  assert.deepEqual(selection.selectedRefs,[ref]);
  const folder = await prepareLaunchSelection({agent:'claude',cwd:'/work',route:'desktop'},targets);
  assert.deepEqual(folder.selectedRefs,[]);
});

test('explicit folder request strips preset refs and unapplied settings before the launcher', async () => {
  const model = new vm.Script(fs.readFileSync(new URL('../ui/task-quick-add-model.js',import.meta.url),'utf8')+'\n({sessionStartRequest})').runInNewContext();
  const request = plain(model.sessionStartRequest({agent:'claude',route:'desktop',environmentId:'__folder',sourceRef:ref,hostId:'local',cwd:'/work',prompt:'確認',folderSettings:{branch:'hidden'},environmentVariables:{SECRET:'never-copy'}}));
  assert.equal(request.environmentId,undefined);
  assert.equal(request.sourceRef,undefined);
  assert.equal(request.folderSettings,undefined);
  assert.equal(request.environmentVariables,undefined);
  const calls = [];
  const fakeAdapter = async payload => { calls.push(payload); return {opened:true}; };
  const selection = await prepareLaunchSelection(request,{});
  await fakeAdapter(selection);
  assert.deepEqual(calls[0].selectedRefs,[]);
  assert.equal(calls[0].cwd,'/work');
});

test('a heuristic pending link does not confirm a receipt or create startedWith', async () => {
  const {Store} = await import('../server/store.mjs');
  const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'canban-receipt-'));
  try {
    const store = new Store(dir); const task = await store.createTask({title:'test'});
    const receipt = {requestId:'r',sessionId:null,status:'unresolved',selectedRefs:[ref],appliedRefs:[]};
    await store.recordLaunch({taskId:task.cardId,selection:{mode:'preset',selectedRefs:[ref]},receipt});
    await store.addPending({taskId:task.cardId,pending:{startedAt:1}});
    await store.resolvePending([{taskId:task.cardId,sessionId:'codex:s',startedAt:1}]);
    const saved=(await store.load()).cards[task.cardId];
    assert.deepEqual(saved.launchReceipts,[receipt]);
    assert.deepEqual(sessionSourceView({id:'codex:s'}, {},saved.launchReceipts).relations,[]);
    store.close?.();
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('stale or unavailable catalog ownership blocks saved-settings starts', async () => {
  await assert.rejects(prepareLaunchSelection({agent:'codex',projectId:'p',route:'desktop'}, {codex:{sourceObservation:{status:'stale'},projects:[{id:'p',root:'/work',hostId:'local',sourceRef:ref}]}}),/最新/);
});


test('source labels keep paths in details and show only applicable provider defaults', () => {
  const facet = {ref,name:'同名',origins:['observed']};
  assert.equal(ui().sourceFacetLabel(facet), 'Codexのプロジェクト: 同名');
  assert.equal(ui().sourceFacetHint(facet).includes('/fixture'), false);
  const rows = plain(ui().sourceDetailRows({agent:'codex',sourceView:{compact:true}}));
  assert.deepEqual(rows.map(row=>row[0]),['Codexのプロジェクト','Codexのセクション','作業場所']);
  assert.match(rows[0][1],/未取得/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../ui/task-dashboard-model.js', import.meta.url), 'utf8');
const model = vm.runInNewContext(`${source}\n({taskPanePreferences, taskVisiblePanes, taskRequestText});`);
const plain = v => JSON.parse(JSON.stringify(v));

test('a task gets its parent and linked sessions; new links appear, explicit removals disappear, unavailable links stay', () => {
  const prefs = model.taskPanePreferences('task:a', ['codex:a', 'codex:unavailable'], [{id:'codex:removed'}, {id:'codex:a', hidden:true}]);
  assert.deepEqual(plain(prefs.map(p=>p.id)), ['codex:a','task:a','codex:unavailable']);
  assert.equal(prefs[0].hidden, true);
  assert.equal(prefs[2].hidden, false);
  const view = model.taskVisiblePanes('task:a',['codex:a','codex:unavailable'],prefs,'A','codex:removed');
  assert.deepEqual(plain(view.ids), ['task:a','codex:unavailable']);
});
test('all related sessions remain accessible across pages without exceeding live pane capacity', () => {
  const ids=Array.from({length:19},(_,i)=>`codex:${i}`), prefs=model.taskPanePreferences('task:a',ids);
  const visited=new Set();
  for(let page=0;page<3;page++) {
    const view=model.taskVisiblePanes('task:a',ids,prefs,'C',null,page,8);
    assert.ok(view.ids.length<=8);assert.equal(view.ids[0],'task:a'); assert.equal(view.pages,3);
    for(const id of view.ids.slice(1))visited.add(id);
  }
  assert.deepEqual([...visited],ids);
  assert.equal(model.taskVisiblePanes('task:a',ids,prefs,'C',ids[0],1).active,ids[7]);
});
test('closed panels stay closed across restoration but membership and the parent remain', () => {
  const prefs=model.taskPanePreferences('task:a',['codex:a','codex:b'],[{id:'task:a',hidden:true},{id:'codex:a',hidden:true}]);
  assert.equal(prefs.find(p=>p.id==='task:a').hidden,false);
  assert.deepEqual(plain(model.taskVisiblePanes('task:a',['codex:a','codex:b'],prefs,'C','codex:a').ids),['task:a','codex:b']);
  assert.equal(prefs.length,3);
});
test('reordering a visible page preserves hidden/off-page panels and their positions', () => {
  const prefs=[{id:'task:a'},{id:'codex:a',size:'S',free:{x:80,y:90}},{id:'codex:b',hidden:true},{id:'codex:c'},{id:'codex:d'}];
  const updated=model.taskPanePreferences('task:a',['codex:a','codex:b','codex:c','codex:d'],prefs,[{id:'task:a'},{id:'codex:c'},{id:'codex:a',size:'L'}]);
  assert.deepEqual(plain(updated.map(p=>p.id)),['task:a','codex:c','codex:b','codex:a','codex:d']);
  assert.equal(updated[2].hidden,true);assert.equal(updated[3].size,'L');
});
test('request composition includes the editable task title, description and memo without sending',()=>{
  assert.equal(model.taskRequestText('  依頼  ','目的','完了条件'),'依頼\n\n目的\n\n完了条件');
});

function harness() {
  const panes = [], settings = { space:'fixed',arrange:'row',mode:'text',size:'M' }, writes = [], records = new Map();
  const make = id => ({id,el:{draft:'',remove(){},classList:{add(){}},style:{}},space:null,mode:null,size:null,note:false,free:null});
  const general = make('codex:general'); general.el.draft='一般画面の下書き'; panes.push(general);
  const defaults = {main:['conv'],side:['send'],collapsed:[]};
  const context = vm.createContext({panes,paneGlobal:settings,paneLayout:{...defaults,ratio:.6,heights:{conv:200}},
    eff:(p,key)=>p[key]||settings[key],nextFree:()=>({x:40,y:30}),PANE_LAYOUT_DEF:defaults,PANE_HEIGHTS:{conv:200},PANE_MAX:8,structuredClone,clearTimeout,setTimeout,clearInterval,
    workspace:{hasDrafts:el=>!!el.draft,navigate(){}},store:{set:(key,value)=>writes.push([key,plain(value)])},
    $:()=>null,live:{feeds:new Map()},paneCanvas:{append(){}},paneLayer:{dataset:{}},
    normalizePaneLayout:(value)=>structuredClone(value||defaults),sharedUiRecord:r=>r,
    bridge:{callTool:async(name,args)=>{
      const record=records.get(args.taskId);if(!record)throw new Error('取得失敗');
      if(name==='canban_get_task_dashboard')return structuredClone(record);
      if(args.expectedRevision!==record.revision)return {...structuredClone(record),conflict:true,saved:false};
      record.revision++;record.state=structuredClone(args.state);return {...structuredClone(record),saved:true};
    }},
    openTaskModal:async(id,pref)=>{if(!panes.some(p=>p.id===id))panes.push(Object.assign(make(id),pref));},openCard:async(id,pref)=>{if(!panes.some(p=>p.id===id))panes.push(Object.assign(make(id),pref));},
    setDash(){},savePanes(){writes.push(['panes',panes.map(p=>p.id)]);},
    watchRequests(){},refreshDispatch(){},applyPaneLayoutTo(){},refreshPane(){},paintPaneBar(){},layoutPanes(){},kickLive(){},toast(){},
  });
  const ctrl=vm.runInContext(`let taskDash=null;\n${source}\n${fs.readFileSync(new URL('../ui/task-dashboard.js',import.meta.url),'utf8')}\ntaskDash;`,context);
  ctrl.paint=()=>{};ctrl.paintStatus=()=>{};ctrl.paintRelated=()=>{};
  for(const [id,link] of [['task:a','codex:a'],['task:b','codex:b']])records.set(id,{revision:0,links:[link],sessions:[],state:null});
  return {ctrl,panes,general,writes,records,context};
}
test('task switching preserves detached draft DOM and keeps general pane settings independent',async()=>{
  const {ctrl,panes,general,writes,context}=harness();
  await ctrl.open('task:a');
  const a=panes.find(p=>p.id==='codex:a');a.el.draft='Aの追加依頼';
  await ctrl.preset('B');
  await ctrl.open('task:b');
  assert.equal(ctrl.active.state.preset,'A');
  await ctrl.open('task:a');
  assert.equal(ctrl.active.state.preset,'B');assert.equal(panes.find(p=>p.id==='codex:a'),a);assert.equal(a.el.draft,'Aの追加依頼');
  assert.equal(ctrl.hasDrafts(),true);
  await ctrl.leave();
  assert.equal(panes[0],general);assert.equal(panes[0].el.draft,'一般画面の下書き');assert.equal(context.paneGlobal.mode,'text');
  assert.deepEqual(writes.filter(([key])=>key==='panes'),[['panes',['codex:general']]]);
});
test('failed reads preserve current workspace; stale save blocks overwriting while retaining drafts on reload',async()=>{
  const {ctrl,panes,records}=harness();await ctrl.open('task:a');
  const a=panes.find(p=>p.id==='codex:a');a.el.draft='競合しても保持';
  await assert.rejects(ctrl.open('task:missing'),/取得失敗/);
  assert.equal(ctrl.active.id,'task:a');assert.equal(panes.find(p=>p.id==='codex:a'),a);
  await ctrl.flush();
  const record=records.get('task:a');record.revision++;record.state.preset='C';
  await ctrl.preset('B');await ctrl.flush();
  assert.equal(ctrl.active.blocked,true);assert.equal(record.state.preset,'C');
  await ctrl.reload();
  assert.equal(ctrl.active.blocked,false);assert.equal(ctrl.active.state.preset,'C');assert.equal(panes.find(p=>p.id==='codex:a').el.draft,'競合しても保持');
  await ctrl.leave();
});

test('pane refresh leaves the task workspace pointer intact; generic panes still clear legacy task overlays',()=>{
  const html=fs.readFileSync(new URL('../ui/board.html',import.meta.url),'utf8');
  const src=html.slice(html.indexOf('function closeTaskOverlay()'),html.indexOf('function closeModal()'));
  const writes=[],workspace={activeTask:'task:a',pendingTask:null},context=vm.createContext({workspace,taskDash:{active:{id:'task:a'}},state:{modalOpen:true},document:{querySelectorAll:()=>[]},store:{set:(...args)=>writes.push(args)}});
  vm.runInContext(`${src}\ncloseTaskOverlay();`,context);
  assert.equal(workspace.activeTask,'task:a');assert.equal(writes.length,0);
  context.taskDash=null;vm.runInContext('closeTaskOverlay();',context);
  assert.equal(workspace.activeTask,null);assert.equal(writes.length,1);
});

test('a fresh session read rebuilds the feed without erasing prompt or memo drafts',()=>{
  const html=fs.readFileSync(new URL('../ui/board.html',import.meta.url),'utf8');
  const source=html.slice(html.indexOf('function renderPaneKeepingDrafts('),html.indexOf('function renderPane(p, d)'));
  const field=(label,value,baseline,kind)=>({value,defaultValue:baseline,getAttribute:()=>label,matches:s=>s===kind});
  let fields=[field('送るプロンプト','追加依頼の下書き','','.send-box textarea'),field('メモ','編集中のメモ','保存済み','textarea.note')],renders=0;
  const el={querySelector:()=>null,querySelectorAll:()=>fields};
  const context=vm.createContext({workspace:{draftValues:new WeakMap()},renderPane:()=>{renders++;fields=[field('送るプロンプト','','','.send-box textarea'),field('メモ','最新のメモ','最新のメモ','textarea.note')];}});
  context.p={el};vm.runInContext(`${source}\nrenderPaneKeepingDrafts(p,{feed:{offset:0}});`,context);
  assert.equal(renders,1);assert.equal(fields[0].value,'追加依頼の下書き');assert.equal(fields[1].value,'編集中のメモ');assert.equal(fields[1].defaultValue,'最新のメモ');
});

test('bulk note changes retain the selected preset; explicit space changes switch to custom layout',()=>{
  const html=fs.readFileSync(new URL('../ui/board.html',import.meta.url),'utf8');
  const src=html.slice(html.indexOf('function bulk(fn)'),html.indexOf('const pseg ='));
  let custom=0;const panes=[{space:null,note:false},{space:null,note:false}];
  const context=vm.createContext({panes,eff:(p,key)=>p[key]||'fixed',taskDash:{custom:()=>custom++},liftIfNeeded(){},refreshPane(){},layoutPanes(){},savePanes(){},paintPaneBar(){}});
  vm.runInContext(`${src}\nbulk(p=>{p.note=true;});`,context);assert.equal(custom,0);assert.ok(panes.every(p=>p.note));
  vm.runInContext(`bulk(p=>{p.space='free';});`,context);assert.equal(custom,1);
});

test('parent metadata follows linked session status without rebuilding draft inputs',async()=>{
  const {ctrl,panes}=harness();await ctrl.open('task:a');
  const parent=panes.find(p=>p.id==='task:a');parent.el.draft='目的の編集中';
  ctrl.reconcile({lists:[{cards:[{id:'task:a',title:'調査',status:'waiting',links:[{id:'codex:a',status:'waiting'}],linkedSessionIds:['codex:a']}]}]});
  assert.equal(parent.status,'waiting');assert.equal(parent.taskCard.title,'調査');assert.equal(parent.el.draft,'目的の編集中');
  await ctrl.leave();
});

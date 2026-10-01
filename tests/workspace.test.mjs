import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { boardHtml } from '../server/ui.mjs';

const source = fs.readFileSync(new URL('../ui/workspace-model.js', import.meta.url), 'utf8');
const model = new vm.Script(source + '\n({workspacePage, usageWindow, paneGeometry, normalizePaneLayout, paneBatch})').runInNewContext();
const plain = value => JSON.parse(JSON.stringify(value));

test('workspace routes preserve old home and analytics fallbacks', () => {
  assert.equal(model.workspacePage('usage'), 'usage');
  assert.equal(model.workspacePage('unknown', 'analytics'), 'analytics');
  assert.equal(model.workspacePage(null), 'home');
});
test('a single fixed card fills the available height with twelve-pixel margins', () => {
  const p = model.paneGeometry([{index:0,w:900,h:450,note:false}], 'grid', 1300, 850);
  assert.deepEqual(plain(p.rects), [{index:0,x:200,y:12,h:826}]);
  assert.equal(p.height,850);
});
test('two columns share the full height while notes stay compact', () => {
  const p = model.paneGeometry([{index:0,w:560,h:450,note:false},{index:1,w:560,h:100,note:true}], 'grid', 1300, 850);
  assert.equal(p.rects[0].h,826); assert.equal(p.rects[1].h,100);
});
test('grid rows distribute height and scroll if minimum readable height cannot fit', () => {
  const items = [0,1].map(index => ({index,w:900,h:450,note:false}));
  const fit = model.paneGeometry(items,'grid',1000,850);
  assert.equal(fit.rects[0].h,407); assert.equal(fit.rects[1].h,407);
  assert.equal(fit.height,850);
  const scroll = model.paneGeometry(items,'grid',1000,500);
  assert.ok(scroll.height>500); assert.ok(scroll.rects.every(r=>r.h===320));
});
test('column layout gives each card viewport height and row layout can scroll horizontally', () => {
  const items=[0,1].map(index=>({index,w:700,h:500,note:false}));
  const col=model.paneGeometry(items,'col',1000,600);
  assert.equal(col.rects[0].h,576); assert.equal(col.rects[1].h,576); assert.ok(col.height>600);
  const row=model.paneGeometry(items,'row',1000,600); assert.ok(row.width>1000);
});
test('tiny containers never create negative card geometry', () => {
  const p=model.paneGeometry([{index:0,w:20,h:10,note:false}],'grid',10,10);
  assert.ok(p.rects[0].h>=0);
});
test('usage separates used and remaining amounts and names the limit window', () => {
  const now=1790760000000;
  const value=model.usageWindow({usedPercent:55,windowMinutes:10080,resetsAt:now+86400000},now,now);
  assert.deepEqual(plain(value),{label:'週間枠',used:55,remaining:45,stale:false,resetsAt:now+86400000});
});
test('expired and stale snapshots do not become zero or full allowance', () => {
  const now=1790760000000;
  for (const [window,at] of [
    [{usedPercent:0,stale:true,windowMinutes:300},now],
    [{usedPercent:55,windowMinutes:300,resetsAt:now-1},now],
    [{usedPercent:55,windowMinutes:300},now-900001],
    [{usedPercent:55,windowMinutes:300},null],
  ]) {
    const v=model.usageWindow(window,at,now);assert.equal(v.stale,true);assert.equal(v.remaining,null);assert.equal(v.used,null);
  }
});
test('missing and invalid usage stays unknown', () => {
  assert.equal(model.usageWindow(null,Date.now()),null);
  assert.equal(model.usageWindow({usedPercent:101},Date.now()),null);
  assert.equal(model.usageWindow({usedPercent:'55'},Date.now()),null);
});
test('MCP UI includes feature modules and still compiles as one self-contained script', () => {
  const html=boardHtml({version:'0.14.1'});
  assert.doesNotMatch(html,/@include/);
  assert.match(html,/const workspace =/);
  assert.match(html,/Canbanの画面/);
  assert.equal([...html.matchAll(/<script>/g)].length,1);
  assert.equal([...html.matchAll(/<style>/g)].length,1);
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
});

test('restoring analytics migrates a legacy project scope before requesting category statistics', async () => {
  const html = boardHtml();
  const loading = html.slice(html.indexOf('let loadSeq = 0;'), html.indexOf('function saveFilters()'));
  const analytics = html.slice(html.indexOf('async function loadAnalytics('), html.indexOf('function svgEl('));
  const calls = []; let saved = 0, rendered = 0;
  const state = { view: 'analytics', board: null, filters: { project: 'Old Project', folder: '/old', swimlane: 'project', directory: '', agent: 'codex', host: 'local', account: 'a1' } };
  const context = vm.createContext({ state, saveFilters: () => saved++, renderAnalytics: () => rendered++,
    store: { values: new Map(), get(key, fallback) { return this.values.get(key) ?? fallback; }, set(key, value) { this.values.set(key, value); } },
    bridge: { callTool: async (name, args) => {
      calls.push([name, plain(args)]);
      return name === 'canban_get_board' ? { directories: [{ id: 'd1', name: 'Old Project' }] } : {};
    } },
  });
  await vm.runInContext(`${loading}\n${analytics}\nload();`, context);
  assert.deepEqual(calls.map(([name]) => name), ['canban_get_board', 'canban_get_stats']);
  assert.deepEqual(calls[1][1], { days: 30, agent: 'codex', host: 'local', account: 'a1', directory: 'd1' });
  assert.equal(state.filters.project, ''); assert.equal(state.filters.folder, '');
  assert.equal(state.filters.swimlane, 'directory'); assert.equal(saved, 1); assert.equal(rendered, 1);
  Object.assign(state.filters, { project: 'New Project', folder: 'new-folder', swimlane: 'project', label: 'l1' });
  await vm.runInContext('load();', context);
  assert.equal(state.filters.project, 'New Project');
  assert.equal(state.filters.folder, 'new-folder');
  assert.equal(state.filters.swimlane, 'project');
  assert.equal(calls.at(-1)[1].project, 'New Project');
  assert.equal(calls.at(-1)[1].label, 'l1');
});

test('explicit shared-state reload keeps edited forms and open panes', async () => {
  const html = boardHtml();
  const source = html.slice(html.indexOf('async function applySharedUi('), html.indexOf('async function reloadSharedUi('));
  let closed = 0, adopted = 0, warned = 0;
  const context = vm.createContext({
    hasUnsavedPaneInput: () => true, toast: () => warned++,
    panes: [{ id: 'codex:test' }], closePane: () => closed++,
    adoptSharedUi: () => adopted++, sharedUi: {},
  });
  await vm.runInContext(`${source}\napplySharedUi({state:{view:'board'}});`, context);
  assert.equal(closed,0); assert.equal(adopted,0); assert.equal(warned,1);
});

test('account rings show unknown when the recorded window has expired', () => {
  const src = fs.readFileSync(new URL('../ui/accounts.js', import.meta.url), 'utf8');
  const ring = src.slice(src.indexOf('function ringFor('), src.indexOf('function renderUsage('));
  const now = Date.now();
  const context = vm.createContext({
    usageWindows: l => [l.primary,l.secondary].filter(Boolean), usageWindow: model.usageWindow,
    usageTitle: () => '要更新', heat: () => 'green', colorVar: () => 'blue',
    h: (tag, attrs, ...children) => ({tag,attrs,children}),
  });
  const result = vm.runInContext(`${ring}\nringFor({agent:'claude',label:'確認',short:'確',color:'blue',limits:{at:${now},primary:{usedPercent:90,windowMinutes:300,resetsAt:${now-1}}}});`,context);
  assert.match(result.attrs.class,/no-a/);
  assert.match(result.attrs.class,/stale/);
});

test('account editors register dynamic draft fields and keep them after save failure', async () => {
  const src = fs.readFileSync(new URL('../ui/accounts.js', import.meta.url), 'utf8');
  const menu = src.slice(src.indexOf('function accountsMenu('), src.indexOf("$('#accountsBtn').addEventListener"));
  let mounts=0,body,tracked;
  const nodes=[];
  const h=(tag,attrs={},...children)=>{
    const node={tag,attrs,children:children.flat().filter(v=>v!=null),value:attrs.value||'',dataset:{},focus(){},
      append(...values){this.children.push(...values);}, replaceChildren(...values){this.children=values;},
      querySelectorAll(){return[];}};nodes.push(node);return node;
  };
  const account={key:'claude:mock',label:'確認',agent:'claude',short:'確',color:'blue',signedIn:[],count:1};
  const context=vm.createContext({h,state:{filters:{},board:{accounts:{accounts:[account],colors:['blue'],unknown:{codex:0,claude:0},homes:[],discover:false}}},
    workspace:{trackDrafts:root=>{tracked=root;}},ringFor:()=>h('span'),usageTitle:()=>'',usageWindows:()=>[],colorVar:()=>'',COLOR_NAMES:{},
    popover:(_anchor,_title,content)=>{mounts++;body=content;},act:async()=>{throw new Error('db_busy');}});
  vm.runInContext(`${menu}\naccountsMenu({});`,context);
  nodes.find(n=>n.attrs['aria-label']==='確認 の名前・頭文字・色を変更').attrs.onclick();
  assert.ok(tracked); assert.equal(mounts,1);
  nodes.find(n=>n.attrs['aria-label']==='表示名').value='途中の名前';
  await nodes.find(n=>n.attrs.text==='保存').attrs.onclick();
  assert.equal(mounts,1);assert.equal(nodes.find(n=>n.attrs['aria-label']==='表示名').value,'途中の名前');
});

function workspaceHarness(extra={}) {
  const src=fs.readFileSync(new URL('../ui/workspace.js',import.meta.url),'utf8').replace('workspace.init();','');
  return vm.runInNewContext(`${src}\nworkspace;`,{store:{get:(_key,fallback)=>fallback,set:()=>{}},workspacePage:model.workspacePage,state:{view:'board'},dashOpen:false,...extra});
}

test('shared layout restores cross-column moves, repairs duplicates and migrates old heights', () => {
  const defaults = { main: ['conv','send'], side: ['resume','memo'] };
  const result = plain(model.normalizePaneLayout({main:['resume','conv','conv','unknown'],side:['send'],ratio: .6,heights:{conv:180,memo:10000},collapsed:['conv','unknown','conv']},defaults,{conv:300,send:260,resume:290,memo:150}));
  assert.deepEqual(result.main,['resume','conv']);
  assert.deepEqual(result.side,['send','memo']);
  assert.equal(result.ratio,.6); assert.equal(result.heights.conv,180); assert.equal(result.heights.memo,900);
  assert.deepEqual(result.collapsed,['conv']);
  const old = model.normalizePaneLayout(defaults,defaults,{conv:300});
  assert.equal(old.ratio,2/3); assert.equal(old.heights.conv,300);
});
test('a batch mixes task/session cards, deduplicates open cards and rejects an oversized batch atomically', () => {
  assert.deepEqual(plain(model.paneBatch(['task:1','codex:1','task:1'],['codex:1'],8)),{ids:['task:1','codex:1'],additions:['task:1'],fits:true});
  const rejected = model.paneBatch(['task:1','claude:2'],['codex:1'],2);
  assert.equal(rejected.fits,false); assert.equal(rejected.additions.length,2);
});
test('restoring a session retains its pane on a transient read failure and removes a genuinely missing session', async () => {
  const html = boardHtml();
  const source = html.slice(html.indexOf('async function openCard('), html.indexOf('function updateNoteLine('));
  const panes = []; let error = new Error('db_busy'), closed = 0;
  const context = vm.createContext({ panes, PANE_MAX: 8, taskDash: null, batchOpening: false, state: {board:{lists:[]}},
    closePopover: () => {}, bridge: {callTool: async () => {throw error;}},
    newPane: id => {const p={id,el:{replaceChildren(...nodes){this.nodes=nodes;}}};panes.push(p);return p;},
    closePane: () => {closed++;panes.splice(0);}, h: (tag,attrs) => ({tag,attrs}), toast: () => {},
  });
  await vm.runInContext(`${source}\nopenCard('codex:mock',{});`,context);
  assert.equal(panes.length,1); assert.equal(closed,0);
  assert.ok(panes[0].el.nodes.some(n => n.attrs.text === '再読み込み'));
  panes.splice(0); error = new Error('セッションが見つかりません: codex:mock');
  await vm.runInContext(`openCard('codex:mock',{});`,context);
  assert.equal(panes.length,0); assert.equal(closed,1);
});
test('restoration saves surviving session/task panes after a missing card without transiently leaving the dashboard', async () => {
  const html = boardHtml();
  const source = html.slice(html.indexOf('async function restorePanes('), html.indexOf('function sharedUiSnapshot('));
  const panes = []; let remembered, folded = 0;
  const context = vm.createContext({ store: {get:()=>[{id:'codex:gone'},{id:'task:survives'}]}, panes, restoringPanes:false,
    PANE_MAX:8, PANE_SPACES:[], PANE_MODES:[], PANE_SIZES:[], oneOf:(_v,_list,fallback)=>fallback,
    openCard:async id=>{assert.equal(context.restoringPanes,true);if(id==='task:survives')panes.push({id});},
    savePanes:()=>{remembered=panes.map(p=>p.id);}, workspace:{page:'cards'}, setDash:()=>{folded++;},
  });
  await vm.runInContext(`${source}\nrestorePanes();`,context);
  assert.deepEqual(remembered,['task:survives']); assert.equal(folded,0); assert.equal(context.restoringPanes,false);
});
test('task autosave advances only the submitted draft baseline', async()=>{
  const w=workspaceHarness(), input={value:'保存する値',defaultValue:''};
  let release;
  const saving=w.saveField(input,()=>new Promise(resolve=>{release=resolve;}));
  input.value='保存待ち中に追加した入力';release();await saving;
  assert.equal(w.draftValues.get(input),'保存する値');assert.equal(input.defaultValue,'保存する値');
  assert.notEqual(input.value,w.draftValues.get(input));
  await w.saveField(input,async()=>{throw new Error('db_busy');});
  assert.equal(w.draftValues.get(input),'保存する値');
});
test('legacy task modals migrate to panes independently of home filters', async () => {
  let opened = 0, saved = 0;
  const w = workspaceHarness({ taskDash: { open: async (_id, opts) => { assert.equal(opts.reveal, false); opened++; } }, savePanes: () => { saved++; } });
  w.pendingTask = 'task:mock'; w.page = 'home';
  await w.restoreTask();
  assert.equal(w.pendingTask, null); assert.equal(opened, 1); assert.equal(saved, 1); assert.equal(w.page, 'home');
  await w.restoreTask(); assert.equal(opened, 1);
});

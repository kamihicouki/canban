import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const modelPath = new URL('../ui/gantt-model.js', import.meta.url);
function model() { return vm.runInNewContext(fs.readFileSync(modelPath, 'utf8') + '\n({ganttItems,ganttObservation,ganttRange,ganttBar,ganttDeadline});'); }
const now = new Date(2026, 10, 14, 12).getTime();
const day = 86400000, ago = n => now - n * day;

test('task links are summaries; children appear once and retain known full-card observation times', () => {
 const m=model(), child={id:'claude:a',title:'child',createdAt:ago(8),updatedAt:ago(2),status:'completed'};
 const b={lists:[{cards:[{id:'task:a',kind:'task',links:[{id:child.id,title:'child',updatedAt:ago(2)}]},child,{id:'codex:b'}]}]};
 const rows=m.ganttItems(b);
 assert.deepEqual(Array.from(rows,x=>x.card.id),['task:a','claude:a','codex:b']);
 assert.equal(rows[1].card.createdAt,ago(8));assert.equal(rows[1].parentId,'task:a');
});
test('completed intervals end at their observed update; only known active sessions extend to now', () => {
 const m=model(),range=m.ganttRange([],30,now);
 const done=m.ganttBar({createdAt:ago(8),updatedAt:ago(3),status:'completed'},range,now);
 assert.equal(done.end,ago(3));assert.equal(done.start,ago(8));assert.ok(done.width>0);
 assert.equal(m.ganttBar({createdAt:ago(8),updatedAt:ago(3),status:'running'},range,now).end,now);
 assert.equal(m.ganttBar({createdAt:ago(8),updatedAt:ago(3),status:'running',statusKnown:false},range,now).end,ago(3));
 assert.equal(m.ganttBar({createdAt:now+day,updatedAt:now+day},range,now),null);
});
test('missing or invalid start is a point and missing update does not invent an interval', () => {
 const m=model(),range=m.ganttRange([],7,now);
 const dot=m.ganttBar({updatedAt:ago(1),status:'completed'},range,now);
 assert.equal(dot.point,true);assert.equal(dot.startKnown,false);assert.equal(dot.width,0);
 assert.equal(m.ganttBar({createdAt:ago(2)},range,now),null);
 const invalid=m.ganttBar({createdAt:now+day,updatedAt:ago(1)},range,now);
 assert.equal(invalid.point,true);assert.equal(invalid.startKnown,false);
});
test('sub-day observations stay points without fabricating a minimum duration', () => {
 const m=model(),range=m.ganttRange([],30,now);
 const bar=m.ganttBar({createdAt:now-3600000,updatedAt:now-1000,status:'running'},range,now);
 assert.equal(bar.point,true);assert.equal(bar.width,0);assert.equal(bar.end,now);
 assert.equal(bar.left,(now-range.start)/(range.end-range.start)*100);
});

test('tasks bracket only their observed children and empty tasks have no invented bar', () => {
 const m=model(),range=m.ganttRange([],30,now);
 const task={kind:'task',createdAt:ago(20),updatedAt:now,links:[{createdAt:ago(10),updatedAt:ago(8),status:'completed'},{createdAt:ago(6),updatedAt:ago(3),status:'completed'}]};
 const bar=m.ganttBar(task,range,now);assert.equal(bar.start,ago(10));assert.equal(bar.end,ago(3));
 assert.equal(m.ganttBar({...task,links:[]},range,now),null);
});
test('shared periods clip old intervals and all-period includes older creation dates', () => {
 const m=model(),card={createdAt:ago(180),updatedAt:ago(1),status:'completed'};
 const week=m.ganttRange([card],7,now);assert.equal(week.days,7);
 const all=m.ganttRange([card],0,now);assert.ok(all.start<=card.createdAt);
 const bar=m.ganttBar(card,week,now);assert.equal(bar.left,0);assert.equal(bar.clippedStart,true);
 assert.ok(bar.width<=100);assert.equal(m.ganttBar({createdAt:ago(180),updatedAt:ago(100)},week,now),null);
});
test('deadlines come only from explicit due dates; invalid and out-of-range deadlines have no fake position', () => {
 const m=model(),range=m.ganttRange([],7,now);
 assert.equal(m.ganttDeadline({},range,now),null);
 assert.equal(m.ganttDeadline({due:'not a date'},range,now),null);
 const deadline=m.ganttDeadline({due:ago(2)},range,now);assert.equal(deadline.overdue,true);assert.ok(deadline.position>=0&&deadline.position<=100);
 const future=m.ganttDeadline({due:now+10*day},range,now);assert.equal(future.position,null);assert.equal(future.overdue,false);
});
test('rendering contains no fabricated percentages, future intervals, utility classes, or claims of execution', () => {
 const s=fs.readFileSync(new URL('../ui/gantt.js',import.meta.url),'utf8');
 assert.doesNotMatch(s,/75%|80%|50%|status === 'done'|Math\.max\(96|タスクが進行中です|text-\[|bg-black|text-sky|font-bold/);
 assert.match(s,/帯は作成から最終更新までの範囲です。連続した活動や予定ではありません/);
});

function viewFixture(cards) {
  const state={board:{lists:[{id:'work',cards}]},filters:{days:30}}, document={activeElement:null};
  class Node {
    constructor(tag,attrs={},...children){this.tag=tag;this.attrs=attrs;this.dataset={};this.children=[];this.events={};this.scrollTop=0;Object.assign(this,attrs);
      for(const[k,v]of Object.entries(attrs))if(k.startsWith('data-'))this.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=v;
      this.classList={add:c=>{this.class=[...new Set((this.class||'').split(' ').concat(c))].join(' ');},toggle:(c,on)=>{this.class=(this.class||'').split(' ').filter(x=>x!==c).concat(on?[c]:[]).join(' ');}};
      this.append(...children);}
    append(...children){for(const c of children.flat().filter(Boolean)){this.children.push(c);if(c instanceof Node)c.parent=this;}}
    addEventListener(name,fn){this.events[name]=fn;}
    setAttribute(k,v){this.attrs[k]=v;}
    matches(selector){const cls=selector.match(/^\.([\w-]+)/);return cls?(this.class||'').split(' ').includes(cls[1]):this.tag===selector;}
    querySelectorAll(selector){return this.children.flatMap(c=>c instanceof Node?[...(c.matches(selector)?[c]:[]),...c.querySelectorAll(selector)]:[]);}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    focus(){document.activeElement=this;}scrollIntoView(){}
  }
  let root; const opened=[],resumed=[],bundled=[];
  const ctx={state,document,store:{get:()=>null},h:(...a)=>new Node(...a),queueMicrotask:()=>{},
    faceGlyph:()=>new Node('i'),faceWho:()=>new Node('span'),picon:()=>'',fmtDate:x=>String(x),relTime:x=>String(x),
    paneDocked:()=>false,panes:[],PANE_MODES:[['text','テキスト']],setPaneMode(){},
    openCard:(id,opts)=>opened.push({id,opts}),resume:id=>resumed.push(id),workBundlePicker:(_,id)=>bundled.push(id),
    $:selector=>root?.querySelector(selector.replace(/^#board /,'')),$$:selector=>root.querySelectorAll(selector.replace(/^#board /,'')),
  };
  const modelSource=fs.readFileSync(modelPath,'utf8'),lifetime=fs.readFileSync(new URL('../ui/lifetime-model.js',import.meta.url),'utf8');
  const api=vm.runInNewContext(lifetime+'\n'+modelSource+'\n'+fs.readFileSync(new URL('../ui/gantt.js',import.meta.url),'utf8')+'\n({renderGantt,ganttSelect,ganttStep,ganttExpand});',ctx);
  root=api.renderGantt(state.board);
  return{state,root,api,document,opened,resumed,bundled,rows:()=>root.querySelectorAll('.gantt-row')};
}
test('gantt rows support keyboard selection, expansion, continuation and bundling without handling edited or modified keys',()=>{
  const child={id:'claude:child',title:'child',status:'completed',createdAt:Date.now()-day,updatedAt:Date.now()};
  const f=viewFixture([{id:'task:parent',kind:'task',title:'parent',links:[child]},child]);
  assert.equal(f.rows().length,2);assert.equal(f.root.querySelector('.gantt-list').attrs.role,'listbox');
  f.api.ganttSelect('task:parent',{focus:true});
  function key(row,key,extra={}){let prevented=false;row.events.keydown({target:row,key,preventDefault(){prevented=true;},stopPropagation(){},...extra});return prevented;}
  assert.equal(key(f.rows()[0],'j'),true);assert.equal(f.state.gantt.sel,child.id);assert.equal(f.document.activeElement,f.rows()[1]);
  assert.equal(f.rows()[0].attrs.tabindex,'-1');assert.equal(f.rows()[1].attrs.tabindex,'0');
  assert.equal(key(f.rows()[1],'ArrowDown'),false,'at the boundary native scrolling stays available');
  key(f.rows()[1],'Enter');assert.equal(f.opened.at(-1).opts.dock,false);
  key(f.rows()[1],'o');key(f.rows()[1],'x');assert.deepEqual(f.resumed,[child.id]);assert.deepEqual(f.bundled,[child.id]);
  assert.equal(key(f.rows()[1],'o',{metaKey:true}),false);assert.equal(key(f.rows()[1],'o',{target:{}}),false);
  key(f.rows()[0],'o');assert.equal(f.resumed.length,1,'tasks have no continuation operation');
});
test('empty gantt is readable and 500 observed rows render without creating duplicate children',()=>{
  const empty=viewFixture([]);assert.equal(empty.root.querySelector('.gantt-empty').text,'表示するカードがありません');
  const children=Array.from({length:400},(_,i)=>({id:`codex:${i}`,title:`session ${i}`,createdAt:Date.now()-day,updatedAt:Date.now()-1000,status:'completed'}));
  const tasks=Array.from({length:100},(_,i)=>({id:`task:${i}`,kind:'task',title:`task ${i}`,links:children.slice(i*4,i*4+4)}));
  const start=performance.now(), f=viewFixture([...tasks,...children]);
  assert.equal(f.rows().length,500);assert.equal(new Set(f.rows().map(row=>row.dataset.cardId)).size,500);
  console.log(`gantt: 500 fictional rows constructed in ${(performance.now()-start).toFixed(2)}ms (VM DOM fixture, not browser paint)`);
});

test('the existing i action cycles board, timeline and gantt and persists the same shared key',()=>{
 const lifetime=fs.readFileSync(new URL('../ui/lifetime.js',import.meta.url),'utf8');
 const start=lifetime.slice(0,lifetime.indexOf('// ---- the view switch'));
 const saved=[], state={board:{},filters:{}},ctx={state,store:{get:(key,fallback)=>fallback,set:(...args)=>saved.push(args)},workspace:{utilityPage:()=>false},render(){},queueMicrotask:fn=>fn(),refreshShortcutHints(){}};
 const api=vm.runInNewContext(start+'\n({toggleBoardView,setBoardView});',ctx);
 for(const expected of ['timeline','gantt','board']){api.toggleBoardView();assert.equal(state.view,expected);assert.deepEqual(saved.at(-1),['boardView',expected]);}
 api.setBoardView('unknown-future-view');assert.equal(state.view,'board');
});

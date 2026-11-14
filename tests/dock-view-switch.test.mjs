import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read = name => fs.readFileSync(new URL(`../ui/${name}`,import.meta.url),'utf8');
const ganttSync=()=>read('gantt.js').slice(read('gantt.js').indexOf('function syncGanttDockedCard()'));
const timelineSync=()=>{const source=read('inbox.js');return source.slice(source.indexOf('function syncDockedCard()'),source.indexOf('// The row of the card on the layer'));};
function fixture(sel){
 const pane={id:'claude:current',draft:'保つ文章'},dock={hidden:true},view={selected:false,classList:{toggle(_,on){view.selected=on;}}};
 const rows=['codex:old','claude:current'].map(id=>({dataset:{cardId:id},attrs:{},setAttribute(k,v){this.attrs[k]=v;}}));
 const state={gantt:{sel},inbox:{sel},board:{lists:[]}},opened=[],marked=[];
 const ctx={state,panes:[pane],paneLayer:{hidden:false},paneDocked:()=>true,paneMetrics(){},ganttOn:()=>true,inboxOn:()=>true,
 $:s=>s.includes('gantt-view')?view:dock,ganttRows:()=>rows,openCard:(...v)=>opened.push(v),ganttItems:()=>[],findCard:()=>true,closeCards(){throw Error('must preserve pane');},
 markInboxSel:id=>{state.inbox.sel=id;marked.push(id);},};
 return {ctx,state,pane,dock,view,rows,opened,marked};
}
for(const old of ['codex:old',null])test(`gantt adopts the currently docked card when its previous selection is ${old}`,()=>{
 const f=fixture(old);vm.runInNewContext(ganttSync()+'\nsyncGanttDockedCard();',f.ctx);
 assert.equal(f.state.gantt.sel,f.pane.id);assert.equal(f.dock.hidden,false);assert.equal(f.view.selected,true);
 assert.equal(f.rows[1].attrs['aria-selected'],'true');assert.equal(f.rows[1].attrs.tabindex,'0');
 assert.equal(f.pane.draft,'保つ文章');assert.equal(f.opened.length,0,'reuse the pane without refetching or recreating it');
});
test('timeline symmetrically adopts the current pane and preserves its draft',()=>{
 const f=fixture('codex:old');f.ctx.ganttOn=()=>false;
 vm.runInNewContext(timelineSync()+'\nsyncDockedCard();',f.ctx);
 assert.equal(f.state.inbox.sel,f.pane.id);assert.deepEqual(f.marked,[f.pane.id]);assert.equal(f.pane.draft,'保つ文章');assert.equal(f.opened.length,0);
});

test('leaving the dock for board preserves the current nonfirst selection for the next view',()=>{
 const f=fixture('codex:old');f.ctx.ganttOn=()=>false;f.ctx.inboxOn=()=>false;
 f.ctx.closeCards=()=>{f.state.inbox.sel=null;f.state.gantt.sel=null;};
 vm.runInNewContext(timelineSync()+'\nsyncDockedCard();',f.ctx);
 assert.equal(f.state.inbox.sel,f.pane.id);assert.equal(f.state.gantt.sel,f.pane.id);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const sidebar=fs.readFileSync(new URL('../ui/sidebar.js',import.meta.url),'utf8');
const rendering=fs.readFileSync(new URL('../ui/board-render.js',import.meta.url),'utf8');
// Load just the real picker functions, without substituting their implementation.
function pickerHarness(board=null,boardError=null){
  const calls=[],notices=[];const context=vm.createContext({state:{board,boardError,filters:{agent:'all'}},T:{category:'カテゴリ',aiApps:'AI Apps'},AGENT_META:{},laneHides:()=>true,sourceRefKey:()=>'',workingFolderFacets:()=>[],picker:(_anchor,options)=>calls.push(options),toast:(text,error)=>notices.push({text,error})});
  const start=rendering.indexOf('function directoryItems('),end=rendering.indexOf('\n}',rendering.indexOf('function directoryPicker('))+2;
  vm.runInContext(rendering.slice(start,end)+'\n'+sidebar.slice(sidebar.indexOf('function scopePicker('),sidebar.indexOf('// Make a category')),context);
  return {context,calls,notices};
}
for(const error of [null,'Native disconnected'])test('scope picker does not dereference an unavailable board: '+(error?'failed':'pending'),()=>{
 const h=pickerHarness(null,error);assert.doesNotThrow(()=>vm.runInContext('scopePicker(null)',h.context));assert.equal(h.calls.length,0);assert.equal(h.notices.length,1);assert.match(h.notices[0].text,error?/再試行/:/読み込/);assert.equal(h.notices[0].error,!!error);
});
test('cached-card category picker cannot edit categories before board acquisition',()=>{const h=pickerHarness();assert.doesNotThrow(()=>vm.runInContext("directoryPicker(null,{id:'codex:fictional'})",h.context));assert.equal(h.calls.length,0);assert.equal(h.notices.length,1);});
test('an acquired empty board still opens the real scope picker',()=>{const h=pickerHarness({directories:[],labels:[],sourceFacets:[],totals:{}});vm.runInContext('scopePicker(null)',h.context);assert.equal(h.calls.length,1);assert.ok(h.calls[0].items.some(x=>x.label.includes('解除')));assert.equal(h.notices.length,0);});

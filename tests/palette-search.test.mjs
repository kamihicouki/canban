import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = () => fs.readFileSync(new URL('../ui/palette-search-model.js', import.meta.url), 'utf8');
const model = () => vm.runInNewContext(`${source()}\n({paletteBoardCards,paletteOutsideRows,createPaletteSearch,paletteCoverageWarning,createPaletteVisitHistory});`, { setTimeout, clearTimeout });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

test('outside results exclude loaded cards and their linked children and explain the observed scope', () => {
  const m=model(), now=Date.parse('2026-11-14T00:00:00Z');
  const cards=m.paletteBoardCards({lists:[{cards:[{id:'task:t',links:[{id:'claude:child',title:'child'}]},{id:'codex:inside'}]}]});
  assert.equal(cards.length,3);
  const rows=m.paletteOutsideRows([{cardId:'claude:child'},{cardId:'codex:inside'},
    {cardId:'codex:arch',archived:true,updatedAt:new Date(now-40*86400e3).toISOString()},
    {cardId:'claude:old',archived:false,updatedAt:new Date(now-31*86400e3).toISOString()},
    {cardId:'antigravity:other',updatedAt:new Date(now).toISOString()},
    {cardId:'unknown:time',updatedAt:'invalid'}],cards,{days:30,now});
  assert.deepEqual(Array.from(rows,r=>r.cardId),['codex:arch','claude:old','antigravity:other','unknown:time']);
  assert.equal(rows[0].outsideReason,'アーカイブ済み');
  assert.equal(rows[1].outsideReason,'30日より前');
  assert.equal(rows[2].outsideReason,'絞り込みの外');
  assert.equal(rows[3].outsideReason,'絞り込みの外');
});

function controller() {
  const m=model(), timers=new Map(), requests=[], changes=[];
  let next=0;
  const search=m.createPaletteSearch({delay:200,
    setTimer:(fn,ms)=>{assert.equal(ms,200);timers.set(++next,fn);return next;},clearTimer:id=>timers.delete(id),
    search:args=>new Promise((resolve,reject)=>requests.push({args,resolve,reject})),onChange:s=>changes.push(s)});
  const flush=()=>{for(const [id,fn]of timers){timers.delete(id);fn();}};
  return {search,timers,requests,changes,flush};
}

test('typing is debounced, always requests all periods and archives, and ignores stale successes',async()=>{
  const f=controller(); f.search.update('a'); assert.equal(f.timers.size,0);
  f.search.update('old');f.flush();assert.equal(f.requests.length,1);
  f.search.update('new');f.search.update('newer');assert.equal(f.timers.size,1);f.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests[1].args)),{q:'newer',days:0,includeArchived:true,includeSubagents:true,dotScope:'all',limit:20,fulltext:false});
  f.requests[1].resolve({results:[{cardId:'new'}],errors:[]});await tick();
  f.requests[0].resolve({results:[{cardId:'old'}]});await tick();
  assert.equal(f.search.state.rows[0].cardId,'new');assert.equal(f.search.state.error,null);
});

test('errors and source warnings are distinct from no results; old failures and closed palettes cannot repaint',async()=>{
  const f=controller();f.search.update('old');f.flush();f.search.update('current',{fulltext:true});f.flush();
  f.requests[1].resolve({results:[{cardId:'x'}],errors:['Claude 読取失敗'],searchCoverage:{fulltextDays:90}});await tick();
  assert.equal(f.search.state.warnings[0],'Claude 読取失敗');assert.equal(f.search.state.rows.length,1);
  f.requests[0].reject(new Error('old failure'));await tick();assert.equal(f.search.state.error,null);
  f.search.update('failure');f.flush();f.requests[2].reject(new Error('接続なし'));await tick();
  assert.equal(f.search.state.error,'接続なし');assert.equal(f.search.state.rows.length,0);
  f.search.update('closed');f.flush();f.search.dispose();const count=f.changes.length;
  f.requests[3].resolve({results:[{cardId:'late'}]});await tick();assert.equal(f.changes.length,count);
});

test('clearing a query immediately removes previous outside results and cancels outstanding debounce',async()=>{
  const f=controller();f.search.update('found');f.flush();f.requests[0].resolve({results:[{cardId:'x'}]});await tick();
  f.search.update('next');f.search.update('');assert.equal(f.timers.size,0);assert.equal(f.search.state.rows.length,0);assert.equal(f.search.state.loading,false);
});


test('malformed server packets are failures rather than empty healthy results',async()=>{
  const f=controller();f.search.update('query');f.flush();f.requests[0].resolve({results:null});await tick();
  assert.match(f.search.state.error,/形式/);assert.equal(f.search.state.loading,false);
});


test('body coverage identifies unknown freshness and unfinished indexing without declaring it complete',()=>{
  const {paletteCoverageWarning}=model();
  assert.equal(paletteCoverageWarning({fulltextApplied:false}),'');
  assert.match(paletteCoverageWarning({fulltextApplied:true,index:{indexed:0,total:0,updatedAt:null}}),/未取得/);
  assert.match(paletteCoverageWarning({fulltextApplied:true,index:{indexed:20,total:500,updatedAt:1}}),/20\/500/);
  assert.equal(paletteCoverageWarning({fulltextApplied:true,index:{indexed:500,total:500,updatedAt:1}}),'');
});


test('outside-card visit history is bounded, restores only one matching visit, and resets on unrelated navigation',()=>{
 const h=model().createPaletteVisitHistory({max:3});
 h.push({ids:['original']},'a');h.push({ids:['a']},'b');h.push({ids:['b']},'c');h.push({ids:['c']},'d');
 assert.equal(h.length,3);assert.equal(h.canReturn(['elsewhere']),false);
 assert.equal(h.take(['elsewhere']),null);assert.equal(h.take(['d']).origin.ids[0],'c');assert.equal(h.length,2);
 assert.equal(h.take(['c']).origin.ids[0],'b');
 h.push({ids:['unrelated']},'new');assert.equal(h.length,1);assert.equal(h.take(['new']).origin.ids[0],'unrelated');
 assert.equal(h.push({ids:['same']},'same'),false);assert.equal(h.length,0);
});

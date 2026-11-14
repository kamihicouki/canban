import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture(items){
 const document={activeElement:null};
 class Node{
  constructor(tag,attrs={},...children){this.tag=tag;this.attrs=attrs;this.value='';this.children=[];this.dataset={};this.events={};this.isConnected=true;Object.assign(this,attrs);this.classes=new Set((attrs.class||'').split(' ').filter(Boolean));this.classList={toggle:(c,on)=>on?this.classes.add(c):this.classes.delete(c)};for(const[k,v]of Object.entries(attrs))if(k.startsWith('data-'))this.dataset[k.slice(5)]=v;this.append(...children);}
  append(...children){for(const child of children.flat(Infinity).filter(x=>x!==null&&x!==undefined&&x!==false)){this.children.push(child);if(child instanceof Node)child.parent=this;}}
  replaceChildren(...children){this.children=[];this.append(...children);}
  addEventListener(name,fn){(this.events[name]||=[]).push(fn);}
  dispatchEvent(e){e.target=this;for(const fn of this.events[e.type]||[])fn(e);}
  matches(s){return s.startsWith('.')?s.slice(1).split('.').every(c=>this.classes.has(c)):this.tag===s;}
  querySelectorAll(s){return this.children.flatMap(n=>n instanceof Node?[...(n.matches(s)?[n]:[]),...n.querySelectorAll(s)]:[]);}
  querySelector(s){return this.querySelectorAll(s)[0]||null;}
  focus(){document.activeElement=this;}
  scrollIntoView(){}
 }
 const picked=[],src=fs.readFileSync(new URL('../ui/popover.js',import.meta.url),'utf8');
 const code=src.slice(src.indexOf('function picker('),src.indexOf('// A button that behaves'));
 const ctx={h:(...a)=>new Node(...a),matcher:q=>text=>text.toLowerCase().includes(q.toLowerCase()),norm:s=>s.toLowerCase(),colorVar:()=>'',popover:(anchor,title,body)=>new Node('div',{},body),closePopover:p=>{p.isConnected=false;},document};
 const picker=vm.runInNewContext(code+'\npicker',ctx),p=picker({}, {title:'検索',items:()=>items,onPick:v=>picked.push(v),limit:200});
 const input=p.querySelector('input');
 return {p,input,picked,document,rows:()=>p.querySelectorAll('.picker-row'),key:key=>input.dispatchEvent({type:'keydown',key,preventDefault(){}})};
}

test('late priority results stay visible at the 200-row bound and preserve the selected value and input focus',()=>{
 const items=Array.from({length:250},(_,i)=>({value:`local:${i}`,label:`match local ${i}`,group:'カード'})),f=fixture(items);
 f.input.value='match';f.input.selectionStart=2;f.input.selectionEnd=4;f.input.dispatchEvent({type:'input'});
 f.rows()[198].onmousemove();
 items.unshift(...Array.from({length:20},(_,i)=>({value:`outside:${i}`,label:`match archive ${i}`,group:'ボードの外'})));
 f.p.refreshItems();
 assert.equal(f.rows().length,200);assert.match(f.rows()[0].children.at(-1).text,/archive 0/);
 assert.equal(f.document.activeElement,f.input);assert.equal(f.input.value,'match');assert.equal(f.input.selectionStart,2);assert.equal(f.input.selectionEnd,4);
 f.key('Enter');assert.deepEqual(f.picked,['local:198']);
});

test('async refresh is deferred during IME composition and does not overwrite the composition draft',()=>{
 const items=[{value:'old',label:'old',group:'カード'}],f=fixture(items);
 f.input.dispatchEvent({type:'compositionstart'});f.input.value='調査';f.input.selectionStart=2;
 items.unshift({value:'new',label:'調査',group:'ボードの外'});f.p.refreshItems();
 assert.equal(f.rows().length,1,'composition keeps its current list until committed');
 assert.equal(f.rows()[0].children.at(-1).text,'old');
 assert.equal(f.input.value,'調査');assert.equal(f.document.activeElement,f.input);assert.equal(f.input.selectionStart,2);
 f.input.dispatchEvent({type:'keydown',key:'Enter',isComposing:true,preventDefault(){throw Error('must not commit while composing');}});
 f.input.dispatchEvent({type:'keydown',key:'Enter',isComposing:false,keyCode:229,preventDefault(){throw Error('must not commit IME key 229');}});assert.equal(f.picked.length,0);
 f.input.dispatchEvent({type:'compositionend'});assert.equal(f.rows().length,1);f.key('Enter');assert.deepEqual(f.picked,['new']);
});


test('command palette reserves visible slots for outside results even with 250 matching board cards',()=>{
 const source=fs.readFileSync(new URL('../ui/keyboard.js',import.meta.url),'utf8');
 const code=source.slice(source.indexOf('  const currentItems = () => {',source.indexOf('async function commandPalette(')),source.indexOf('  const p = picker(',source.indexOf('async function commandPalette(')));
 const items=Array.from({length:250},(_,i)=>({value:`local:${i}`,label:`match ${i}`,group:'カード'}));
 const current=vm.runInNewContext(code+'\ncurrentItems',{sessionPane:null,items,answerAt:0,outside:{items:()=>[{value:'outside:archived',label:'match archive',group:'ボードの外'}]}});
 const f=fixture(Array.from(current()));assert.equal(f.rows().length,200);f.key('Enter');assert.deepEqual(f.picked,['outside:archived']);
});

test('late card results replace only the untouched automatic default, not an explicit selection',()=>{
 const items=[{value:'label:research',label:'調査',group:'ラベルで絞り込み'}],f=fixture(items);
 f.input.value='調査';f.input.dispatchEvent({type:'input'});
 items.unshift({value:'outside:archive',label:'調査',group:'ボードの外'});f.p.refreshItems();
 f.key('Enter');assert.deepEqual(f.picked,['outside:archive']);
});

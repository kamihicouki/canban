import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const code=fs.readFileSync(new URL('../ui/requests.js',import.meta.url),'utf8');
const replaceSource=code.slice(code.indexOf('function replaceDispatch('),code.indexOf('// The options the agent'));
function fixture(focused=false,guard=false){
 const document={body:{},activeElement:null};
 const field=()=>({text:'',selectionStart:0,selectionEnd:0,selectionDirection:'none',scrollTop:0,disabled:false,
   get value(){return this.text;},set value(v){this.text=v;this.selectionStart=this.selectionEnd=v.length;},
   setSelectionRange(start,end,direction){this.selectionStart=start;this.selectionEnd=end;this.selectionDirection=direction;},
   focus(){document.activeElement=this;},});
 const previous=field(),nextInput=field();previous.value='a useful unsent draft';previous.setSelectionRange(3,7,'backward');previous.scrollTop=12;
 const elsewhere={button:true};document.activeElement=focused?previous:elsewhere;
 let replaced=0;const next={querySelector:()=>nextInput},old={ownerDocument:document,
 querySelector:s=>s.includes('.req-row')?(guard?{}:null):previous,
 replaceWith(n){assert.equal(n,next);replaced++;if(document.activeElement===previous)document.activeElement=document.body;}};
 const ctx={promptDrafts:new Map([['dispatch:codex:test',{}]]),renderDispatch:()=>next,workspace:{trackDrafts(){}},live:{feeds:new Map()},paintChoices(){}};
 const replace=vm.runInNewContext(replaceSource+'\nreplaceDispatch',ctx);
 return{replace,old,nextInput,previous,document,elsewhere,get replaced(){return replaced;}};
}
test('live dispatch replacement preserves blurred caret, direction and textarea scroll without taking focus',()=>{
 const f=fixture();f.replace(f.old,{session:{id:'codex:test'}});
 assert.equal(f.nextInput.value,f.previous.value);assert.equal(f.nextInput.selectionStart,3);assert.equal(f.nextInput.selectionEnd,7);assert.equal(f.nextInput.selectionDirection,'backward');assert.equal(f.nextInput.scrollTop,12);assert.equal(f.document.activeElement,f.elsewhere);
});
test('dispatch replacement preserves the focused draft when explicitly requested',()=>{
 const f=fixture(true);f.replace(f.old,{session:{id:'codex:test'}});
 assert.equal(f.document.activeElement,f.nextInput);assert.equal(f.nextInput.selectionStart,3);assert.equal(f.nextInput.selectionEnd,7);
});
test('an active queue editor still prevents replacement',()=>{
 const f=fixture(false,true);f.replace(f.old,{session:{id:'codex:test'}});assert.equal(f.replaced,0);assert.equal(f.previous.selectionStart,3);
});

for(const focused of [false,true])test('rebuilding a session restores '+(focused?'focused':'blurred')+' draft direction and scroll synchronously',()=>{
 const source=fs.readFileSync(new URL('../ui/card-overlay.js',import.meta.url),'utf8');
 const paintSource=source.slice(source.indexOf('function renderPaneKeepingDrafts('),source.indexOf('async function changeSessionCardState('));
 const control=()=>({text:'',get value(){return this.text;},set value(v){this.text=v;this.selectionStart=this.selectionEnd=v.length;},
   selectionStart:0,selectionEnd:0,selectionDirection:'none',scrollTop:0,
   getAttribute:()=> '送るプロンプト',matches:s=>s.includes('.send-box')||s==='input,textarea',
   setSelectionRange(start,end,direction='forward'){this.selectionStart=start;this.selectionEnd=end;this.selectionDirection=direction;},
   focus(){doc.activeElement=this;this.scrollTop=0;}});
 const previous=control(),next=control();previous.value='a useful unsent draft';previous.setSelectionRange(3,7,'backward');previous.scrollTop=12;
 const outside={matches:()=>false},doc={activeElement:focused?previous:outside};let fields=[previous];
 const el={ownerDocument:doc,querySelector:()=>null,querySelectorAll:()=>fields,contains:node=>fields.includes(node)};
 const ctx={live:{feeds:new Map()},workspace:{draftValues:new Map()},promptDrafts:new Map(),$:()=>null,
   renderPane(){fields=[next];},atFeedEnd:()=>false,scrollFeedToEnd(){}};
 const paint=vm.runInNewContext(paintSource+'\nrenderPaneKeepingDrafts',ctx);paint({id:'codex:test',el},{});
 assert.equal(next.value,previous.value);assert.equal(next.selectionStart,3);assert.equal(next.selectionEnd,7);
 assert.equal(next.selectionDirection,'backward');assert.equal(next.scrollTop,12);assert.equal(doc.activeElement,focused?next:outside);
});

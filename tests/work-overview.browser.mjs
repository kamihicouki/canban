// Isolated real-Chrome component check. No actual conversations or writes.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
const read=n=>fs.readFileSync(new URL('../ui/'+n,import.meta.url),'utf8');
const chromeBin=process.env.CANBAN_BROWSER_EXECUTABLE||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const timeline=read('lifetime.js').slice(read('lifetime.js').indexOf('const TIMELINE_GROUP_CAP ='));
const setup=`
const state={board:null},$=(s,p=document)=>p.querySelector(s),$$=(s,p=document)=>[...p.querySelectorAll(s)];
function h(tag,attrs={},...children){const el=document.createElement(tag);for(const[k,v]of Object.entries(attrs)){if(k==='class')el.className=v;else if(k==='text')el.textContent=v;else if(k==='html')el.innerHTML=v;else if(k==='onclick')el.onclick=v;else if(k==='open')el.open=v;else el.setAttribute(k,v);}for(const c of children.flat())if(c)el.append(c);return el;}
${read('icons.js')}
const timelineOn=()=>true,paneDocked=()=>false,panes=[],PANE_MODES=[],faceGlyph=()=>h('span'),faceWho=()=>h('span'),dotPill=()=>null,exchangePill=()=>null,fmtDate=t=>new Date(t).toISOString(),relTime=t=>'1分前',prefetchSession=()=>{},openCard=()=>{};
${read('lifetime-model.js')}\n${timeline}\n${read('inbox.js')}
const now=Date.now(), cards=Array.from({length:8},(_,i)=>({id:'task:'+i,kind:'task',title:'架空の仕事 '+i,description:'各エージェントの仕事を一画面で把握する。',links:[{id:'s'+i,agent:'codex',status:'completed',last:'関連する差分を確認して報告しました'}],updatedAt:now-i,handoff:{nextAction:{text:'結果を確認して次の依頼を決める',source:'reported',sourceSessionId:'claude:test',at:now}}}));
state.board={lists:[{id:'work',title:'進行中',cards:cards.concat(Array.from({length:35},(_,i)=>({id:'auto'+i,agent:'claude',title:'【12時間毎】定期メンテナンス',automation:true,status:'completed',updatedAt:now-i})))}]};
document.querySelector('#board').append(renderInbox(state.board));
document.querySelector('.inbox-main').append(h('div',{class:'test-conversation'},h('h2',{text:'架空データでの時間軸一覧検証'}),h('p',{text:'既存の会話領域を変更せず、仕事の現在地と次の行動を選べるか確認します。'}),h('textarea',{id:'draft','aria-label':'未送信の下書き'})));
window.testApi={state,refreshInboxList,inboxToggleUnbundled};`;
const html=`<!doctype html><html data-theme="light"><meta charset="utf-8"><style>${read('base.css')}\n${read('inbox.css')}\nhtml,body{margin:0;height:100%}.topbar{height:44px;padding:10px 20px;box-sizing:border-box;background:var(--card-bg);color:var(--card-fg)}#board{height:calc(100% - 44px);box-sizing:border-box;padding:16px;display:flex;background:var(--board-bg)}.test-conversation{max-width:600px;padding:24px;color:var(--card-fg)}textarea{width:95%;min-height:100px;color:var(--card-fg);background:var(--card-hover)}.card{display:flex;min-width:0}.grow{flex:1}.muted{color:var(--card-muted)}</style><div class="topbar">canban · 架空データの時間軸検証</div><main id="board"></main><script>${setup}</script></html>`;

test('work overview: 5 readable jobs, folded 35 automations, stable reading anchor and draft after 3 updates', {timeout:30000,skip:!fs.existsSync(chromeBin)},async t=>{
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const port=server.address().port,profile=fs.mkdtempSync(path.join(os.tmpdir(),'work-overview-')),debug=port+1;
 const chrome=spawn(chromeBin,['--headless=new',`--remote-debugging-port=${debug}`,`--user-data-dir=${profile}`,'--no-first-run','about:blank'],{stdio:'ignore'});
 t.after(()=>{chrome.kill();server.close();setTimeout(()=>fs.rmSync(profile,{recursive:true,force:true}),500);});
 let target;for(let i=0;i<60&&!target;i++){try{target=(await(await fetch(`http://127.0.0.1:${debug}/json`)).json()).find(p=>p.type==='page');}catch{}await delay(100);}
 assert.ok(target);const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);t.after(()=>ws.close());let id=0;const pending=new Map(),errors=[];
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
 const cdp=(method,params={})=>new Promise(r=>{const n=++id;pending.set(n,r);ws.send(JSON.stringify({id:n,method,params}));});
 await cdp('Runtime.enable');await cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});await cdp('Page.navigate',{url:`http://127.0.0.1:${port}`});await delay(400);
 const result=await cdp('Runtime.evaluate',{returnByValue:true,expression:`(()=>{
  const visible=[...document.querySelectorAll('.irow-work')].filter(r=>r.getBoundingClientRect().bottom<=800);
  if(visible.length<5)throw new Error('fewer than 5 visible work rows: '+visible.length+' '+JSON.stringify([...document.querySelectorAll('.irow-work')].slice(0,2).map(r=>({r:r.getBoundingClientRect().toJSON(),body:r.querySelector('.irow-body').getBoundingClientRect().toJSON()}))));
  const initialRowHeight=visible[0].getBoundingClientRect().height;
  const fold=document.querySelector('.inbox-unbundled');if(fold.open||!fold.textContent.includes('35件'))throw new Error('35 standalone automations not folded');
  if([...fold.querySelectorAll('.irow')].some(r=>r.checkVisibility()))throw new Error('automation rows visible while closed');
  const list=document.querySelector('.inbox-list');list.scrollTop=210;const top=list.getBoundingClientRect().top;
  const anchor=[...list.querySelectorAll('.irow-work')].find(r=>r.getBoundingClientRect().bottom>top),anchorId=anchor.dataset.cardId,offset=anchor.getBoundingClientRect().top;
  const draft=document.querySelector('#draft');draft.value='保持する未送信の下書き';draft.focus();draft.setSelectionRange(2,5);
  const times=[];for(let i=0;i<3;i++){testApi.state.board.lists[0].cards[7].updatedAt=Date.now()+i;const start=performance.now();testApi.refreshInboxList();times.push(performance.now()-start);}
  const restored=document.querySelector('[data-card-id="'+anchorId+'"]');const anchorDelta=restored.getBoundingClientRect().top-offset;if(Math.abs(anchorDelta)>1)throw new Error('reading anchor moved');
  if(draft.value!=='保持する未送信の下書き'||document.activeElement!==draft||draft.selectionStart!==2||draft.selectionEnd!==5)throw new Error('draft/focus/caret lost');
  const currentFold=document.querySelector('.inbox-unbundled');testApi.inboxToggleUnbundled();if(!currentFold.open)throw new Error('fold keyboard command failed');if(currentFold.querySelectorAll('.inbox-automation').length!==1)throw new Error('confirmed automation repeats not grouped');testApi.inboxToggleUnbundled();
  list.scrollTop=0;return {visibleJobs:visible.length,refreshMs:times,anchorDelta,bodyWidth:document.querySelector('.inbox-main').getBoundingClientRect().width,rowHeight:initialRowHeight};
 })()`});
 assert.equal(result.result.exceptionDetails,undefined,JSON.stringify(result.result.exceptionDetails));assert.deepEqual(errors,[]);
 const out=path.resolve('.local/self-improvement-loop/work-overview');fs.mkdirSync(out,{recursive:true});
 for(const theme of ['light','dark']){await cdp('Runtime.evaluate',{expression:`document.documentElement.dataset.theme='${theme}'`});const shot=await cdp('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,theme+'.png'),Buffer.from(shot.result.data,'base64'));}
 fs.writeFileSync(path.join(out,'metrics.json'),JSON.stringify({scope:'isolated Chrome component with fictional data; not registered extension or real conversation acceptance',...result.result.result.value},null,2));
 console.log(JSON.stringify(result.result.result.value));
});

// Optional evidence capture in the isolated smoke Chrome. Never uses the registered profile.
import fs from 'node:fs';
import path from 'node:path';
export async function captureWorkspace(cdp, directory) {
  const out=path.resolve(directory);fs.mkdirSync(out,{recursive:true});const rows=[];
  const run=async expression=>{
    const response=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(response.result.exceptionDetails)throw new Error(JSON.stringify(response.result.exceptionDetails));
    return response.result.result.value;
  };
  const shot=async name=>{const packet=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(packet.result.data,'base64'));};
  for(const view of ['board','timeline','gantt'])for(const theme of ['light','dark'])for(const kind of ['session','task']){
    const metric=await run(`(async()=>{
      const api=window.__canbanSmokeWorkspace;api.clear();document.activeElement?.blur();api.shape('workspace');api.board(${JSON.stringify(view)});await new Promise(r=>setTimeout(r,150));
      document.documentElement.dataset.theme=${JSON.stringify(theme)};
      let id='claude:c2';if(${JSON.stringify(kind)}==='task')id=document.querySelector('#board [data-card-id^="task:"]')?.dataset.cardId;
      if(!id)throw new Error('evidence card absent');
      const start=performance.now();
      if(${view !== 'board'}){
        if(!document.querySelector('#board [data-card-id="'+id+'"]')){for(const more of document.querySelectorAll('.irow-more[aria-expanded="false"]'))more.click();await new Promise(r=>setTimeout(r,100));}
        const row=document.querySelector('#board [data-card-id="'+id+'"]');if(!row)throw new Error('dock row absent '+${JSON.stringify(view)}+' '+${JSON.stringify(kind)}+' '+id+' '+[...document.querySelectorAll('#board [data-card-id]')].map(e=>e.dataset.cardId).join(','));row.click();
        for(let i=0;i<50;i++){const selected=[...document.querySelectorAll('.pane:not([hidden])')].find(p=>p.dataset.id===id)||document.querySelector('.pane:not([hidden])');if(selected?.querySelector(${JSON.stringify(kind)}==='session'?'.feed .fi':'.th-task'))break;await new Promise(r=>setTimeout(r,100));}
      }else await api.open(id,{dock:false});
      await document.fonts.ready;document.querySelector('.toast')?.remove();
      const pane=document.querySelector('.pane:not([hidden])');if(!pane)throw new Error('selected card absent');
      for(const b of pane.querySelectorAll('.th-tool[aria-pressed="true"]'))b.click();
      const input=pane.querySelector('.th-dock textarea');if(input){input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));input.blur();}
      if(${JSON.stringify(kind)}==='session' && ${view === 'board'})await api.origin();
      document.activeElement?.blur();await new Promise(r=>setTimeout(r,200));
      const feed=pane.querySelector('.feed')||pane.querySelector('.th-conv'),rect=feed.getBoundingClientRect(),body=pane.querySelector('.th-body').getBoundingClientRect();
      if(rect.height<250||rect.width<280||body.width<280)throw new Error('evidence conversation is not usable: '+JSON.stringify({height:rect.height,width:rect.width,body:body.width}));
      return {openUsableMs:performance.now()-start,feedHeight:rect.height,feedWidth:rect.width,bodyWidth:body.width,appBarHeight:document.querySelector('.topbar').getBoundingClientRect().height,headerAboveConversation:!!pane.querySelector(':scope>.th-head'),shape:pane.dataset.shape,contextOpen:pane.dataset.contextOpen};
    })()`);
    rows.push({view,theme,kind,...metric});await shot(`${view}-${theme}-${kind}-workspace`);
    if(view==='board'&&kind==='session'){await run(`window.__canbanSmokeWorkspace.latest()`);await shot(`${view}-${theme}-latest-tools-permission`);}
    if(view==='board'&&kind==='session'){
      const legacy=await run(`(async()=>{window.__canbanSmokeWorkspace.shape('card');await new Promise(r=>setTimeout(r,150));const pane=document.querySelector('.pane:not([hidden])'),feed=pane.querySelector('.feed');return {feedHeight:feed.getBoundingClientRect().height,feedWidth:feed.getBoundingClientRect().width,headerAboveConversation:!!pane.querySelector(':scope>.th-head')};})()`);
      rows.push({view,theme,kind,shape:'card',...legacy});await shot(`${view}-${theme}-${kind}-card`);
      for(const placement of ['split','sheet']){const dimensions=await run(`(async()=>{const api=window.__canbanSmokeWorkspace;api.shape('workspace');api.placement('${placement}');await new Promise(r=>setTimeout(r,100));const r=document.querySelector('.pane:not([hidden])').getBoundingClientRect();return {left:r.left,width:r.width};})()`);if(placement==='split'&&dimensions.left<400)throw new Error('split placement has been overridden');rows.push({view,theme,kind,shape:'workspace',placement,...dimensions});await shot(`${view}-${theme}-${kind}-${placement}`);}await run(`window.__canbanSmokeWorkspace.placement('full')`);
    }
  }
  // A narrow window uses the same context drawer; Escape closes it before the card.
  await cdp('Emulation.setDeviceMetricsOverride',{width:700,height:800,deviceScaleFactor:1,mobile:false});
  await run(`(async()=>{const api=window.__canbanSmokeWorkspace;api.clear();api.shape('workspace');await api.open('claude:c2',{dock:false});await new Promise(r=>setTimeout(r,150));const p=document.querySelector('.pane:not([hidden])');if(p.dataset.contextOpen==='false')p.querySelector('.ws-context-open').click();if(p.getBoundingClientRect().right>701)throw new Error('narrow card overflows');p.focus();document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));if(p.dataset.contextOpen!=='false'||!p.isConnected)throw new Error('narrow Esc closed the whole card');})()`);
  await shot('narrow-700-context-closed');
  await cdp('Emulation.setDeviceMetricsOverride',{width:2048,height:900,deviceScaleFactor:1,mobile:false});
  await run(`(async()=>{const api=window.__canbanSmokeWorkspace;api.clear();api.shape('workspace');api.board('board');await api.open('claude:c2',{dock:false});await new Promise(r=>setTimeout(r,150));const p=document.querySelector('.pane:not([hidden])');if(p.dataset.contextOpen==='false')p.querySelector('.ws-context-open').click();})()`);
  await shot('wide-2048-workspace');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  fs.writeFileSync(path.join(out,'metrics.json'),JSON.stringify({scope:'isolated Chrome with fictional data; same rendering/input; 1280x800 unless named; open times mix cached/uncached reads and are not a controlled speed comparison',rows},null,2));
}

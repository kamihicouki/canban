// A single related-cards section in the existing details panel; no page or persistent extra rail.
const cardRelationPanels=new Map();
const cardRelationVisits=[];
function paintCardRelationBacks() {
  for(const [id,panel]of cardRelationPanels) {
    const back=panel.querySelector('.cr-back');if(back)back.hidden=cardRelationVisits.at(-1)?.toId!==id;
  }
}
function cardRelationCaret(id) {
  const input=panes.find(p=>p.id===id)?.el.querySelector('.send-box textarea');
  return input?{value:input.value,start:input.selectionStart,end:input.selectionEnd,direction:input.selectionDirection}:null;
}
async function visitRelatedCard(fromId,toId,edgeId) {
  if(cardRelationVisits.at(-1)?.toId!==fromId)cardRelationVisits.length=0;
  const visit={fromId,toId,edgeId,caret:cardRelationCaret(fromId)};
  cardRelationVisits.push(visit);if(cardRelationVisits.length>32)cardRelationVisits.shift();
  try{
    await openCard(toId);
    if(!panes.some(p=>p.id===toId)){if(cardRelationVisits.at(-1)===visit)cardRelationVisits.pop();paintCardRelationBacks();return;}
    await openCardRelations(null,toId,{focus:false});
    cardRelationPanels.get(toId)?.querySelector('.cr-back')?.focus({preventScroll:true});
  }catch(error){if(cardRelationVisits.at(-1)===visit)cardRelationVisits.pop();toast(error.message,true);}
  paintCardRelationBacks();
}
async function returnFromRelatedCard() {
  const visit=cardRelationVisits.pop();if(!visit)return;
  try{
    await openCard(visit.fromId);
    await openCardRelations(null,visit.fromId,{focus:false});
    const input=panes.find(p=>p.id===visit.fromId)?.el.querySelector('.send-box textarea');
    if(input&&visit.caret&&input.value===visit.caret.value){try{input.setSelectionRange(visit.caret.start,visit.caret.end,visit.caret.direction);}catch{}}
    const panel=cardRelationPanels.get(visit.fromId);
    const link=visit.edgeId&&panel?.querySelector('[data-relation-id="'+CSS.escape(visit.edgeId)+'"] .cr-title');
    (link&&!link.disabled?link:panel?.querySelector('.cr-add'))?.focus({preventScroll:true});
  }catch(error){cardRelationVisits.push(visit);toast(error.message,true);}
  paintCardRelationBacks();
}
function cardRelationsSection(cardId) {
  const status=h('p',{class:'muted cr-status',role:'status',text:'手動で関連付けたカードです。所属やエージェントの親子関係とは別です。'});
  const rows=h('div',{class:'cr-list'});
  const back=h('button',{class:'link-btn cr-back',type:'button',hidden:cardRelationVisits.at(-1)?.toId!==cardId,onclick:returnFromRelatedCard},h('span',{html:picon('left',14)}),'前のカードへ戻る');
  const add=h('button',{class:'side-btn cr-add',type:'button',onclick:event=>chooseCardRelationKind(event.currentTarget,cardId)},h('span',{html:picon('plus',14)}),'カードを関連付ける');
  const root=h('div',{class:'card-relations','data-card-relations':cardId},h('div',{class:'cr-tools'},back,add),status,rows);
  let request=0;
  root.reloadRelations=async()=>{
    const current=++request;root.readingRelations=true;status.textContent='関連するカードを取得しています…';
    try{
      const result=await bridge.callTool('canban_get_card_relations',{cardId});
      if(current!==request||cardRelationPanels.get(cardId)!==root)return;
      root.relationsLoaded=true;
      rows.replaceChildren(...result.relations.map(edge=>{
        const other=edge.other;
        const open=h('button',{class:'link-btn cr-title',type:'button',disabled:!other.available,title:other.available?'このカードを開く':'元のカードは取得できません',text:other.title||'未取得のカード',onclick:()=>visitRelatedCard(cardId,other.id,edge.id)});
        const remove=h('button',{class:'icon-btn cr-remove',type:'button','aria-label':`関連を解除: ${other.title}`,title:'この手動の関連だけを解除します',html:picon('close',14),onclick:async()=>{
          remove.disabled=true;
          try{
            await bridge.callTool('canban_unlink_card_relation',{relationId:edge.id,expectedRelation:cardRelationExpected(edge)});
            await refreshCardRelationPanels([edge.fromId,edge.toId]);toast('手動の関連を解除しました');
          }catch(error){toast(error.message,true);remove.disabled=false;}
        }});
        return h('div',{class:'cr-row','data-relation-id':edge.id,'data-relation-kind':edge.kind,'data-relation-other':other.id},
          h('div',{class:'cr-copy'},h('span',{class:'cr-direction',text:cardRelationLabel(edge)}),open,h('span',{class:'muted cr-meta',text:cardRelationOtherText(other,STATUS_LABELS)})),remove);
      }));
      if(!result.relations.length)rows.append(h('p',{class:'muted',text:result.errors?.length?'一部のカードは未取得です':'手動の関連はありません'}));
      status.textContent=[`手動の関連 ${result.relations.length}件。所属・エージェントの親子・観測したやり取りとは別です。`,...(result.errors||[]).map(error=>typeof error==='string'?error:error.message||error.error||'一部のカードは未取得です')].join(' ');
      paintCardRelationBacks();
    }catch(error){if(current===request)status.textContent=`関連を取得できませんでした: ${error.message}`;}
    finally{if(current===request)root.readingRelations=false;}
  };
  cardRelationPanels.set(cardId,root);
  while(cardRelationPanels.size>64)cardRelationPanels.delete(cardRelationPanels.keys().next().value);
  return root;
}
async function refreshCardRelationPanels(ids) {
  await Promise.all([...new Set(ids)].map(id=>cardRelationPanels.get(id)?.reloadRelations()));
}
async function openCardRelations(anchor,cardId,{focus=true}={}) {
  try{
  let p=panes.find(p=>p.id===cardId);
  if(!p){await openCard(cardId);p=panes.find(p=>p.id===cardId);}
  if(!p)return;
  if(p.pending && p.kind==='session')await (p.initialSessionLoad || loadSession(p));
  if(!panes.includes(p))return;
  if(p.sideTab!=='details')openThreadSide(p,'details');
  const section=p.el.querySelector('[data-sec="cardRelations"]');
  if(!section)return;
  section.open=true;
  const root=section.querySelector('[data-card-relations]');
  await root?.reloadRelations();
  section.scrollIntoView({block:'nearest'});
  if(focus)root?.querySelector('.cr-add')?.focus({preventScroll:true});
  }catch(error){toast(error.message,true);}
}
function chooseCardRelationKind(anchor,cardId) {
  return picker(anchor,{title:'関連の種類',items:[
    {value:'ref-out',label:'参考として関連付ける',description:'双方向の参照。前後や親子を意味しません'},
    {value:'blocks-out',label:'このカードが先に必要',description:'このカード → 選んだカード の順に進める'},
    {value:'blocks-in',label:'このカードより先に必要',description:'選んだカード → このカード の順に進める'},
    {value:'derived-out',label:'このカードから派生したカード',description:'このカードが派生元、選んだカードが派生先'},
    {value:'derived-in',label:'このカードの派生元',description:'選んだカードが派生元、このカードが派生先'},
  ],onPick:kind=>chooseCardRelationTarget(anchor,cardId,kind)});
}
function chooseCardRelationTarget(anchor,cardId,choice) {
  let items=[],panel,search;
  const footer=h('div',{class:'muted cr-search-state',role:'status',text:'全期間・アーカイブ・すべてのAI Appから探します。'});
  panel=picker(anchor,{title:'関連付けるカード',items:()=>items,width:400,placeholder:'カード名を入力…',footer,
    onPick:async targetId=>{
      search.dispose();
      try{
        const plan=cardRelationPlan(choice,cardId,targetId);
        const result=await bridge.callTool('canban_link_card_relation',plan);
        await refreshCardRelationPanels([cardId,targetId]);toast(result.created?'カードを関連付けました':'同じ関連がすでにあります');
      }catch(error){toast(error.message,true);}
    },
  });
  search=createCardRelationSearch({cardId,search:args=>bridge.callTool('canban_search',args),onChange:state=>{
    if(!panel.isConnected){search?.dispose();return;}
    items=state.rows.map(row=>({value:row.cardId,label:row.title,description:[row.kind==='task'?'タスクカード':agentLabel(row.agent),row.surface?SURFACE_META[row.surface]?.short||row.surface:null,row.archived?'アーカイブ済み':null,row.statusKnown===false?'状態は未取得':null].filter(Boolean).join(' · ')}));
    footer.textContent=state.state==='loading'?'全期間・すべてのAI Appを検索しています…':state.state==='error'?`検索できませんでした: ${state.error}`:`全期間・アーカイブ・すべてのAI Appが対象です。${state.rows.length}件を表示${state.errors?.length?'（一部の取得に失敗）':''}`;
    panel.refreshItems();
  }});
  panel.onClose=()=>search.dispose();
  panel.querySelector('.picker-input').addEventListener('input',event=>search.update(event.target.value));
  search.update('');
  return panel;
}
document.addEventListener('toggle',event=>{
  const section=event.target;
  if(section.matches?.('details[data-sec="cardRelations"]')&&section.open){
    const root=section.querySelector('[data-card-relations]');if(root&&!root.relationsLoaded&&!root.readingRelations)root.reloadRelations();
  }
},true);

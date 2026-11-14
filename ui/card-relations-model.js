// Explicit card relationships are separate from task membership and agent observations.
function cardRelationLabel(edge) {
  if(edge.kind==='ref')return '参考（双方向）';
  if(edge.kind==='blocks')return edge.direction==='incoming'?'相手が先に必要 → このカード':'このカードが先に必要 → 相手';
  if(edge.kind==='derived')return edge.direction==='incoming'?'派生元 → このカード':'このカード → 派生先';
  return '未対応の関連';
}
function cardRelationOtherText(other,statusLabels={}) {
  const kind=other.kind==='task'?'タスクカード':other.kind==='session'?'セッション':'種類は未取得';
  const state=!other.available?'カードは未取得':other.kind==='task'&&other.linkedSessionCount===0?'セッションなし':other.statusKnown===false?'状態は未取得':statusLabels[other.status]||'状態は未取得';
  const status=other.available&&other.kind==='task'&&other.linkedSessionCount!==0?`関連セッション: ${state}`:state;
  return [kind,other.archived?'アーカイブ済み':null,status,other.statusPartial?'一部未取得':null].filter(Boolean).join(' · ');
}
function cardRelationPlan(choice,source,target) {
  const [kind,direction]=String(choice).split('-');
  if(!['ref','blocks','derived'].includes(kind)||!['in','out'].includes(direction))throw Error('関連の種類を選んでください');
  return {kind,fromId:direction==='in'?target:source,toId:direction==='in'?source:target};
}
function cardRelationExpected(edge) {
  return Object.fromEntries(['id','kind','fromId','toId','createdAt'].map(key=>[key,edge[key]]));
}
function createCardRelationSearch({cardId,search,onChange,setTimer=setTimeout,clearTimer=clearTimeout,delay=200}) {
  let generation=0,timer=null,disposed=false;
  return {
    update(raw) {
      const q=String(raw||'').trim(),current=++generation;
      if(timer!==null)clearTimer(timer);
      onChange({state:'loading',rows:[],error:null});
      timer=setTimer(async()=>{
        timer=null;
        try {
          const result=await search({q,days:0,includeArchived:true,includeSubagents:true,dotScope:'all',limit:50});
          if(disposed||current!==generation)return;
          onChange({state:'ready',rows:(result.results||[]).filter(row=>row.cardId!==cardId),errors:result.errors||[],total:result.total,error:null});
        }catch(error){if(!disposed&&current===generation)onChange({state:'error',rows:[],error:error.message});}
      },delay);
    },
    dispose(){disposed=true;++generation;if(timer!==null)clearTimer(timer);timer=null;},
  };
}

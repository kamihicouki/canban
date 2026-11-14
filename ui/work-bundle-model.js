// Pure matching and guarded mutations for explicitly collecting sessions into a task.
function workBundleDisabledReason(card) {
  if (!card || card.kind === 'task' || String(card.id || '').startsWith('task:')) return 'セッションカードを選んでください';
  if (card.subagent) return 'サブエージェントは親セッションから参照してください';
  if (card.dot || card.sourceKind === 'codex-cloud') return 'クラウドのセッションは元アプリで整理してください';
  return null;
}
function workSuggestions(session, tasks) {
  if (workBundleDisabledReason(session) || !session.cwd || session.statusKnown === false) return [];
  const host = s => s.host?.id || 'local';
  return tasks.flatMap(task => {
    const peers = (task.links || []).filter(link => link.id !== session.id && !link.subagent && link.cwd === session.cwd && host(link) === host(session) && link.statusKnown !== false && !link.dot && link.sourceKind !== 'codex-cloud');
    if (!peers.length) return [];
    const strong = !!session.branch && peers.some(link => link.branch === session.branch);
    const folder = session.cwd.split('/').filter(Boolean).pop() || session.cwd;
    return [{ taskId: task.id, strength: strong ? 'strong' : 'weak', reason: strong ? `同じ作業フォルダーとブランチ: ${folder} · ${session.branch}` : `同じ作業フォルダー: ${folder}`, at: Number(task.updatedAt) || Date.parse(task.updatedAt) || 0 }];
  }).sort((a,b) => Number(b.strength === 'strong') - Number(a.strength === 'strong') || b.at - a.at).slice(0,5).map(({at,...result}) => result);
}
const workLinkIds = task => task.linkedSessionIds || (task.links || []).map(x => typeof x === 'string' ? x : x.id);
const workOwner = (tasks,id) => tasks.find(task => workLinkIds(task).includes(id)) || null;
function workBundleChoices(session,tasks) {
  const current=workOwner(tasks,session.id);
  const suggestions=workSuggestions(session,tasks).filter(s=>s.taskId!==current?.id);
  const suggested=new Set(suggestions.map(s=>s.taskId));
  const choice=task=>({value:task.id,label:task.title,description:current?`「${current.title}」から移動`:'このタスクカードにまとめる'});
  return {current,explanation:[current?`いまの仕事: ${current.title}`:'いまの仕事: 未所属','候補は作業フォルダー・ブランチが一致する仕事です。選ぶまで所属は変わりません。'].join(' · '),items:[
    ...suggestions.map(s=>({...choice(tasks.find(t=>t.id===s.taskId)),group:'候補',description:[s.reason,current?`「${current.title}」から移動`:''].filter(Boolean).join(' · ')})),
    {value:'__new',label:`新しいタスクカードにまとめる: ${session.title || '新しい仕事'}`,group:'新しくまとめる',description:'同じリストとカテゴリに作成します'},
    ...tasks.filter(t=>t.id!==current?.id&&!suggested.has(t.id)).map(t=>({...choice(t),group:'すべてのタスクカード'})),
    ...(current?[{value:'__unlink',label:'この仕事から外す',group:'所属を変更',description:`「${current.title}」からこのセッションを外します。セッション自体は削除しません`}]:[]),
  ]};
}
function createWorkBundleController({read,call,refresh}) {
  const busy = new Set();
  return {
    async bundle(sessionId,{taskId,create=false,clientRequestId,unlink=false}={}) {
      if(busy.has(sessionId))return null;
      busy.add(sessionId);
      let created = null;
      try {
        const before=await read(sessionId),reason=workBundleDisabledReason(before.session);
        if(reason)throw Error(reason);
        const from=workOwner(before.tasks,sessionId);
        let to=taskId;
        if(create){
          created=await call('canban_create_task',{title:before.session.title || '新しい仕事',description:'',list:before.listId,directory:before.session.directoryId || before.session.directory?.id || null,clientRequestId});
          to=created.cardId;
        }
        if(!to)throw Error('まとめるタスクカードを選んでください');
        const remove=unlink;
        if(!remove && from?.id===to)return null;
        if(remove && from?.id!==to)throw Error('所属が変更されているため解除できません');
        await call(remove?'canban_unlink_session':'canban_link_session',{taskId:to,sessionId,expectedTaskId:from?.id || null});
        const receipt={sessionId,fromTaskId:from?.id || null,toTaskId:remove?null:to,title:created?.title || before.tasks.find(t=>t.id===to)?.title || '',created:created ? (()=>{const {cardId,...task}=created;return {id:cardId,task};})() : null,undone:false};
        await refresh(sessionId);
        return receipt;
      } catch(error) {
        if(created)error.message+=`。タスク「${created.title}」（${created.cardId}）は作成済みです。削除せず残しました`;
        throw error;
      } finally {busy.delete(sessionId);}
    },
    async undo(receipt) {
      if(!receipt || receipt.undone || busy.has(receipt.sessionId))return false;
      busy.add(receipt.sessionId);
      try {
        const latest=await read(receipt.sessionId),owner=workOwner(latest.tasks,receipt.sessionId);
        if((owner?.id||null)!==receipt.toTaskId)throw Error('所属が変更されているため取り消せません。現在の仕事を確認してください');
        if(receipt.fromTaskId)await call('canban_link_session',{taskId:receipt.fromTaskId,sessionId:receipt.sessionId,expectedTaskId:receipt.toTaskId});
        else if(receipt.toTaskId)await call('canban_unlink_session',{taskId:receipt.toTaskId,sessionId:receipt.sessionId,expectedTaskId:receipt.toTaskId});
        receipt.undone=true;
        if(receipt.created){
          // Atomic comparison in the store preserves even edits made after this read.
          try {await call('canban_delete_task',{cardId:receipt.created.id,expectedTask:receipt.created.task});}
          catch(error){receipt.retainedTask=error.message.includes('変更されている');receipt.cleanupUnconfirmed=!receipt.retainedTask;}
        }
        await refresh(receipt.sessionId);
        return true;
      } finally {busy.delete(receipt.sessionId);}
    },
  };
}

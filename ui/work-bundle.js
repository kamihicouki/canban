// One explicit picker for session -> task membership. Merely opening it never writes data.
let lastWorkBundle = null;
let workBundlePending = 0;
const workBundleInteractions = new Map();
async function readWorkBundle(sessionId) {
  const board = await bridge.callTool('canban_get_board', { days: 0, includeArchived: true, includeSubagents: true, dotScope: 'all', readOnly: true });
  const cards = board.lists.flatMap(list => list.cards.map(card => ({ ...card, listId: list.id })));
  const byId = new Map(cards.map(card => [card.id,card]));
  const session = byId.get(sessionId);
  if(!session)throw Error('セッションを取得できませんでした。現在のカードを確認してください');
  const tasks = cards.filter(card => card.kind === 'task').map(task => ({ ...task,
    links: task.links.map(link => ({ ...byId.get(link.id), ...link, cwd: link.cwd || byId.get(link.id)?.cwd, branch: link.branch || byId.get(link.id)?.branch })) }));
  return { session, tasks, listId: session.listId || board.lists[0]?.id };
}
function captureWorkBundleInteraction(sessionId,anchor=null) {
  const previous=panes.find(p=>p.id===sessionId),active=document.activeElement;
  return {previous,oldRoot:panes[0],docked:paneDocked(),focusSection:anchor?.closest?.('details[data-sec]')?.open?anchor.closest('details[data-sec]').dataset.sec:null,focusLabel:anchor?.getAttribute?.('aria-label')||(previous?.el.contains(active)?active.getAttribute?.('aria-label'):null)};
}
async function refreshWorkBundleSession(sessionId) {
  const {previous,oldRoot,docked,focusLabel,focusSection}=workBundleInteractions.get(sessionId)||captureWorkBundleInteraction(sessionId);
  const originalInput=previous?.el.querySelector('.send-box textarea');
  const caret=originalInput&&{value:originalInput.value,start:originalInput.selectionStart,end:originalInput.selectionEnd,direction:originalInput.selectionDirection};
  if(state.inbox&&previous)state.inbox.sel=sessionId;
  if(state.gantt&&previous&&docked)state.gantt.sel=sessionId;
  sessionPrefetch.delete(sessionId);
  await load();
  let pane=panes.find(p=>p.id===sessionId),reopened=false;
  // Reconciliation can remove a moved child from its former task's side-by-side overlay.
  // Keep the conversation the user was operating, using its existing cached pane.
  if(!pane&&previous&&oldRoot?.kind==='task'&&panes[0]===oldRoot&&!paneLayer.hidden) {
    await openCard(sessionId,{dock:docked});pane=panes.find(p=>p.id===sessionId);reopened=true;
  }
  if(!pane||pane.kind!=='session')return;
  if(!reopened)await loadSession(pane);
  const input=pane.el.querySelector('.send-box textarea');
  if(caret&&input&&input.value===caret.value&&document.activeElement!==input){try{input.setSelectionRange(caret.start,caret.end,caret.direction);}catch{}}
  if(focusSection){const section=pane.el.querySelector('details[data-sec="'+CSS.escape(focusSection)+'"]');if(section)section.open=true;}
  if(focusLabel&&!document.activeElement?.matches('input,textarea,[contenteditable]')&&(document.activeElement===document.body||pane.el.contains(document.activeElement))) {
    const control=[...pane.el.querySelectorAll('[aria-label]')].find(node=>node.getAttribute('aria-label')===focusLabel)||(pane.el.getAttribute('aria-label')===focusLabel?pane.el:null);
    if(control&&!control.disabled)control.focus({preventScroll:true});
  }
}
const workBundleController = createWorkBundleController({
  read: readWorkBundle,
  call: (name,args) => { live.ownActAt=Date.now(); return bridge.callTool(name,args); },
  refresh: refreshWorkBundleSession,
});
function workBundleUndoAvailable() { return workBundlePending===0&&!!lastWorkBundle&&!lastWorkBundle.undone; }
async function undoWorkBundle(receipt=lastWorkBundle) {
  if(workBundlePending){toast('所属を変更しています。完了してから取り消してください');return;}
  if(!receipt||receipt.undone)return;
  const interaction=captureWorkBundleInteraction(receipt.sessionId);workBundleInteractions.set(receipt.sessionId,interaction);
  ++workBundlePending;toast('仕事のまとめを取り消しています…');
  try {
    if(await workBundleController.undo(receipt))toast(receipt.retainedTask?'所属を元に戻しました。変更されたタスクカードは残しています':receipt.cleanupUnconfirmed?'所属を元に戻しました。タスクの削除は確認できませんでした':'仕事のまとめを取り消しました');
  }catch(error){toast(error.message,true);}
  finally{--workBundlePending;if(workBundleInteractions.get(receipt.sessionId)===interaction)workBundleInteractions.delete(receipt.sessionId);}
}
async function workBundlePicker(anchor,cardId) {
  const known = findCard(cardId)?.card || panes.find(p=>p.id===cardId)?.d?.session;
  const unavailable=known && workBundleDisabledReason(known);
  if(unavailable){toast(unavailable,true);return;}
  let snapshot, current, items=[];
  const clientRequestId=`bundle_${crypto.randomUUID().replaceAll('-','')}`;
  const footer=h('div',{class:'muted',text:'仕事を取得しています…',role:'status'});
  const panel=picker(anchor,{title:'仕事にまとめる',items:()=>items,width:400,
    onPick: async value => {
      const interaction=captureWorkBundleInteraction(cardId,anchor);workBundleInteractions.set(cardId,interaction);
      ++workBundlePending;toast('仕事の所属を変更しています…');
      try {
        const receipt=await workBundleController.bundle(cardId,value==='__new'?{create:true,clientRequestId}:value==='__unlink'?{taskId:current?.id,unlink:true}:{taskId:value,unlink:false});
        if(!receipt)return;
        lastWorkBundle=receipt;
        toastAction(receipt.toTaskId?`「${receipt.title}」にまとめました`:'仕事の紐付けを解除しました','取り消す',()=>undoWorkBundle(receipt));
      } catch(error) {toast(error.message,true);await load();}
      finally{--workBundlePending;if(workBundleInteractions.get(cardId)===interaction)workBundleInteractions.delete(cardId);}
    },footer,
  });
  try { snapshot=await readWorkBundle(cardId); }
  catch(error){if(panel.isConnected){footer.textContent=`仕事を取得できませんでした: ${error.message}`;}return panel;}
  if(!panel.isConnected)return panel; // Escape while loading must not reopen the picker.
  const reason=workBundleDisabledReason(snapshot.session);
  if(reason){closePopover(panel);toast(reason,true);return;}
  const choices=workBundleChoices(snapshot.session,snapshot.tasks);
  current=choices.current;items=choices.items;
  footer.textContent=choices.explanation;
  panel.refreshItems();
  return panel;
}

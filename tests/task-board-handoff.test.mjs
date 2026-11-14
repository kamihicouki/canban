import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeFixtures } from './helpers.mjs';

test('task links retain observed last message, read state and queue pause reason without raw handoff notes', () => {
  const fx = makeFixtures();
  try {
    const output = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import {Store} from './server/store.mjs';
      import {buildBoard} from './server/board.mjs';
      import {RequestStore} from './server/requests.mjs';
      import {taskHandoffSummary} from './server/task-handoff.mjs';
      const store=new Store(process.env.CANBAN_DATA_DIR);
      const {cardId}=await store.createTask({title:'fixture task'});
      await store.linkSession({taskId:cardId,sessionId:'claude:c1'});
      const initial=await store.load();initial.settings.seenAllAt=0;initial.cards[cardId].seenAt=0;await store.save(initial);
      const requests=new RequestStore(store.dir);await requests.pause('claude:c1','前の依頼が失敗したため停止');
      const board=await buildBoard(store,{days:0,includeArchived:true},{readOnly:true});
      const task=board.lists.flatMap(l=>l.cards).find(c=>c.id===cardId);
      assert.equal(task.links.length,1);const link=task.links[0];
      assert.equal(link.last,null,'unobserved last message is not inferred from the transcript');assert.equal(link.unread,true);
      assert.equal(link.requests.paused,true);assert.equal(link.requests.pauseReason,'前の依頼が失敗したため停止');
      assert.equal(typeof link.requests.pausedAt,'number');
      assert.deepEqual(task.handoff,taskHandoffSummary((await store.load()).cards[cardId]));
      assert.equal(task.handoff.nextAction,null);assert.equal(task.handoff.totalNotes,0);
      assert.equal('notes' in task.handoff,false);
      const readState=await store.load();readState.cards[cardId].seenAt=Date.now()+86400000;await store.save(readState);
      await store.appendTaskNote({taskId:cardId,text:'確認済みの報告',nextAction:'入力待ちを確認する',expectedRevision:0,clientRequestId:'fixture-report',sourceSessionId:'claude:c1'});
      const seen=await buildBoard(store,{days:0,includeArchived:true},{readOnly:true});
      const readTask=seen.lists.flatMap(l=>l.cards).find(c=>c.id===cardId);
      assert.equal(readTask.links[0].unread,false);
      assert.equal(readTask.handoff.nextAction.text,'入力待ちを確認する');
      assert.equal(readTask.handoff.nextAction.source,'reported');
      assert.equal(readTask.handoff.totalNotes,1);assert.equal('notes' in readTask.handoff,false);
      console.log('ok');await store.close();process.exit(0);
    `], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 30000,
      env: { ...process.env, CANBAN_DATA_DIR:path.join(fx.root,'store'), CANBAN_CODEX_HOME:fx.codexHome,CANBAN_CLAUDE_HOME:fx.claudeHome,CANBAN_CLAUDE_DESKTOP_DIR:fx.desktopDir,CANBAN_SEARCH_INDEX:'0' } });
    assert.equal(output.trim(),'ok');
  } finally { fx.cleanup(); }
});

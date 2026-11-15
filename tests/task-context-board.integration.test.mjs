import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeFixtures } from './helpers.mjs';

test('normal filtered board shares task context with a cold MCP process without calling providers or changing originals', { timeout: 20000 }, t => {
  const fx = makeFixtures(); t.after(() => fx.cleanup());
  const dir = path.join(fx.root, 'store');
  const env = { ...process.env, CANBAN_DATA_DIR: dir, CANBAN_CODEX_HOME: fx.codexHome, CANBAN_CLAUDE_HOME: fx.claudeHome, CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir, CANBAN_SEARCH_INDEX: '0', CANBAN_BACKGROUND: '0' };
  const options = { cwd: path.resolve(import.meta.dirname, '..'), env, encoding: 'utf8', timeout: 15000 };
  const log = path.join(fx.claudeHome, 'projects', '-r-web', 'c1.jsonl'), before = fs.readFileSync(log);
  const first = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {Store} from './server/store.mjs';
    import {buildBoard} from './server/board.mjs';
    const store=new Store();
    const state=await store.load();state.settings.accounts.discover=false;await store.save(state);
    const {cardId}=await store.createTask({title:'cache fixture'});
    await store.linkSession({taskId:cardId,sessionId:'claude:c1'});
    const board=await buildBoard(store,{days:0,q:'NON_MATCHING_FILTER',includeArchived:true},{readOnly:true});
    assert.equal(board.lists.flatMap(list=>list.cards).length,0);
    console.log(cardId);await store.close();process.exit(0);
  `], options).trim();
  const output = execFileSync(process.execPath, ['--no-warnings', '--import', path.resolve(import.meta.dirname, 'fixtures/stalled-claude-loader.mjs'), '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import {Store} from './server/store.mjs';
    import {taskTools} from './server/tools/tasks.mjs';
    import {stalledListingCalls} from './server/sources/claude.mjs';
    const store=new Store(),before=JSON.stringify(await store.load());
    const tool=taskTools({store}).find(tool=>tool.name==='canban_get_task');
    const task=(await tool.handler({taskId:process.argv[1]})).structured.task;
    assert.equal(task.linkedSessionContext.state,'fresh');assert.equal(task.linkedSessionContext.live,false);
    assert.equal(task.linkedSessions[0].id,'claude:c1');assert.equal(task.linkedSessions[0].agent,'claude');
    assert.equal(task.linkedSessions[0].lastAssistant,null,'old unobserved reply is never inferred');
    assert.ok(task.linkedSessions[0].title);assert.equal(stalledListingCalls,0);
    fs.rmSync(path.join(store.dir,'cache','task-context'),{recursive:true,force:true});
    const cold=(await tool.handler({taskId:process.argv[1]})).structured.task;
    assert.equal(cold.linkedSessionContext.state,'unavailable');assert.equal(stalledListingCalls,0);
    assert.equal(JSON.stringify(await store.load()),before);
    console.log('ok');await store.close();process.exit(0);
  `, first], options).trim();
  assert.equal(output, 'ok');
  assert.deepEqual(fs.readFileSync(log), before);
});

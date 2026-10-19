import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDesktopLaunches } from '../server/desktop-launch.mjs';
import { preparedCodexLink, newSessionLink } from '../server/agents.mjs';
import { prepareCodexDesktop } from '../server/codex-desktop-start.mjs';
const host={id:'remote-ssh-discovered:box',alias:'box',local:false,sshPort:2222};

test('both Desktop routes keep the same host and cwd and retry one prepared thread',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'canban-remote-ui-'));
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  const opened=[];let preparations=0;
  const service=createDesktopLaunches({dataDir,
    resolveTarget:async()=>({host,cwd:'/work/app'}),
    prepareThread:async input=>input.agent==='codex'?prepareCodexDesktop({...input,host,cwd:'/work/app'},{pool:{prepareDesktop:async()=>{preparations++;return {state:'prepared',threadId:'a50bab9a-3221-4595-b4d2-8f5a39a13117',hostId:host.id,cwd:'/work/app',writerClosed:true};}}}):null,
    open:async(input,target,thread)=>{const link=input.agent==='codex'?preparedCodexLink(thread,{prompt:input.prompt}):newSessionLink('claude',{...target,prompt:input.prompt});opened.push(new URL(link.url));return {url:link.url};}
  });
  for(const agent of ['claude','codex']) {
    const request={clientRequestId:agent,agent,prompt:'同じ場所の未送信の依頼',cwd:'/work/app',hostId:host.id};
    assert.equal((await service.start(request)).state,'opened');
    assert.equal((await service.start(request)).state,'opened');
  }
  assert.deepEqual([opened[0].searchParams.get('ssh_host'),opened[0].searchParams.get('ssh_port'),opened[0].searchParams.get('ssh_folder')],['box','2222','/work/app']);
  assert.deepEqual([opened[1].searchParams.get('hostId'),opened[1].searchParams.get('prompt')],[host.id,'同じ場所の未送信の依頼']);
  assert.equal(preparations,1);assert.equal(opened.length,2);
  assert.throws(()=>preparedCodexLink({state:'prepared',hostId:'local',threadId:'bad',writerClosed:false}),/確認|不正/);
});

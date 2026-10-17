import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSshTarget, matchDesktopTarget } from '../server/sources/ssh-targets.mjs';
const config = 'Host work\n HostName Server.example\n User Alice\n Port 2222\nHost same\n HostName server.example\n User Alice\n Port 2222\nHost other\n HostName server.example\n User Alice\n Port 22\n';
const readConfig = async file => file === '/ssh/config' ? config : '';
const resolve = x => resolveSshTarget(x,{readConfig,configFile:'/ssh/config',defaultUser:'local'});

test('same alias with different ports never matches and resolved aliases match', async () => {
  const a = await resolve({alias:'work'}), b = await resolve({alias:'same'}), c = await resolve({alias:'work',port:22});
  assert.deepEqual(a,{state:'resolved',hostname:'server.example',user:'Alice',port:2222});
  assert.deepEqual(a,b); assert.notDeepEqual(a,c);
  const match = await matchDesktopTarget({requested:{alias:'work'},claudeEnvironments:[{id:'env',account:'claude:a',sshHost:'same'}],codexHosts:[{id:'h',alias:'other'}]}, {readConfig,configFile:'/ssh/config',defaultUser:'local'});
  assert.equal(match.claudeEnvironment.id,'env'); assert.equal(match.codexHost,null);
});

test('dynamic Match and recursive Include are unknown without executing values', async () => {
  for (const text of ['Match exec "touch /tmp/never"\n HostName x','Include /ssh/config','Host *\n HostName %h','Host *\n ProxyCommand echo x']) {
    assert.equal((await resolveSshTarget({alias:'work'},{readConfig:async()=>text,configFile:'/ssh/config'})).state,'unknown');
  }
});

test('user case and ambiguous environments are preserved', async () => {
  const a=await resolve({hostname:'EXAMPLE',user:'Alice'}),b=await resolve({hostname:'example',user:'alice'});
  assert.equal(a.port,22); assert.notDeepEqual(a,b);
  const matched = await matchDesktopTarget({requested:{alias:'work'},claudeEnvironments:[{id:'e1',sshHost:'same'},{id:'e2',sshHost:'same'}],codexHosts:[]},{readConfig,configFile:'/ssh/config'});
  assert.equal(matched.state,'ambiguous');
});

test('static Includes honor first values and missing config is explicit', async () => {
  const result=await resolveSshTarget({alias:'box'},{configFile:'/ssh/config',readConfig:async file=>file==='/ssh/config'?'Include hosts\nHost *\n User later':'Host box\n HostName example\n User First',defaultUser:'local'});
  assert.deepEqual(result,{state:'resolved',hostname:'example',user:'First',port:22});
});

test('nested relative Includes stay relative to the user SSH directory', async () => {
  const files = {
    '/ssh/config': 'Include conf.d/entry',
    '/ssh/conf.d/entry': 'Include targets',
    '/ssh/targets': 'Host work\n HostName right.example\n User Alice',
    '/ssh/conf.d/targets': 'Host work\n HostName wrong.example\n User Bob',
  };
  const result = await resolveSshTarget({ alias: 'work' }, { configFile: '/ssh/config', readConfig: async file => files[file] });
  assert.deepEqual(result, { state: 'resolved', hostname: 'right.example', user: 'Alice', port: 22 });
});

test('environment IDs are scoped to the selected registered Desktop account', async t => {
  const fs = await import('node:fs/promises'), path = await import('node:path'), os = await import('node:os');
  const { claudeEnvironments } = await import('../server/sources/launch-targets.mjs');
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'canban-ssh-account-')));
  t.after(() => fs.rm(dataDir,{recursive:true,force:true}));
  const appDir=path.join(dataDir,'Claude'), id='c9b3066a-aa27-491b-8b32-7cf10ec7478f';
  const state=path.join(dataDir,'desktop-accounts','claude'), parked=path.join(state,'profiles',id);
  await fs.mkdir(appDir); await fs.mkdir(parked,{recursive:true});
  await fs.writeFile(path.join(appDir,'config.json'),JSON.stringify({lastKnownAccountUuid:'a'}));
  await fs.writeFile(path.join(parked,'config.json'),JSON.stringify({lastKnownAccountUuid:'b'}));
  await fs.writeFile(path.join(state,'registry.json'),JSON.stringify({version:1,profiles:[{id,account:'claude:b',active:false,dir:parked}]}));
  await fs.writeFile(path.join(parked,'ccd-session-presets.json'),JSON.stringify({byAccount:{b:{presets:[{id:'env',name:'B',target:{kind:'local',cwd:'/work/b'}}]}}}));
  const b=await claudeEnvironments(appDir,{dataDir,expectedAccount:'claude:b'});
  assert.equal(b.account,'claude:b');assert.equal(b.environments[0].cwd,'/work/b');
  assert.equal((await claudeEnvironments(appDir,{dataDir,expectedAccount:'claude:other'})).environments.length,0);
});

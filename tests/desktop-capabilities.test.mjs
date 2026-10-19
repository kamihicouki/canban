import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readDesktopCapabilities } from '../server/desktop-capabilities.mjs';
import { backupDesktopProfiles } from '../server/desktop-backup.mjs';

test('unverified or changed app builds never advertise Desktop switching', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(),'canban-capabilities-'));
  t.after(() => fs.rm(dataDir,{recursive:true,force:true}));
  const builds = {claude:'build-a',codex:'build-b'};
  assert.equal((await readDesktopCapabilities(dataDir,{builds,platform:'darwin'})).accountSwitch,false);
  await fs.writeFile(path.join(dataDir,'desktop-capabilities.json'), JSON.stringify({version:1,builds,accountSwitch:{verified:true,roundTrips:3,relogins:0,logouts:0,cliPreserved:true,desktopPreserved:true,draftsPreserved:true}}),{mode:0o600});
  assert.equal((await readDesktopCapabilities(dataDir,{builds,platform:'darwin'})).accountSwitch,true);
  assert.equal((await readDesktopCapabilities(dataDir,{builds:{...builds,claude:'updated'},platform:'darwin'})).accountSwitch,false);
});

test('backup preserves the original profiles and private recovery locations', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(),'canban-desktop-backup-'));
  t.after(() => fs.rm(dataDir,{recursive:true,force:true}));
  const id='a8bfe577-dbc8-48be-9aee-6d0d5ec04623', dir=path.join(dataDir,'original');
  await fs.mkdir(dir); await fs.writeFile(path.join(dir,'draft'),'保存済みの下書き');
  const snapshot = await backupDesktopProfiles({dataDir,requestId:'backup-1',profiles:[{id,dir,account:'claude:a'}]});
  assert.equal(await fs.readFile(path.join(snapshot,id,'draft'),'utf8'),'保存済みの下書き');
  assert.equal(await fs.readFile(path.join(dir,'draft'),'utf8'),'保存済みの下書き');
  assert.equal((await fs.stat(snapshot)).mode & 0o777,0o700);
});

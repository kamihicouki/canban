import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { SlackStore } from '../server/slack-store.mjs';
import { SlackService, SlackApi, slackTools } from '../server/slack.mjs';
import { slackMessage, safeSlackUrl, SLACK_CACHE_MS } from '../server/slack-model.mjs';

const workspace = { id: 'T1', name: '架空のチーム', url: 'https://example.slack.com/', userId: 'U1', channels: [] };
const channel = { id: 'C1', name: '依頼', directory: '__none' };
const message = (text = '見積もりをお願いします', extra = {}) => slackMessage(workspace, channel, { ts: '1791200000.000001', user: 'U1', text, ...extra });
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canban-slack-')), store = new Store(dir), db = new SlackStore(dir);
  await store.load(); await db.saveWorkspace(workspace); await db.selectChannels({ workspaceId: 'T1', channels: [channel] });
  t.after(async () => { await store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, store, db };
}
const leader = () => ({ isLeader: true, token: null, async run(fn) { return this.isLeader ? fn() : undefined; } });
class Socket {
  static instances = [];
  constructor(url) { this.url = url; this.events = {}; this.sent = []; Socket.instances.push(this); }
  addEventListener(type, fn) { this.events[type] = fn; }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.closed = true; }
}

test('atomic card creation, duplicate references, many cards, and orphan retention', async t => {
  const { store, db } = await fixture(t), m = message(); await db.cache({ team:'T1', channel:'C1', messages:[m] });
  const a = await store.createTask({ title: '編集したタイトル', description: '編集した説明', slackSource: m.key });
  const b = await store.createTask({ title: '別の仕事' });
  await store.linkSlack({ cardId:a.cardId, key:m.key }); await store.linkSlack({ cardId:b.cardId, key:m.key });
  assert.equal((await db.view()).messages[0].refs.length,2);
  assert.equal((await db.sources(a.cardId))[0].versions,1);
  await assert.rejects(store.createTask({ title:'失敗する作成', slackSource:'T1:C1:1791200001.000001' }), /再取得/);
  assert.equal(Object.values((await store.load()).cards).filter(c=>c.kind==='task').length,2);
  await db.observe({ message:message('修正済み', { edited:{ ts:'1791200010.000001' } }), eventAt:'1791200011.000001' });
  const card = (await store.load()).cards[a.cardId]; assert.equal(card.title,'編集したタイトル'); assert.equal(card.description,'編集した説明');
  await assert.rejects(db.forget(m.key), /紐づけ/);
  await store.unlinkSlack({ cardId:a.cardId, key:m.key }); await store.unlinkSlack({ cardId:b.cardId, key:m.key });
  await db.observe({ message:message('外した後の変更', { edited:{ ts:'1791200020.000001' } }), eventAt:'1791200021.000001' });
  assert.equal((await db.retained())[0].text,'修正済み'); assert.equal((await db.retained())[0].versions,2);
  await db.forget(m.key); assert.equal((await db.retained()).length,0); assert.equal((await db.revisions({key:m.key})).revisions.length,0);
});

test('out-of-order/duplicate events and stale history do not regress or resurrect deleted text', async t => {
  const { store, db } = await fixture(t), m=message(); await db.cache({team:'T1',channel:'C1',messages:[m]});
  const card=await store.createTask({title:'依頼',slackSource:m.key});
  const edit=message('新しい本文',{edited:{ts:'1791200020.000001'}});
  await db.observe({message:edit,eventAt:'1791200021.000001'}); await db.observe({message:edit,eventAt:'1791200021.000001'});
  await db.observe({message:message('古い本文',{edited:{ts:'1791200010.000001'}}),eventAt:'1791200011.000001'});
  await db.cache({team:'T1',channel:'C1',messages:[m]});
  assert.equal((await db.view()).messages[0].text,'新しい本文'); assert.equal((await db.sources(card.cardId))[0].versions,2);
  await db.observe({message:{key:m.key,team:m.team,channel:m.channel,ts:m.ts,deleted:true},reason:'削除',eventAt:'1791200030.000001'});
  await db.cache({team:'T1',channel:'C1',messages:[edit]});
  const source=(await db.sources(card.cardId))[0]; assert.equal(source.deleted,true);assert.equal(source.text,'新しい本文');assert.equal(source.versions,3);
  assert.equal((await db.view()).messages[0].deleted,true);
  // Missing history alone never proves deletion.
  await db.cache({team:'T1',channel:'C1',messages:[]});assert.equal((await db.sources(card.cardId))[0].versions,3);
});

test('history loads 25 revisions at a time; unlinked messages have no saved revisions', async t => {
  const {store,db}=await fixture(t),m=message();await db.cache({team:'T1',channel:'C1',messages:[m]});
  assert.equal((await db.retained()).length,0); const card=await store.createTask({title:'依頼',slackSource:m.key});
  for(let i=1;i<=30;i++) await db.observe({message:message(`版${i}`,{edited:{ts:`17912000${String(i).padStart(2,'0')}.000001`}}),eventAt:`17912000${String(i).padStart(2,'0')}.000002`});
  const head=(await db.sources(card.cardId))[0];assert.equal(head.versions,31);assert.equal(head.revisions,undefined);
  const first=await db.revisions({key:m.key});assert.equal(first.revisions.length,25);assert.equal(first.revisions[0].text,'版30');
  const second=await db.revisions({key:m.key,before:first.before});assert.equal(second.revisions.length,6);assert.equal(second.revisions.at(-1).text,m.text);
});

test('Socket Mode persists before ACK, routes teams, deduplicates connection, and stops on leader loss', async t => {
  const {dir,store,db}=await fixture(t), calls=[];
  const api={async call(token,method){calls.push(method);return {url:'wss://wss-primary.slack.com/socket'};}};
  const service=new SlackService(store,{api,Socket});t.after(()=>service.stop());service.leader=leader();
  await service.saveCredentials('T1',{userToken:'xoxp-test',appToken:'xapp-test'});
  await db.saveWorkspace({...workspace,id:'T2'});await service.saveCredentials('T2',{userToken:'xoxp-other',appToken:'xapp-test'});
  await db.cache({team:'T1',channel:'C1',messages:[message()]});await service.tick();assert.equal(calls.filter(m=>m==='apps.connections.open').length,1);
  const socket=[...service.sockets.values()][0];socket.events.message({data:JSON.stringify({type:'events_api',envelope_id:'e1',payload:{team_id:'T1',event:{type:'message',channel:'C1',ts:'1791200090.000001',text:'到着',user:'U1'}}})});
  assert.equal(socket.sent.length,0);await service.eventQueue;assert.equal(socket.sent[0].envelope_id,'e1');assert.ok((await db.view()).messages.some(m=>m.text==='到着'));
  service.leader.isLeader=false;await service.tick();assert.equal(service.sockets.size,0);assert.equal(socket.closed,true);
  assert.equal((await fs.stat(service.credentialsFile)).mode & 0o777,0o600);
  assert.equal(JSON.stringify(await db.view()).includes('xoxp'),false);
});

test('bounded startup cache retrieval, no active repeated polling, and no socket after stopping in-flight open', async t => {
  const {store,db}=await fixture(t),calls=[];
  await db.selectChannels({workspaceId:'T1',channels:[channel,{id:'C2',name:'二'},{id:'C3',name:'三'}]});
  const api={async call(token,method){calls.push(method);return method==='apps.connections.open'?{url:'wss://wss-primary.slack.com/socket'}:{messages:[]};}};
  const service=new SlackService(store,{api,Socket});t.after(()=>service.stop());service.leader=leader();await service.saveCredentials('T1',{userToken:'xoxp-test',appToken:'xapp-test'});
  await service.tick();assert.equal(calls.filter(m=>m==='conversations.history').length,2);
  await service.tick();assert.equal(calls.filter(m=>m==='conversations.history').length,3);
  await service.tick();assert.equal(calls.filter(m=>m==='conversations.history').length,3);
  service.closeSockets();let done;service.api={call:()=>new Promise(resolve=>{done=resolve;})};
  const opening=service.openSocket('new','xapp-test');service.stop();done({url:'wss://wss-primary.slack.com/socket'});await opening;assert.equal(service.sockets.size,0);
});

test('read-only API honors 429 cooldown and refuses write methods', async () => {
  let calls=0,now=1;const api=new SlackApi({now:()=>now,fetcher:async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'120'}});}});
  await assert.rejects(api.call('secret','chat.postMessage'), /読み取り専用/);
  await assert.rejects(api.call('secret','conversations.history'), /取得制限/);
  await assert.rejects(api.call('secret','conversations.history'), /120秒/);assert.equal(calls,1);
  now=120002;await assert.rejects(api.call('secret','conversations.history'), /取得制限/);assert.equal(calls,2);
});

test('normalizes provenance/file links without downloads and isolates equal timestamps across workspaces', () => {
  const m=message('&lt;request&gt; &amp;',{files:[{title:'資料',permalink:'https://example.slack.com/files/F1'},{title:'unsafe',permalink:'javascript:alert(1)'}]});
  assert.equal(m.text,'<request> &');assert.equal(m.files.length,1);assert.match(m.url,/archives\/C1\/p1791200000000001/);
  assert.notEqual(m.key,slackMessage({...workspace,id:'T2'},channel,{ts:m.ts}).key);assert.equal(safeSlackUrl('https://slack.com.evil.test/'),null);
});


test('old pages remain available and remote session IDs can receive a source', async t => {
  const {store,db}=await fixture(t);
  const recent=Array.from({length:500},(_,i)=>message(`recent ${i}`,{ts:`179120${String(i).padStart(4,'0')}.000001`}));
  await db.cache({team:'T1',channel:'C1',messages:recent});
  const old=message('昔の依頼',{ts:'1780000000.000001'});await db.cache({team:'T1',channel:'C1',messages:[old],append:true});
  assert.ok((await db.view({workspaceId:'T1',channelId:'C1'})).messages.some(m=>m.key===old.key));
  await store.linkSlack({cardId:'codex@box:session',key:old.key});assert.equal((await db.sources('codex@box:session')).length,1);
});


test('adding another workspace to an already open shared socket routes its events', async t => {
  const {store,db}=await fixture(t),api={async call(token,method){return {url:'wss://wss-primary.slack.com/socket',messages:[]};}};
  const service=new SlackService(store,{api,Socket});service.leader=leader();t.after(()=>service.stop());
  await service.saveCredentials('T1',{userToken:'xoxp-one',appToken:'xapp-shared'});await service.tick();const socket=[...service.sockets.values()][0];
  const second={...workspace,id:'T2'};await db.saveWorkspace(second);await db.selectChannels({workspaceId:'T2',channels:[channel]});
  await service.saveCredentials('T2',{userToken:'xoxp-two',appToken:'xapp-shared'});await service.tick();assert.equal(service.sockets.size,1);
  socket.events.message({data:JSON.stringify({type:'events_api',envelope_id:'team2',payload:{team_id:'T2',event:{type:'message',channel:'C1',ts:'1791200099.000001',text:'別のワークスペース'}}})});
  await service.eventQueue;assert.equal((await db.view({workspaceId:'T2'})).messages[0].text,'別のワークスペース');
  await service.disconnect({workspaceId:'T2'});assert.equal((await service.credentials()).T2,undefined);assert.equal((await db.getConfig()).workspaces.length,1);
});


test('private credential storage recovers a dead stale lock without leaking tokens to SQLite', async t => {
  const {store,db}=await fixture(t),service=new SlackService(store),dir=path.dirname(service.credentialsFile);
  await fs.mkdir(dir,{recursive:true,mode:0o755});const lock=path.join(dir,'credentials.lock');await fs.writeFile(lock,'999999999');await fs.utimes(lock,new Date(0),new Date(0));
  await service.saveCredentials('T1',{userToken:'xoxp-fake',appToken:'xapp-fake'});
  assert.equal((await fs.stat(dir)).mode & 0o777,0o700);assert.equal((await service.credentials()).T1.userToken,'xoxp-fake');
  assert.equal(JSON.stringify(await db.view()).includes('xoxp-fake'),false);await assert.rejects(fs.stat(lock),{code:'ENOENT'});
});


test('relink after cache eviction appends a revision without overwriting saved history', async t => {
  const {store,db}=await fixture(t),m=message();await db.cache({team:'T1',channel:'C1',messages:[m]});
  const card=await store.createTask({title:'依頼',slackSource:m.key});
  await db.cache({team:'T1',channel:'C1',messages:Array.from({length:500},(_,i)=>message('new',{ts:`179120${String(i+1).padStart(4,'0')}.000001`}))});
  await db.cache({team:'T1',channel:'C1',messages:[m],append:true});
  await db.observe({message:message('第2版',{edited:{ts:'1791209000.000001'}}),eventAt:'1791209000.000002'});
  await store.unlinkSlack({cardId:card.cardId,key:m.key});
  await db.observe({message:message('第3版',{edited:{ts:'1791209001.000001'}}),eventAt:'1791209001.000002'});
  await store.linkSlack({cardId:card.cardId,key:m.key});
  assert.equal((await db.sources(card.cardId))[0].versions,3);
  assert.deepEqual((await db.revisions({key:m.key})).revisions.map(r=>r.text),['第3版','第2版',m.text]);
});

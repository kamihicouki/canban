import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const model = fs.readFileSync(new URL('../ui/lifetime-model.js', import.meta.url), 'utf8');
const groups = fs.readFileSync(new URL('../ui/lifetime.js', import.meta.url), 'utf8').split('const TIMELINE_GROUP_CAP =')[1];
const m = vm.runInNewContext(model + '\nconst TIMELINE_GROUP_CAP =' + groups + '\n({workOverview,workAttention,workGroupOf,timelineGroups});');
const plain = x => JSON.parse(JSON.stringify(x));
test('human work list remains separate from completed agent responses', () => {
  const card = {kind:'task', description:'目的を明確にする。次の文。', links:[{status:'completed',last:{role:'assistant',text:'レビュー待ち',time:10}}]};
  const info=m.workOverview(card);
  assert.equal(info.purpose,'目的を明確にする。');
  assert.match(info.summary,/応答済み1/);
  assert.doesNotMatch(info.current,/完了/);
  assert.equal(info.next,'次の行動は未記入');
  assert.equal(m.workGroupOf(card,{title:'進行中'}),'live');
});
test('work attention shows observed reasons and never infers unknown completion', () => {
  assert.equal(m.workAttention({kind:'task',links:[{status:'waiting',statusKnown:false}]}),'');
  assert.equal(m.workAttention({kind:'task',links:[{requests:{queued:2,paused:true}}]}),'依頼が停止');
  assert.equal(m.workAttention({kind:'task',links:[{unread:true}]}),'返答あり');
  assert.match(m.workOverview({kind:'task',links:[{statusKnown:false}]}).current,/未取得1/);
});
test('reported next action is a proposal with observed author and time', () => {
  const info=m.workOverview({kind:'task',handoff:{nextAction:{text:'差分を確認する',source:'reported',sourceSessionId:'claude:test',at:10}}});
  assert.equal(info.next,'差分を確認する'); assert.equal(info.nextSource,'Claude（指定）の提案'); assert.equal(info.nextAt,10);
});
test('all work appears before standalone conversations and duplicate sessions stay out', () => {
  const board={lists:[{id:'work',title:'進行中',cards:[{id:'repeat',automation:true,updatedAt:20},{id:'task',kind:'task',links:[],updatedAt:1}]},{id:'in',isDefault:true,name:'受信箱',cards:[{id:'unset',kind:'task',links:[],updatedAt:2}]}]};
  const result=plain(m.timelineGroups(board));
  assert.deepEqual(result.map(g=>g[3]),['need','live','missing','other','unbundled']);
  assert.equal(result[1][1][0].card.id,'task'); assert.equal(result[2][1][0].card.id,'unset'); assert.equal(result[4][1][0].card.id,'repeat');
});

test('independent sessions needing attention or running remain outside the unbundled fold', () => {
  for (const card of [{status:'waiting'},{unread:true},{requests:{paused:true,queued:1}},{status:'aborted'}]) assert.equal(m.workGroupOf(card,{}),'need');
  assert.equal(m.workGroupOf({status:'running'},{}),'live');
  assert.equal(m.workGroupOf({status:'completed'},{}),'unbundled');
});

test('ISO report/message timestamps become numeric for sorting and relative display; paused-only state stays visible', () => {
  const at='2026-11-15T01:02:03.000Z';
  const info=m.workOverview({kind:'task',handoff:{nextAction:{text:'確認',source:'reported',at}},links:[{agent:'claude',last:{role:'assistant',text:'古い返答',at:'2026-11-14T01:00:00Z'}},{agent:'codex',last:{role:'assistant',text:'新しい返答',at}}]});
  assert.equal(info.nextAt,Date.parse(at));assert.equal(info.currentAt,Date.parse(at));assert.match(info.current,/新しい返答/);
  assert.equal(m.workAttention({requests:{paused:true,queued:0}}),'依頼が停止');
});

test('unspecified report source is never attributed to an agent', () => {
 const info=m.workOverview({kind:'task',handoff:{nextAction:{text:'確認する',source:'reported',at:10}}});
 assert.equal(info.nextSource,'報告者の提案（報告元未指定）');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { boardHtml } from '../server/ui.mjs';

const source = fs.readFileSync(new URL('../ui/workspace-model.js', import.meta.url), 'utf8');
const model = new vm.Script(source + '\n({workspacePage, usageWindow, paneGeometry})').runInNewContext();
const plain = value => JSON.parse(JSON.stringify(value));

test('workspace routes preserve old home and analytics fallbacks', () => {
  assert.equal(model.workspacePage('usage'), 'usage');
  assert.equal(model.workspacePage('unknown', 'analytics'), 'analytics');
  assert.equal(model.workspacePage(null), 'home');
});
test('a single fixed card fills the available height with twelve-pixel margins', () => {
  const p = model.paneGeometry([{index:0,w:900,h:450,note:false}], 'grid', 1300, 850);
  assert.deepEqual(plain(p.rects), [{index:0,x:200,y:12,h:826}]);
  assert.equal(p.height,850);
});
test('two columns share the full height while notes stay compact', () => {
  const p = model.paneGeometry([{index:0,w:560,h:450,note:false},{index:1,w:560,h:100,note:true}], 'grid', 1300, 850);
  assert.equal(p.rects[0].h,826); assert.equal(p.rects[1].h,100);
});
test('grid rows distribute height and scroll if minimum readable height cannot fit', () => {
  const items = [0,1].map(index => ({index,w:900,h:450,note:false}));
  const fit = model.paneGeometry(items,'grid',1000,850);
  assert.equal(fit.rects[0].h,407); assert.equal(fit.rects[1].h,407);
  assert.equal(fit.height,850);
  const scroll = model.paneGeometry(items,'grid',1000,500);
  assert.ok(scroll.height>500); assert.ok(scroll.rects.every(r=>r.h>=320));
});
test('column layout gives each card viewport height and row layout can scroll horizontally', () => {
  const items=[0,1].map(index=>({index,w:700,h:500,note:false}));
  const col=model.paneGeometry(items,'col',1000,600);
  assert.equal(col.rects[0].h,576); assert.equal(col.rects[1].h,576); assert.ok(col.height>600);
  const row=model.paneGeometry(items,'row',1000,600); assert.ok(row.width>1000);
});
test('tiny containers never create negative card geometry', () => {
  const p=model.paneGeometry([{index:0,w:20,h:10,note:false}],'grid',10,10);
  assert.ok(p.rects[0].h>=0);
});
test('usage separates used and remaining amounts and names the limit window', () => {
  const now=1790760000000;
  const value=model.usageWindow({usedPercent:55,windowMinutes:10080,resetsAt:now+86400000},now,now);
  assert.deepEqual(plain(value),{label:'週間枠',used:55,remaining:45,stale:false,resetsAt:now+86400000});
});
test('expired and stale snapshots do not become zero or full allowance', () => {
  const now=1790760000000;
  for (const [window,at] of [
    [{usedPercent:0,stale:true,windowMinutes:300},now],
    [{usedPercent:55,windowMinutes:300,resetsAt:now-1},now],
    [{usedPercent:55,windowMinutes:300},now-900001],
    [{usedPercent:55,windowMinutes:300},null],
  ]) {
    const v=model.usageWindow(window,at,now);assert.equal(v.stale,true);assert.equal(v.remaining,null);assert.equal(v.used,null);
  }
});
test('missing and invalid usage stays unknown', () => {
  assert.equal(model.usageWindow(null,Date.now()),null);
  assert.equal(model.usageWindow({usedPercent:101},Date.now()),null);
  assert.equal(model.usageWindow({usedPercent:'55'},Date.now()),null);
});
test('MCP UI includes feature modules and still compiles as one self-contained script', () => {
  const html=boardHtml({version:'0.14.1'});
  assert.doesNotMatch(html,/@include/);
  assert.match(html,/const workspace =/);
  assert.match(html,/Canbanの画面/);
  assert.equal([...html.matchAll(/<script>/g)].length,1);
  assert.equal([...html.matchAll(/<style>/g)].length,1);
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
});

test('explicit shared-state reload keeps edited forms and open panes', async () => {
  const html = boardHtml();
  const source = html.slice(html.indexOf('async function applySharedUi('), html.indexOf('async function reloadSharedUi('));
  let closed = 0, adopted = 0, warned = 0;
  const context = vm.createContext({
    hasUnsavedPaneInput: () => true, toast: () => warned++,
    panes: [{ id: 'codex:test' }], closePane: () => closed++,
    adoptSharedUi: () => adopted++, sharedUi: {},
  });
  await vm.runInContext(`${source}\napplySharedUi({state:{view:'board'}});`, context);
  assert.equal(closed,0); assert.equal(adopted,0); assert.equal(warned,1);
});

test('account rings show unknown when the recorded window has expired', () => {
  const src = fs.readFileSync(new URL('../ui/accounts.js', import.meta.url), 'utf8');
  const ring = src.slice(src.indexOf('function ringFor('), src.indexOf('function renderUsage('));
  const now = Date.now();
  const context = vm.createContext({
    usageWindows: l => [l.primary,l.secondary].filter(Boolean), usageWindow: model.usageWindow,
    usageTitle: () => '要更新', heat: () => 'green', colorVar: () => 'blue',
    h: (tag, attrs, ...children) => ({tag,attrs,children}),
  });
  const result = vm.runInContext(`${ring}\nringFor({agent:'claude',label:'確認',short:'確',color:'blue',limits:{at:${now},primary:{usedPercent:90,windowMinutes:300,resetsAt:${now-1}}}});`,context);
  assert.match(result.attrs.class,/no-a/);
  assert.match(result.attrs.class,/old/);
});

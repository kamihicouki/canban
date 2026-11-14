import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const text=fs.readFileSync(new URL('../ui/requests.js',import.meta.url),'utf8');
const view=vm.runInNewContext(text.slice(text.indexOf('function dispatchPermissionView('),text.indexOf('function renderDispatch('))+'\ndispatchPermissionView');
test('fallback policy never presents a restrictive default as observed session permission',()=>{
 const unknown=view({source:'fallback',label:'read-only / 承認なし',elevated:false});
 assert.match(unknown.text,/未取得/);assert.doesNotMatch(unknown.text,/read-only/);assert.match(unknown.title,/元のセッションの権限を確認できた意味ではありません/);
 assert.match(view(null,true).text,/リモートで確認/);
 assert.match(view({source:'session',label:'workspace-write',elevated:false}).text,/workspace-write/);
 assert.match(view({source:'database',label:'danger-full-access',elevated:true}).text,/制限なし/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import { uploadImage, readPromptImageChunk } from '../server/prompt-input.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/9l0AAAAASUVORK5CYII=','base64');
const fixture=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canban-preview-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
const upload=(dir,bytes=png)=>{let result;for(let offset=0;offset<bytes.length;offset+=128*1024)result=uploadImage(dir,{...(result?{id:result.id}:{name:'photo.png',mime:'image/png',size:bytes.length}),offset,data:bytes.subarray(offset,offset+128*1024).toString('base64')});return result.id;};

test('bounded image chunks reconstruct the validated hash and reject invalid ranges or generations',t=>{
  const dir=fixture(t),bytes=Buffer.concat([png,Buffer.alloc(400000)]),id=upload(dir,bytes);
  for(const args of [{offset:-1},{offset:bytes.length+1},{maxBytes:128*1024+1},{maxBytes:0},{offset:1}])assert.throws(()=>readPromptImageChunk(dir,{id,...args}));
  const chunks=[];let offset=0,sha256;
  do {const part=readPromptImageChunk(dir,{id,offset,expectedSha256:sha256});sha256=part.sha256;assert.ok(part.nextOffset-offset<=128*1024);chunks.push(Buffer.from(part.data,'base64'));offset=part.nextOffset;}while(offset<bytes.length);
  assert.equal(createHash('sha256').update(Buffer.concat(chunks)).digest('hex'),sha256);
  fs.writeFileSync(path.join(dir,'prompt-images',id+'.png'),'changed');
  assert.throws(()=>readPromptImageChunk(dir,{id,offset:1,expectedSha256:sha256}));
});
function harness(dir) {
  class Element {constructor(tag,attrs={},...children){Object.assign(this,{tag,children:children.flat().filter(Boolean),dataset:{},value:'',events:{},isConnected:true},attrs);}append(...x){this.children.push(...x.filter(Boolean));}replaceChildren(...x){this.children=x.filter(Boolean);}addEventListener(k,fn){(this.events[k]||=[]).push(fn);}setAttribute(k,v){this[k]=v;}focus(){}}
  const revoked=[],urls=[],calls=[];
  const bridge={async callTool(name,args){calls.push({name,args});return {result:readPromptImageChunk(dir,args)};}};
  const context=vm.createContext({h:(tag,attrs,...children)=>new Element(tag,attrs,...children),picon:()=>'',bridge,crypto:webcrypto,atob,Uint8Array,Blob,URL:{createObjectURL:()=>{const url='blob:'+urls.length;urls.push(url);return url;},revokeObjectURL:url=>revoked.push(url)}});
  vm.runInContext(fs.readFileSync(new URL('../ui/prompt-composer.js',import.meta.url),'utf8')+'\nglobalThis.create=promptComposer',context);
  const create=()=>context.create(new Element('textarea'),{key:'shared',context:()=>({agent:'codex'})});
  return {create,revoked,urls,calls,bridge};
}
test('restored draft gets shared thumbnails without reupload and clears owned URLs',async t=>{
  const dir=fixture(t),id=upload(dir),h=harness(dir),a=h.create();
  await a.restore({prompt:'元の依頼',images:[{id,name:'photo.png',mime:'image/png'}]});
  assert.equal(a.draft.images[0].preview,'blob:0');assert.equal(h.calls[0].name,'canban_read_prompt_image');
  a.root.isConnected=false;const b=h.create();assert.equal(b.draft.images[0].preview,'blob:0');assert.equal(h.revoked.length,0);
  b.clear();assert.deepEqual(h.revoked,['blob:0']);assert.equal(h.urls.length,1);
});
test('late preview results never restore a cleared draft',async t=>{
  const dir=fixture(t),id=upload(dir),h=harness(dir),a=h.create();let finish;
  h.bridge.callTool=()=>new Promise(resolve=>{finish=resolve;});
  const pending=a.restore({images:[{id}]});a.clear();finish({result:readPromptImageChunk(dir,{id})});await pending;
  assert.equal(a.draft.images.length,0);assert.equal(h.urls.length,0);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SearchIndex} from '../server/search.mjs';

test('strict body search distinguishes an absent or unreadable index from a genuine empty result',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canban-search-complete-')),index=new SearchIndex(dir);
  try{
    assert.deepEqual(index.query('query'),[],'legacy callers retain their empty-index behavior');
    assert.throws(()=>index.query('query',300,{strict:true}),/索引.*作成/);
    const db=index.open();
    assert.deepEqual(index.query('query',300,{strict:true}),[],'a readable empty index is a real zero');
    db.exec('DROP TABLE docs');
    assert.deepEqual(index.query('query'),[]);
    assert.throws(()=>index.query('query',300,{strict:true}),/no such table/);
  }finally{index.db?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

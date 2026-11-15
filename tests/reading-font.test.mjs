import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {boardHtml} from '../server/ui.mjs';
test('board carries an offline Japanese reading font without another network request',()=>{
 const html=boardHtml();
 const face=html.match(/@font-face\s*\{[^}]*font-family:\s*"Canban Noto Sans JP"[^}]*\}/s)?.[0];
 assert.ok(face,'offline reading font is absent');
 assert.match(face,/font-display:\s*swap/);
 const encoded=face.match(/base64,([A-Za-z0-9+/=]+)/)?.[1];
 assert.ok(encoded,'font must travel with the self-contained MCP resource');
 assert.equal(Buffer.from(encoded,'base64').subarray(0,4).toString(),'wOF2');
 assert.equal((html.match(/<style>/g)||[]).length,1);
 assert.equal((html.match(/<script>/g)||[]).length,1);
});
test('Chrome distribution includes the embedded font license',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canban-reading-font-'));
 try{
  execFileSync(process.execPath,['scripts/build-chrome.mjs','--outdir',dir]);
  const license=fs.readFileSync(path.join(dir,'NotoSansJP-OFL.txt'),'utf8');
  assert.match(license,/SIL OPEN FONT LICENSE/);
  assert.ok(fs.readFileSync(path.join(dir,'noto-sans-jp.woff2')).equals(fs.readFileSync('assets/fonts/noto-sans-jp.woff2')));
  const css=fs.readFileSync(path.join(dir,'board.css'),'utf8');assert.match(css,/url\(noto-sans-jp\.woff2\)/);assert.doesNotMatch(css,/data:font/);
  assert.equal(license,fs.readFileSync('assets/fonts/OFL.txt','utf8'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

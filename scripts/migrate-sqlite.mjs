#!/usr/bin/env node
// Explicit offline migration/export. Never import live legacy files at server startup.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { dataDir, normalize, defaultState } from '../server/store.mjs';
import { canonicalDataDirectory } from '../server/data-directory.mjs';
import { openDatabase, db, transaction, writeBoard, writeRequests, readBoard, readRequests, readTransaction, alive, SCHEMA_VERSION } from '../server/sqlite-backend.mjs';
const args = process.argv.slice(2);
const index = args.indexOf('--data-dir');
const dir = path.resolve(index >= 0 ? args[index+1] : dataDir());
const apply = args.includes('--apply'), exporting = args.includes('--export');
function read(name, fallback) { const file=path.join(dir,name); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : fallback; }
function activeServers() {
  const rows = execFileSync('ps',['-axo','pid=,command='],{encoding:'utf8'}).split('\n');
  return rows.filter((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match || !/server\/index\.mjs|scripts\/chrome-native-host\.mjs/.test(match[2])) return false;
    const pid = match[1];
    let canban = /canban\/(?:[^/\s]+\/)*(?:server\/index|scripts\/chrome-native-host)\.mjs/.test(match[2]);
    if (!canban) {
      try {
        const cwd = execFileSync('lsof',['-a','-p',pid,'-d','cwd','-Fn'],{encoding:'utf8'}).split('\n').find(l=>l.startsWith('n'))?.slice(1);
        canban = cwd && JSON.parse(fs.readFileSync(path.join(cwd,'package.json'),'utf8')).name === 'canban';
      } catch { return dir === path.resolve(dataDir()); }
    }
    if (!canban) return false;
    // Inspect only candidate processes; never print their environment.
    try {
      const environment = execFileSync('ps',['eww','-p',pid,'-o','command='],{encoding:'utf8'});
      const custom = environment.trim().match(/(?:^|\s)CANBAN_DATA_DIR=(.*?)(?=\s[A-Za-z_][A-Za-z0-9_]*=|$)/)?.[1];
      return canonicalDataDirectory(custom || path.join(os.homedir(),'.canban')) === canonicalDataDirectory(dir);
    } catch { return alive(Number(pid)); } // A vanished process is stopped; an unknown live target blocks migration.
  });
}

try {
  const running = activeServers();
  if (running.length) throw new Error(`Canbanサーバーが${running.length}個動いています。各アプリのCanbanを停止してから実行してください。`);
  const file=path.join(dir,'canban.sqlite');
  let initialized=false;
  if (fs.existsSync(file)) {
    const existing=new DatabaseSync(file,{readOnly:true});
    try {
      const tables=existing.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
      if(tables.includes('instances') && existing.prepare('SELECT pid FROM instances').all().some((row) => alive(row.pid))) throw new Error('SQLiteを使用中のCanbanサーバーがあります。停止してから実行してください。');
      initialized=tables.includes('metadata') && !!existing.prepare("SELECT 1 FROM metadata WHERE key='initialized'").get();
    } finally { existing.close(); }
  }
  if (initialized && apply && !exporting) { process.stdout.write('移行済みです。JSONは再取り込みしません。\n'); process.exit(0); }
  if (!apply) {
    process.stdout.write(JSON.stringify({action:exporting?'export':'migrate',dir,databaseExists:fs.existsSync(file),schema:SCHEMA_VERSION,stopped:true},null,2)+'\n');
    process.exit(0);
  }
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  if (exporting) {
    if (!fs.existsSync(file)) throw new Error('書き出すSQLite DBがありません');
    openDatabase(dir,{migration:true});
    const {board,requests}=readTransaction(() => ({board:readBoard(),requests:readRequests()}));
    const out=path.join(dir,`export-${Date.now()}`); fs.mkdirSync(out,{mode:0o700});
    for(const [name,value] of [['board.json',board],['requests.json',requests]]) fs.writeFileSync(path.join(out,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
    db().close(); process.stdout.write(`最新状態を書き出しました: ${out}\n`); process.exit(0);
  }
  const board=normalize(read('board.json',defaultState()));
  const requests=read('requests.json',{requests:[],paused:{}});
  if (!Array.isArray(requests.requests) || !requests.paused || typeof requests.paused !== 'object') throw new Error('送信履歴の形式が正しくありません');
  const backup=path.join(dir,`backup-before-sqlite-${Date.now()}`); fs.mkdirSync(backup,{mode:0o700});
  for(const name of ['board.json','requests.json','status.json']) if(fs.existsSync(path.join(dir,name))) { fs.copyFileSync(path.join(dir,name),path.join(backup,name)); fs.chmodSync(path.join(backup,name),0o600); }
  openDatabase(dir,{migration:true});
  if (db().prepare("SELECT 1 FROM metadata WHERE key='initialized'").get()) { db().close(); process.stdout.write('移行済みです。JSONは再取り込みしません。\n'); process.exit(0); }
  for(const request of requests.requests) if(['starting','running'].includes(request.state)) {
    request.state='interrupted'; request.endedAt=Date.now(); request.error='移行時に実行状況を確認できなかったため停止しました'; request.reasonCode='migration_interrupted'; request.needsUserAction=true;
    requests.paused[request.cardId]={at:Date.now(),reason:request.error};
  }
  transaction(() => {
    writeBoard(board); writeRequests(requests);
    const rules=read('status.json',null);
    if(rules) db().prepare('INSERT OR REPLACE INTO auxiliary VALUES(?,?)').run('rules',JSON.stringify(rules));
    db().prepare("INSERT INTO metadata VALUES('initialized','1')").run();
  });
  db().close(); process.stdout.write(`SQLiteへ移行しました。バックアップ: ${backup}\n`);
} catch(error) { process.stderr.write(`${error.message}\n`); process.exitCode=1; }

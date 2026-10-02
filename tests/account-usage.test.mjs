import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { codexSnapshot, claudeSnapshot, codexUsage, claudeUsage } from '../server/account-usage.mjs';
import { claudeKeychainService, claudeCredentials } from '../server/account-credentials.mjs';

let root, codex, claude, fake;
const write = (file, value) => fs.writeFile(file, JSON.stringify(value));
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'canban-usage-'));
  codex = { dir: path.join(root, 'codex'), default: false }; claude = { dir: path.join(root, 'claude'), default: false };
  await fs.mkdir(codex.dir); await fs.mkdir(claude.dir);
  await write(path.join(codex.dir, 'auth.json'), { tokens: { account_id: 'a', access_token: 'PRIVATE-TOKEN' } });
  await write(path.join(claude.dir, '.claude.json'), { oauthAccount: { accountUuid: 'b' } });
  fake = path.join(root, 'fake-appserver.mjs');
  await fs.writeFile(fake, `import readline from 'node:readline';
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line); if(!m.id)return; const mode=process.argv[2]; if(mode==='timeout')return;
      let result = m.method==='account/read'?{account:{type:mode==='apikey'?'apiKey':'chatgpt'}}:m.method==='account/rateLimits/read'?{accountId:mode==='wrong'?'wrong':'a',rateLimits:{primary:{usedPercent:32,windowDurationMins:300,resetsAt:2000000000}}}:{};
      process.stdout.write(JSON.stringify(mode==='error'?{id:m.id,error:{message:'PRIVATE-TOKEN'}}:{id:m.id,result})+'\\n');
    });`);
});
after(() => fs.rm(root, { recursive: true, force: true }));
test('provider windows preserve zero, missing values and reset times; do not coerce unknown to zero', () => {
  const c = claudeSnapshot({ five_hour: { utilization: 0, resets_at: '2030-01-01T00:00:00Z' }, seven_day: null }, 123);
  assert.equal(c.primary.usedPercent, 0); assert.equal(c.secondary, null); assert.equal(c.primary.resetsAt, Date.parse('2030-01-01T00:00:00Z'));
  assert.throws(() => claudeSnapshot({ five_hour: { utilization: null } }), { code: 'unsupported' });
  assert.throws(() => codexSnapshot({ rateLimits: { primary: { usedPercent: '0' } } }), { code: 'unsupported' });
  const x = codexSnapshot({ rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: { codex: { primary: { usedPercent: 6, windowDurationMins: 300, resetsAt: 1234 } } } });
  assert.equal(x.primary.usedPercent, 6); assert.equal(x.primary.resetsAt, 1234000);
  const weekly = codexSnapshot({ rateLimits: { planType: 'prolite', primary: { usedPercent: 27, windowDurationMins: 10080 }, secondary: null } });
  assert.equal(weekly.primary.windowMinutes, 10080); assert.equal(weekly.secondary, null); assert.equal(weekly.plan, 'prolite');
});
test('Codex stdio handshake uses the selected home, file credentials, and no model turns', async () => {
  let child;
  const spawner = (bin, args, opts) => {
    assert.equal(opts.env.CODEX_HOME, codex.dir); assert.ok(args.includes('cli_auth_credentials_store="file"'));
    child = spawn(process.execPath, [fake, 'ok'], opts); return child;
  };
  const result = await codexUsage({ key: 'codex:a', home: codex }, { bin: 'fake', spawner });
  assert.equal(result.primary.usedPercent, 32); assert.equal(child.killed, true);
});
test('Codex rejects wrong identities, API keys, timeouts and redacts raw provider errors', async () => {
  await assert.rejects(codexUsage({ key: 'codex:apikey', home: codex }), { code: 'unsupported' });
  await assert.rejects(codexUsage({ key: 'codex:wrong', home: codex }, { bin: 'fake' }), { code: 'login_required' });
  for (const [mode, code] of [['wrong', 'identity_changed'], ['apikey', 'unsupported'], ['timeout', 'timeout'], ['error', 'unavailable']]) {
    await assert.rejects(codexUsage({ key: 'codex:a', home: codex }, {
      bin: 'fake', timeoutMs: mode === 'timeout' ? 150 : 5000, spawner: (bin, args, opts) => spawn(process.execPath, [fake, mode], opts),
    }), (error) => { assert.equal(error.code, code); assert.doesNotMatch(error.message, /PRIVATE/); return true; });
  }
});
const credentials = async () => ({ claudeAiOauth: { accessToken: 'PRIVATE-TOKEN', expiresAt: Date.now() + 60000, subscriptionType: 'max' } });
const response = (value) => ({ ok: true, status: 200, json: async () => value });
test('Claude validates bearer identity on the official origin before accepting usage', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push(url); assert.ok(url.startsWith('https://api.anthropic.com/api/oauth/'));
    assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer PRIVATE-TOKEN');
    return response(url.endsWith('/profile') ? { account: { uuid: 'b' } } : { five_hour: { utilization: 12 }, seven_day: { utilization: 45 } });
  };
  const r = await claudeUsage({ key: 'claude:b', home: claude }, { credentials, fetcher });
  assert.equal(calls.length, 2); assert.equal(r.primary.usedPercent, 12); assert.equal(r.secondary.usedPercent, 45);
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE-TOKEN/);
  await assert.rejects(claudeUsage({ key: 'claude:b', home: claude }, { credentials, fetcher: async () => response({ account: { uuid: 'wrong' } }) }), { code: 'identity_changed' });
});
test('Claude rejects expired credentials, unauthorized responses, network errors and mid-request account switches', async () => {
  await assert.rejects(claudeUsage({ key: 'claude:b', home: claude }, { credentials: async () => ({ claudeAiOauth: { accessToken: 'PRIVATE-TOKEN', expiresAt: 1 } }) }), { code: 'login_required' });
  await assert.rejects(claudeUsage({ key: 'claude:b', home: claude }, { credentials, fetcher: async () => ({ status: 401 }) }), { code: 'login_required' });
  await assert.rejects(claudeUsage({ key: 'claude:b', home: claude }, { credentials, fetcher: async () => { throw new Error('PRIVATE-TOKEN'); } }), { code: 'unavailable', message: 'unavailable' });
  await assert.rejects(claudeUsage({ key: 'claude:b', home: claude }, { credentials, fetcher: async (url) => {
    if (url.endsWith('/profile')) return response({ account: { uuid: 'b' } });
    await write(path.join(claude.dir, '.claude.json'), { oauthAccount: { accountUuid: 'other' } });
    return response({ five_hour: { utilization: 12 } });
  } }), { code: 'identity_changed' });
});
test('Claude keychain is scoped by config directory and only falls back to that home', async () => {
  const a = claudeKeychainService({ dir: '/tmp/a', default: false }), b = claudeKeychainService({ dir: '/tmp/b', default: false });
  assert.notEqual(a, b); assert.match(a, /^Claude Code-credentials-[a-f0-9]{8}$/);
  await write(path.join(claude.dir, '.credentials.json'), await credentials());
  let service;
  const r = await claudeCredentials(claude, { platform: 'darwin', keychain: async (s) => { service = s; return null; } });
  assert.equal(service, claudeKeychainService(claude)); assert.equal(r.claudeAiOauth.accessToken, 'PRIVATE-TOKEN');
});

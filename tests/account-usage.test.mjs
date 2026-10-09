import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { codexSnapshot, claudeSnapshot, codexUsage, claudeUsage } from '../server/account-usage.mjs';
import { claudeKeychainService, claudeCredentials, updateClaudeCredentials } from '../server/account-credentials.mjs';

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

test('Claude refreshes expired credentials and keeps the rotated login across usage-client restarts', async () => {
  await write(path.join(claude.dir, '.claude.json'), { oauthAccount: { accountUuid: 'b' } });
  const file = path.join(claude.dir, '.credentials.json');
  await write(file, { other: 'preserved', claudeAiOauth: {
    accessToken: 'EXPIRED-PRIVATE', refreshToken: 'REFRESH-PRIVATE', expiresAt: 1,
    scopes: ['user:profile', 'user:inference'], subscriptionType: 'max', rateLimitTier: 'tier',
  } });
  let refreshes = 0, saves = 0;
  const read = async () => JSON.parse(await fs.readFile(file, 'utf8'));
  const saveCredentials = async (home, expected, next) => {
    assert.equal(home.dir, claude.dir); assert.equal((await read()).claudeAiOauth.accessToken, expected.claudeAiOauth.accessToken);
    saves++; await write(file, next); return true;
  };
  const fetcher = async (url, options) => {
    assert.equal(options.redirect, 'error');
    if (options.method === 'POST') {
      refreshes++; assert.equal(url, 'https://platform.claude.com/v1/oauth/token');
      const body = JSON.parse(options.body);
      assert.equal(body.grant_type, 'refresh_token'); assert.equal(body.refresh_token, 'REFRESH-PRIVATE');
      assert.equal(body.scope, 'user:profile user:inference');
      return response({ access_token: 'NEW-PRIVATE', refresh_token: 'ROTATED-PRIVATE', expires_in: 3600, scope: body.scope });
    }
    assert.equal(options.headers.Authorization, 'Bearer NEW-PRIVATE');
    return response(url.endsWith('/profile') ? { account: { uuid: 'b' } } : { five_hour: { utilization: 12 } });
  };
  for (let restart = 0; restart < 2; restart++) {
    const result = await claudeUsage({ key: 'claude:b', home: claude }, { credentials: read, saveCredentials, fetcher });
    assert.equal(result.primary.usedPercent, 12); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
  assert.equal(refreshes, 1); assert.equal(saves, 1);
  const saved = await read(); assert.equal(saved.other, 'preserved');
  assert.equal(saved.claudeAiOauth.refreshToken, 'ROTATED-PRIVATE'); assert.equal(saved.claudeAiOauth.rateLimitTier, 'tier');
});

test('Claude persists into the original CLI store and never replaces a newer login', async () => {
  const expected = { other: 'keep', claudeAiOauth: { accessToken: 'OLD', refreshToken: 'REFRESH' } };
  const next = { ...expected, claudeAiOauth: { accessToken: 'NEW', refreshToken: 'ROTATED' } };
  const file = path.join(claude.dir, '.credentials.json');
  await write(file, expected);
  assert.equal(await updateClaudeCredentials(claude, expected, next, { platform: 'linux' }), true);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), next);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal(await updateClaudeCredentials(claude, expected, next, { platform: 'linux' }), false);
  let writes = 0, keychain = expected;
  const options = { platform: 'darwin', keychain: async () => keychain,
    writeKeychain: async (service, value) => { assert.equal(service, claudeKeychainService(claude)); writes++; keychain = value; } };
  assert.equal(await updateClaudeCredentials(claude, expected, next, options), true);
  assert.equal(await updateClaudeCredentials(claude, expected, next, options), false);
  assert.equal(writes, 1); assert.deepEqual(keychain, next);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), next);
  await assert.rejects(updateClaudeCredentials(claude, next, expected, { ...options, writeKeychain: async () => {} }), /credential_store_unavailable/);
});

test('Claude renews a revoked access token once, and redacts renewal and persistence failures', async () => {
  await write(path.join(claude.dir, '.claude.json'), { oauthAccount: { accountUuid: 'b' } });
  const credentials = async () => ({ claudeAiOauth: { accessToken: 'PRIVATE', refreshToken: 'PRIVATE-REFRESH', expiresAt: Date.now() + 60000 } });
  let renewals = 0, writes = 0;
  const fetcher = async (url, options) => {
    if (options.method === 'POST') { renewals++; return response({ access_token: 'RENEWED', expires_in: 3600 }); }
    if (options.headers.Authorization === 'Bearer PRIVATE') return { status: 401 };
    return response(url.endsWith('/profile') ? { account: { uuid: 'b' } } : { five_hour: { utilization: 0 } });
  };
  const result = await claudeUsage({ key: 'claude:b', home: claude }, { credentials, fetcher, saveCredentials: async (home, expected, next) => {
    assert.equal(next.claudeAiOauth.refreshToken, 'PRIVATE-REFRESH'); writes++; return true;
  } });
  assert.equal(result.primary.usedPercent, 0); assert.equal(renewals, 1); assert.equal(writes, 1);
  const expired = async () => ({ claudeAiOauth: { accessToken: 'PRIVATE', refreshToken: 'PRIVATE-REFRESH', expiresAt: 1 } });
  for (const [status, code] of [[400, 'login_required'], [429, 'rate_limited'], [503, 'unavailable']]) {
    await assert.rejects(claudeUsage({ key: 'claude:b', home: claude }, { credentials: expired, fetcher: async () => ({ status }) }), { code, message: code });
  }
  await assert.rejects(claudeUsage({ key: 'claude:b', home: claude }, { credentials, fetcher, saveCredentials: async () => { throw new Error('PRIVATE'); } }), { code: 'unavailable', message: 'unavailable' });
  await assert.rejects(claudeUsage({ key: 'claude:b', home: claude }, { credentials, fetcher, saveCredentials: async () => false }), { code: 'identity_changed' });
});

test('Claude keeps a rotated refresh token even when the following usage request fails', async () => {
  let saved = { claudeAiOauth: { accessToken: 'EXPIRED', refreshToken: 'OLD-REFRESH', expiresAt: 1 } }, renewals = 0;
  const credentials = async () => saved;
  const saveCredentials = async (home, expected, next) => { saved = next; return true; };
  const fetcher = async (url, options) => {
    if (options.method === 'POST') { renewals++; return response({ access_token: 'NEW', refresh_token: 'NEW-REFRESH', expires_in: 3600 }); }
    throw new Error('PRIVATE-NETWORK-ERROR');
  };
  await assert.rejects(claudeUsage({ key: 'claude:b', home: claude }, { credentials, saveCredentials, fetcher }), { code: 'unavailable', message: 'unavailable' });
  assert.equal(saved.claudeAiOauth.refreshToken, 'NEW-REFRESH');
  const restarted = await claudeUsage({ key: 'claude:b', home: claude }, { credentials, saveCredentials, fetcher: async (url, options) => {
    assert.notEqual(options.method, 'POST');
    return response(url.endsWith('/profile') ? { account: { uuid: 'b' } } : { five_hour: { utilization: 5 } });
  } });
  assert.equal(restarted.primary.usedPercent, 5); assert.equal(renewals, 1);
});

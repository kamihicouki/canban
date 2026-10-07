import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { withClaudeAuthLock } from '../server/claude-auth-lock.mjs';
import { claudeUsage } from '../server/account-usage.mjs';
import { claudeCredentials, updateClaudeCredentials, claudeKeychainService } from '../server/account-credentials.mjs';
import { isolatedClaudeEnvironment, CLAUDE_AUTH_OVERRIDES } from '../server/claude-auth-env.mjs';
import { loginEnvironment } from '../server/login.mjs';
import { resumeCommand } from '../server/agents.mjs';

const json = value => ({ ok: true, status: 200, json: async () => value });
const fixture = async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canban-auth-isolation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homes = [];
  for (const account of ['a', 'b']) {
    const home = { dir: path.join(root, account), default: false };
    await fs.mkdir(home.dir);
    await fs.writeFile(path.join(home.dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: account } }));
    await fs.writeFile(path.join(home.dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: {
      accessToken: `old-${account}`, refreshToken: `refresh-${account}`, expiresAt: 1,
    } }), { mode: 0o600 });
    homes.push(home);
  }
  return { root, homes };
};

test('two accounts renew independently, while simultaneous callers of one home rotate only once', async t => {
  const { homes } = await fixture(t);
  assert.notEqual(claudeKeychainService(homes[0]), claudeKeychainService(homes[1]));
  const renewals = { a: 0, b: 0 };
  let active = 0, maxActive = 0;
  const options = {
    credentials: home => claudeCredentials(home, { platform: 'linux' }),
    saveCredentials: (home, old, next) => updateClaudeCredentials(home, old, next, { platform: 'linux' }),
    fetcher: async (url, opts) => {
      if (opts.method === 'POST') {
        const account = JSON.parse(opts.body).refresh_token.replace('refresh-', '');
        assert.ok(['a', 'b'].includes(account)); renewals[account]++;
        maxActive = Math.max(maxActive, ++active);
        await new Promise(resolve => setTimeout(resolve, 40)); active--;
        return json({ access_token: `new-${account}`, refresh_token: `rotated-${account}`, expires_in: 3600 });
      }
      const account = opts.headers.Authorization.replace('Bearer new-', '');
      assert.ok(['a', 'b'].includes(account));
      return json(url.endsWith('/profile') ? { account: { uuid: account } } : { five_hour: { utilization: account === 'a' ? 11 : 22 } });
    },
  };
  const results = await Promise.all([0, 0, 1].map(index => claudeUsage({ key: `claude:${index ? 'b' : 'a'}`, home: homes[index] }, options)));
  assert.deepEqual(results.map(r => r.primary.usedPercent), [11, 11, 22]);
  assert.deepEqual(renewals, { a: 1, b: 1 }); assert.equal(maxActive, 2);
  for (const [index, home] of homes.entries()) {
    const saved = await claudeCredentials(home, { platform: 'linux' });
    assert.equal(saved.claudeAiOauth.refreshToken, `rotated-${index ? 'b' : 'a'}`);
  }
});

test('Claude CLI-compatible locks exclude another process and aliases of the same directory', async t => {
  const { root, homes } = await fixture(t);
  const script = path.join(root, 'hold.mjs');
  await fs.writeFile(script, `import {withClaudeAuthLock} from ${JSON.stringify(new URL('../server/claude-auth-lock.mjs', import.meta.url).href)};
    await withClaudeAuthLock({dir:process.argv[2]},async()=>{process.send('ready');await new Promise(r=>process.once('message',r));});process.exit(0);`);
  const child = fork(script, [homes[0].dir], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', code => reject(Error(`holder exited ${code}`))); });
  const alias = path.join(root, 'alias'); await fs.symlink(homes[0].dir, alias);
  await assert.rejects(withClaudeAuthLock({ dir: alias }, async () => assert.fail('contended home entered'), { timeoutMs: 30 }), { code: 'unavailable' });
  await withClaudeAuthLock(homes[1], async () => {});
  const exited = new Promise(resolve => child.once('exit', resolve)); child.send('release'); await exited;
  await withClaudeAuthLock(homes[0], async () => {});
  for (const lock of ['.oauth_refresh.lock', '.storage-write.lock']) {
    await fs.mkdir(path.join(homes[0].dir, lock));
    await assert.rejects(withClaudeAuthLock(homes[0], async () => assert.fail('CLI-owned lock entered'), { kind: lock.startsWith('.storage') ? 'storage' : 'refresh', timeoutMs: 30 }), { code: 'unavailable' });
    await fs.rmdir(path.join(homes[0].dir, lock));
  }
});

test('abandoned locks recover, and a replaced lock blocks a late credential write', async t => {
  const { homes } = await fixture(t);
  const file = path.join(homes[0].dir, '.oauth_refresh.lock');
  await fs.mkdir(file); const old = new Date(Date.now() - 61000); await fs.utimes(file, old, old);
  await withClaudeAuthLock(homes[0], async () => {});
  await assert.rejects(withClaudeAuthLock(homes[0], async assertHeld => {
    await fs.rmdir(file); await fs.mkdir(file); await assertHeld(); assert.fail('lost owner wrote');
  }), { code: 'unavailable' });
  assert((await fs.stat(file)).isDirectory());
  const before = await claudeCredentials(homes[0], { platform: 'linux' });
  await assert.rejects(updateClaudeCredentials(homes[0], before, { claudeAiOauth: { accessToken: 'never-save' } }, {
    platform: 'linux', assertOwner: async () => { throw Object.assign(Error('unavailable'), { code: 'unavailable' }); },
  }), { code: 'unavailable' });
  assert.deepEqual(await claudeCredentials(homes[0], { platform: 'linux' }), before);
});

test('profile login, session execution and terminal resume discard inherited authentication overrides', () => {
  const parent = { PATH: '/bin', KEEP: 'yes', CLAUDE_CONFIG_DIR: '/wrong-account', ...Object.fromEntries(CLAUDE_AUTH_OVERRIDES.map(key => [key, 'PRIVATE-OTHER-ACCOUNT'])) };
  for (const env of [isolatedClaudeEnvironment(parent, '/account-b'), loginEnvironment({ agent: 'claude', dir: '/account-b' }, parent)]) {
    assert.equal(env.CLAUDE_CONFIG_DIR, '/account-b'); assert.equal(env.KEEP, 'yes');
    for (const key of CLAUDE_AUTH_OVERRIDES) assert.equal(env[key], undefined);
  }
  const command = resumeCommand({ agent: 'claude', nativeId: 'session-b', homeDir: '/account-b', cwd: '/project' });
  for (const key of CLAUDE_AUTH_OVERRIDES) assert(command.includes(`-u ${key} `));
  assert.match(command, /CLAUDE_CONFIG_DIR=\/account-b claude --resume session-b$/);
  assert.doesNotMatch(command, /PRIVATE/);
});

test('native default resume preserves the normal CLI credential namespace', () => {
  const env = isolatedClaudeEnvironment({ CLAUDE_CONFIG_DIR: '/another-profile', KEEP: 'yes' }, null);
  assert.equal(Object.hasOwn(env, 'CLAUDE_CONFIG_DIR'), false);
  assert.equal(env.KEEP, 'yes');
  const command = resumeCommand({ agent: 'claude', nativeId: 'same-session', homeDir: '/Users/example/.claude', claudeDefaultConfig: true });
  assert.match(command, /-u CLAUDE_CONFIG_DIR /);
  assert.doesNotMatch(command, /CLAUDE_CONFIG_DIR=/);
});

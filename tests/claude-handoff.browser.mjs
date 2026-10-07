// Isolated fake accounts/CLI only. No authentication or real terminal launches.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { makeFixtures } from './helpers.mjs';
import { Store } from '../server/store.mjs';
const require = createRequire(process.env.CANBAN_PLAYWRIGHT_PACKAGE || import.meta.url);
const { chromium } = require('playwright');
const root = process.cwd(), fx = makeFixtures();
const writable = dir => {
  fs.chmodSync(dir, 0o755);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) writable(file); else fs.chmodSync(file, 0o644);
  }
};
writable(fx.claudeHome);
const cwd = path.join(fx.root, 'unchanged-worktree'); fs.mkdirSync(cwd);
const second = path.join(fx.root, 'second-account'); fs.mkdirSync(second);
for (const [dir, account] of [[fx.claudeHome, 'first'], [second, 'second']]) fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: account, emailAddress: `${account}@example.test` } }));
const transcript = path.join(fx.claudeHome, 'projects', '-r-web', 'c2.jsonl');
fs.writeFileSync(transcript, [
  { type: 'user', sessionId: 'c2', cwd, gitBranch: 'codex/unchanged', permissionMode: 'acceptEdits', timestamp: '2026-09-01T00:00:00Z', message: { content: 'Continue the same work' } },
  { type: 'assistant', timestamp: '2026-09-01T00:00:01Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Reached the account limit' }] } },
].map(o => JSON.stringify(o) + '\n').join(''));
fs.utimesSync(transcript, 1, 1);
const original = fs.readFileSync(transcript);
fs.mkdirSync(path.join(root, '.local'), { recursive: true });
const dataDir = fs.mkdtempSync(path.join(root, '.local/claude-handoff-data-'));
const output = path.join(root, '.local/claude-handoff-screenshots'); fs.mkdirSync(output, { recursive: true });
const agentLog = path.join(dataDir, 'fake-agent.jsonl');
await new Store(dataDir).updateAccountSettings({ claudeHomes: [second], discover: false });
const host = spawn(process.execPath, ['tests/dev-host.mjs', '4599'], { cwd: root, env: { ...process.env, CANBAN_DATA_DIR: dataDir, CANBAN_CODEX_HOME: fx.codexHome, CANBAN_CLAUDE_HOME: fx.claudeHome, CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir, CANBAN_CLAUDE_BIN: path.join(root, 'tests/fake-claude.sh'), CANBAN_LAUNCH_DRYRUN: '1', CANBAN_SEARCH_INDEX: '0', CANBAN_GH: path.join(root, 'tests/fake-gh.sh'), CANBAN_GLAB: path.join(root, 'tests/fake-glab.sh'), FAKE_GH_DATA: '/dev/null', FAKE_AGENT_LOG: agentLog } });
let hostLog = '', browser;
host.stdout.on('data', b => { hostLog += b; }); host.stderr.on('data', b => { hostLog += b; });
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://localhost:4599')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  browser = await chromium.launch({ headless: true, ...(process.env.CANBAN_BROWSER_EXECUTABLE ? { executablePath: process.env.CANBAN_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(10000);
  const errors = [], calls = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.url().endsWith('/rpc')) { const data = r.postDataJSON(); if (data?.name) calls.push(data); } });
  await page.route('**/direct', async route => {
    const response = await route.fetch(), html = await response.text(), i = html.lastIndexOf('})();');
    await route.fulfill({ response, body: html.slice(0, i) + 'globalThis.__test={state,bridge,load,openCard,setThemePref,setLayout,closeCards};' + html.slice(i) });
  });
  await page.goto('http://localhost:4599/direct');
  await page.locator('.card[data-card-id="claude:c2"]').click();
  const picker = page.getByRole('button', { name: 'Claude の実行アカウント', exact: true });
  await picker.waitFor({ state: 'visible' });
  const prompt = page.getByRole('textbox', { name: '送るプロンプト', exact: true });
  await prompt.fill('Keep this draft while selecting the account');
  await picker.click();
  await page.getByRole('textbox', { name: /検索|絞り込み/ }).last().fill('second');
  const saved = page.waitForResponse(r => r.url().endsWith('/rpc') && r.request().postDataJSON()?.name === 'canban_set_claude_execution');
  await page.getByText('second@example.test (second-account)', { exact: true }).click();
  assert.equal((await (await saved).json()).result.isError, undefined);
  await page.waitForFunction(() => !document.querySelector('.claude-account-picker').disabled);
  assert.equal(await prompt.inputValue(), 'Keep this draft while selecting the account');
  assert.equal(await page.locator('[data-resume-desktop]').isDisabled(), true);
  assert.match(await page.locator('.claude-execution-note').innerText(), /second@example.test/);

  const resumed = page.waitForResponse(r => r.url().endsWith('/rpc') && r.request().postDataJSON()?.name === 'canban_open_session');
  await page.locator('.resume-main').click();
  const result = (await (await resumed).json()).result;
  assert.equal(result.isError, undefined);
  assert.match(JSON.stringify(result), /CLAUDE_CONFIG_DIR/);
  assert.ok(JSON.stringify(result).includes(transcript));
  const opened = calls.filter(c => c.name === 'canban_open_session').at(-1);
  assert.equal(opened.arguments.claudeHome, undefined);
  assert.equal(opened.arguments.route, undefined);

  // Keyboard and palette use the same picker; closing either keeps the draft.
  await page.locator('.pane').first().focus();
  await page.keyboard.press('Alt+a');
  await page.locator('.popover').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+k');
  await page.locator('.popover.palette input').fill('Claude の実行アカウントを選ぶ');
  await page.keyboard.press('Enter');
  await page.locator('.popover .picker').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  assert.equal(await prompt.inputValue(), 'Keep this draft while selecting the account');

  const openRpc = async route => (await (await fetch('http://localhost:4599/rpc', {
    method: 'POST', body: JSON.stringify({ name: 'canban_open_session', arguments: { cardId: 'claude:c2', claudeHome: 'second-account', route } }), signal: AbortSignal.timeout(10000),
  })).json()).result;
  const desktopError = await openRpc('desktop');
  assert.equal(desktopError.isError, true);
  assert.match(JSON.stringify(desktopError), /ターミナル/);
  await page.reload();
  await picker.waitFor({ state: 'visible' });
  assert.match(await picker.innerText(), /second@example.test/);
  await prompt.fill('Persisted selection after reload');
  const persisted = await new Store(dataDir).load();
  assert.equal(persisted.cards['claude:c2'].claudeExecution.account, 'claude:second');
  // A fresh write must be rejected even when the cached board still looks idle.
  fs.utimesSync(transcript, new Date(), new Date());
  const busyError = await openRpc('terminal');
  assert.equal(busyError.isError, true);
  assert.match(JSON.stringify(busyError), /更新された直後|実行中|入力待ち/);
  fs.utimesSync(transcript, 1, 1);

  for (const layout of ['trello', 'classic', 'rail', 'omni', 'hud']) for (const theme of ['light', 'dark']) {
    await page.evaluate(({ layout, theme }) => { __test.setLayout(layout); __test.setThemePref(theme); }, { layout, theme });
    await page.waitForTimeout(100);
    assert.equal(await page.locator('body').getAttribute('data-layout'), layout);
    assert.equal(await picker.isVisible(), true);
    await page.locator('.resume-box').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `${layout}-${theme}.png`) });
  }
  await page.evaluate(() => { __test.setLayout('trello'); __test.setThemePref('light'); });
  const sent = page.waitForResponse(r => r.url().endsWith('/rpc') && r.request().postDataJSON()?.name === 'canban_dispatch');
  await page.getByRole('button', { name: /今すぐ送信/ }).click();
  const dispatchResult = (await (await sent).json()).result;
  assert.equal(dispatchResult.isError, undefined);
  assert.match(JSON.stringify(dispatchResult), /claude:second/);
  assert.equal(calls.filter(c => c.name === 'canban_dispatch').at(-1).arguments.claudeHome, undefined);
  assert.deepEqual(fs.readFileSync(transcript), original);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, screenshots: 10, viewport: '1280x800', layouts: 5, themes: 2, accountSelection: true, selectionPersisted: true, terminalResume: true, headlessResume: true, dryRun: true, keyboard: true, palette: true, draftPreserved: true, desktopSwitchRejected: true, freshTranscriptRejected: true, browserErrors: errors }));
} catch (error) { console.error(error); console.error(hostLog.slice(-3000)); process.exitCode = 1; }
finally { await browser?.close(); host.kill('SIGTERM'); fx.cleanup(); fs.rmSync(dataDir, { recursive: true, force: true }); }

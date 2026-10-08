// Isolated fake accounts/CLI only. No authentication or real terminal launches.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
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
writable(fx.desktopDir);
fs.renameSync(path.join(fx.desktopDir, 'a'), path.join(fx.desktopDir, 'first'));
fs.writeFileSync(path.join(fx.desktopDir, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'first' }));
const cwd = path.join(fx.root, 'unchanged-worktree'); fs.mkdirSync(cwd);
const second = path.join(fx.root, 'second-account');
const duplicate = path.join(fx.root, 'second-copy');
const duplicateId = `home-${createHash('sha256').update(`claude:${duplicate}`).digest('hex').slice(0, 24)}`;
const extras = [second, duplicate, path.join(fx.root, 'second-third'), ...[1, 2, 3].map(n => path.join(fx.root, `first-copy-${n}`))];
for (const dir of extras) fs.mkdirSync(dir);
for (const dir of [fx.claudeHome, ...extras]) {
  const account = path.basename(dir).startsWith('second') ? 'second' : 'first';
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: account, emailAddress: `${account}@example.test` } }));
}
writable(fx.codexHome);
const codexSecond = path.join(fx.root, 'codex-second'); fs.mkdirSync(codexSecond);
for (const [dir, account] of [[fx.codexHome, 'first'], [codexSecond, 'second']]) {
  const jwt = `h.${Buffer.from(JSON.stringify({ email: `${account}@example.test` })).toString('base64url')}.sig`;
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ tokens: { account_id: account, id_token: jwt } }));
}
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
await new Store(dataDir).updateAccountSettings({ claudeHomes: extras, codexHomes: [codexSecond], discover: false });
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
    await route.fulfill({ response, body: html.slice(0, i) + 'globalThis.__test={state,bridge,load,openCard,setThemePref,closeCards};' + html.slice(i) });
  });
  await page.goto('http://localhost:4599/direct');
  await page.locator('.card[data-card-id="claude:c2"]').click();
  const picker = page.getByRole('button', { name: 'Claude の実行アカウント', exact: true });
  await picker.waitFor({ state: 'visible' });
  const prompt = page.getByRole('textbox', { name: '送るプロンプト', exact: true });
  await prompt.fill('Keep this draft while selecting the account');
  await picker.click();
  const identityRows = page.locator('.claude-identity-picker .picker-row');
  const canonical = await page.evaluate(() => __test.state.board.accounts.accounts);
  assert.equal(canonical.length, 4);
  const detail = await page.evaluate(async () => __test.bridge.callTool('canban_get_session', { cardId: 'claude:c2' }));
  assert.deepEqual(detail.launch.claudeExecutionAccounts.map(a => a.key).sort(), canonical.filter(a => a.agent === 'claude').map(a => a.key).sort());
  assert.deepEqual(detail.launch.claudeExecutionAccounts.map(a => a.profiles.length).sort(), [3, 4]);
  assert.equal(await identityRows.count(), 2);
  assert.equal(await page.locator('.claude-profile-row:visible').count(), 0);
  await page.getByRole('textbox', { name: '実行アカウントを絞り込み' }).fill('second');
  assert.equal(await identityRows.count(), 1);
  assert.match(await identityRows.innerText(), /Claude Code/);
  assert.doesNotMatch(await identityRows.innerText(), /second-account|second-copy|追加設定/);
  const waitSaved = () => page.waitForResponse(r => r.url().endsWith('/rpc') && r.request().postDataJSON()?.name === 'canban_set_claude_execution');
  let saved = waitSaved();
  await identityRows.click();
  assert.equal((await (await saved).json()).result.isError, undefined);
  await page.waitForFunction(() => !document.querySelector('.claude-account-picker').disabled);
  assert.equal(await prompt.inputValue(), 'Keep this draft while selecting the account');
  assert.match(await picker.innerText(), /second@example.test\s+Claude Code/);
  await picker.click();
  await page.locator('.claude-execution-details summary').click();
  assert.equal(await page.locator('.claude-profile-row:visible').count(), 3);
  await page.getByRole('textbox', { name: '設定名で検索' }).fill('second-copy');
  assert.equal(await page.locator('.claude-profile-row:visible').count(), 1);
  saved = waitSaved();
  await page.locator('.claude-profile-row:visible').click();
  assert.equal((await (await saved).json()).result.isError, undefined);
  await page.waitForFunction(() => !document.querySelector('.claude-account-picker').disabled);
  assert.equal((await new Store(dataDir).load()).cards['claude:c2'].claudeExecution.homeId, duplicateId);
  // Reselecting the same identity retains the exact saved configuration.
  await picker.click();
  saved = waitSaved();
  await identityRows.filter({ hasText: 'second@example.test' }).click();
  await saved;
  await page.waitForFunction(() => !document.querySelector('.claude-account-picker').disabled);
  assert.equal((await new Store(dataDir).load()).cards['claude:c2'].claudeExecution.homeId, duplicateId);
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
  assert.equal(persisted.cards['claude:c2'].claudeExecution.homeId, duplicateId);
  await picker.click();
  saved = waitSaved();
  await page.getByRole('button', { name: '元の設定に戻す', exact: true }).click();
  await saved;
  await page.waitForFunction(() => !document.querySelector('.claude-account-picker').disabled);
  assert.equal((await new Store(dataDir).load()).cards['claude:c2'].claudeExecution, undefined);
  assert.match(await picker.innerText(), /first@example.test/);
  await picker.click();
  saved = waitSaved();
  await identityRows.filter({ hasText: 'second@example.test' }).click();
  await saved;
  await page.waitForFunction(() => !document.querySelector('.claude-account-picker').disabled);
  assert.equal((await new Store(dataDir).load()).cards['claude:c2'].claudeExecution.homeId, duplicateId);
  // A fresh write must be rejected even when the cached board still looks idle.
  fs.utimesSync(transcript, new Date(), new Date());
  const busyError = await openRpc('terminal');
  assert.equal(busyError.isError, true);
  assert.match(JSON.stringify(busyError), /更新された直後|実行中|入力待ち/);
  fs.utimesSync(transcript, 1, 1);

  await page.locator('.toast').waitFor({ state: 'detached' });
  for (const layout of ['board']) for (const theme of ['light', 'dark']) {
    await page.evaluate(({ layout, theme }) => { __test.setThemePref(theme); }, { layout, theme });
    await page.waitForTimeout(100);
    assert.equal(await picker.isVisible(), true);
    await page.locator('.resume-box').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `${layout}-${theme}.png`) });
    await picker.click();
    assert.equal(await identityRows.count(), 2);
    const rowBoxes = await identityRows.evaluateAll(rows => rows.map(row => { const r = row.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; }));
    assert.ok(rowBoxes.every(r => r.height >= 58));
    assert.ok(rowBoxes[0].bottom <= rowBoxes[1].top);
    await page.screenshot({ path: path.join(output, `${layout}-${theme}-picker.png`) });
    await page.locator('.claude-execution-details summary').click();
    assert.equal(await page.locator('.claude-profile-row:visible').count(), 3);
    assert.equal(await page.locator('.claude-profile-row input:checked').inputValue(), duplicateId);
    await page.waitForTimeout(100);
    const popup = await page.locator('.claude-identity-picker').boundingBox();
    const appbar = await page.locator('.appbar').boundingBox();
    assert.ok(popup.y >= appbar.y + appbar.height);
    assert.ok(popup.y + popup.height <= 800);
    assert.ok(popup.x >= 0 && popup.x + popup.width <= 1280);
    await page.screenshot({ path: path.join(output, `${layout}-${theme}-details.png`) });
    await page.keyboard.press('Escape');
  }
  await page.evaluate(() => { __test.setThemePref('light'); });
  const sent = page.waitForResponse(r => r.url().endsWith('/rpc') && r.request().postDataJSON()?.name === 'canban_dispatch');
  await page.getByRole('button', { name: /今すぐ送信/ }).click();
  const dispatchResult = (await (await sent).json()).result;
  assert.equal(dispatchResult.isError, undefined);
  assert.match(JSON.stringify(dispatchResult), /claude:second/);
  assert.equal(calls.filter(c => c.name === 'canban_dispatch').at(-1).arguments.claudeHome, undefined);
  assert.deepEqual(fs.readFileSync(transcript), original);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, screenshots: 30, viewport: '1280x800', layouts: 5, themes: 2, accountSelection: true, fourCanonicalAccounts: true, sevenProfilesTwoClaudeAccounts: true, noRowOverlap: true, detailWithinViewport: true, selectionPersisted: true, resetToSource: true, terminalResume: true, headlessResume: true, dryRun: true, keyboard: true, palette: true, draftPreserved: true, desktopSwitchRejected: true, freshTranscriptRejected: true, browserErrors: errors }));
} catch (error) { console.error(error); console.error(hostLog.slice(-3000)); process.exitCode = 1; }
finally { await browser?.close(); host.kill('SIGTERM'); fx.cleanup(); fs.rmSync(dataDir, { recursive: true, force: true }); }

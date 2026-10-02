// Optional UI regression with fictional accounts and authorization URLs.
// node --test tests/account-login.browser.mjs (Playwright can be selected via CANBAN_PLAYWRIGHT_PACKAGE).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { boardHtml } from '../server/ui.mjs';

test('account login exposes terminal, manual URL and explicit browser/profile flows', async t => {
  const require = createRequire(process.env.CANBAN_PLAYWRIGHT_PACKAGE || import.meta.url);
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CANBAN_BROWSER_EXECUTABLE ? { executablePath: process.env.CANBAN_BROWSER_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const html = boardHtml(), css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const helpers = script.slice(script.indexOf('function h('), script.indexOf('const colorVar ='));
  const accounts = fs.readFileSync(new URL('../ui/accounts.js', import.meta.url), 'utf8');
  for (const width of [1000, 390]) await t.test(`${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 950 } });
    t.after(() => page.close());
    await page.setContent(`<style>${css}</style><button id="accountsBtn">アカウント</button><div id="menu"></div>`);
    await page.addScriptTag({ content: `${helpers}
      const $ = selector => document.querySelector(selector), calls = [], toasts = [];
      const state = { filters: {}, board: { accounts: { accounts: [], homes: [], colors: [], profiles: [], unknown: { codex: 0, claude: 0 }, refresh: { enabled: false, intervalMinutes: 5 } } } };
      const workspace = { hasDrafts: () => false }, load = async () => {}, toast = message => toasts.push(message);
      const closePopover = () => {}, popover = (anchor, title, body) => $('#menu').replaceChildren(body);
      const pending = { id: 'pending', agent: 'codex', pending: true, dir: '/tmp/fictional-canban-account' };
      const login = { sessionId: 'fixture', state: 'waiting', authUrl: 'https://auth.openai.com/authorize?state=fictional' };
      const bridge = { callTool: async (name, args) => {
        calls.push({ name, args });
        if (name === 'canban_login_browsers') return { result: { browsers: [{ id: 'chrome', label: 'Google Chrome', profiles: [{ id: 'Profile 2', label: 'テスト用' }] }, { id: 'safari', label: 'Safari', profiles: [] }] } };
        if (name === 'canban_start_account_login') { pending.agent = args.agent; state.board.accounts.profiles = [pending]; return { result: { profile: pending, login: { ...login }, opened: false, error: 'ターミナルを開けませんでした' } }; }
        if (name === 'canban_account_login_details') return { result: { command: 'CODEX_HOME=/tmp/fictional-canban-account codex login' } };
        if (name === 'canban_account_login_cancel') return { result: { state: 'cancelled' } };
        if (name === 'canban_account_login_open') return { result: { ...login, browserOpened: true } };
        if (name === 'canban_account_login_code') return { result: { ...login, state: 'succeeded', account: { key: 'claude:fictional' }, authUrl: null } };
        if (name === 'canban_account_login_status') return { result: { ...login } };
        return { result: {} };
      } };
      const act = (name, args) => bridge.callTool(name, args);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copied = text; } } });
      ${accounts}
      updateAccountMenuUsage = () => {}; refreshAccountUsage = () => {};
      window.calls = calls; window.toasts = toasts; accountsMenu($('#accountsBtn'));
    ` });
    await page.getByRole('button', { name: 'ターミナルでログイン', exact: true }).click();
    assert.equal(await page.evaluate(() => window.calls.find(c => c.name === 'canban_start_account_login').args.method), 'terminal');
    assert.equal(await page.getByRole('button', { name: 'ログインコマンドをコピー' }).isVisible(), true);
    await page.getByRole('button', { name: 'ログインコマンドをコピー' }).click();
    assert.match(await page.evaluate(() => window.copied), /fictional-canban-account/);
    await page.getByRole('button', { name: '任意のブラウザで認証', exact: true }).last().click();
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.getByLabel('認証URLの開き方').inputValue(), 'manual');
    await page.getByRole('button', { name: 'ログインを開始', exact: true }).click();
    assert.equal(await page.getByLabel('認証URL', { exact: true }).inputValue(), 'https://auth.openai.com/authorize?state=fictional');
    await page.getByRole('button', { name: '認証URLをコピー' }).click();
    assert.match(await page.evaluate(() => window.copied), /state=fictional/);
    await page.getByLabel('認証URLの開き方').selectOption('auto');
    await page.getByLabel('認証ブラウザ', { exact: true }).selectOption('chrome');
    await page.getByLabel('Chromeプロファイル', { exact: true }).selectOption('Profile 2');
    await page.getByRole('button', { name: '選んだブラウザで開く' }).click();
    const opened = await page.evaluate(() => window.calls.find(c => c.name === 'canban_account_login_open').args);
    assert.deepEqual(opened.loginOptions, { mode: 'auto', browserId: 'chrome', profileId: 'Profile 2' });
    // Cancellation clears the authorization URL and allows a retry.
    await page.getByRole('button', { name: '認証をキャンセル', exact: true }).click();
    assert.equal(await page.getByLabel('認証URL', { exact: true }).inputValue(), '');
    assert.equal(await page.getByRole('button', { name: 'ログインを開始', exact: true }).isEnabled(), true);
    const metrics = await page.getByRole('dialog').evaluate(el => ({ width: el.clientWidth, content: el.scrollWidth }));
    assert.ok(metrics.content <= metrics.width + 1, 'login dialog must fit a narrow viewport');
    await page.getByRole('button', { name: '閉じる', exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.getByLabel('追加するサービス').selectOption('claude');
    await page.getByRole('button', { name: '任意のブラウザで認証', exact: true }).first().click();
    await page.getByRole('button', { name: '追加してログイン', exact: true }).click();
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('clipboard unavailable'); }; });
    await page.getByRole('button', { name: '認証URLをコピー' }).click();
    assert.equal(await page.getByText('選択したURLをコピーして、任意のブラウザで開いてください（⌘C / Ctrl+C）').isVisible(), true);
    await page.getByText('認証が戻らない場合（Claudeのコード入力）').click();
    await page.getByLabel('Claude認証コード', { exact: true }).fill('fictional-code');
    await page.getByRole('button', { name: 'コードを送信', exact: true }).click();
    const submitted = await page.evaluate(() => window.calls.find(c => c.name === 'canban_account_login_code').args);
    assert.equal(submitted.code, 'fictional-code');
    assert.equal(await page.getByLabel('Claude認証コード', { exact: true }).inputValue(), '');
    assert.equal(await page.getByLabel('認証URL', { exact: true }).inputValue(), '');
    assert.equal(await page.getByRole('button', { name: '追加しました', exact: true }).isDisabled(), true);
  });
});

test('existing accounts use browser reauthentication and refresh only the matching successful account', async t => {
  const require = createRequire(process.env.CANBAN_PLAYWRIGHT_PACKAGE || import.meta.url);
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CANBAN_BROWSER_EXECUTABLE ? { executablePath: process.env.CANBAN_BROWSER_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const html = boardHtml(), css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const helpers = script.slice(script.indexOf('function h('), script.indexOf('const colorVar ='));
  const accounts = fs.readFileSync(new URL('../ui/accounts.js', import.meta.url), 'utf8');
  const model = fs.readFileSync(new URL('../ui/workspace-model.js', import.meta.url), 'utf8');
  for (const width of [1000, 390]) for (const agent of ['codex', 'claude']) {
    for (const outcome of ['matching', 'wrong-account', 'failed', 'cancelled']) await t.test(`${width}px ${agent} ${outcome}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 950 } });
      page.setDefaultTimeout(5000);
      t.after(() => page.close());
      await page.setContent(`<style>${css}</style><button id="accountsBtn">アカウント</button><div id="menu"></div>`);
      await page.addScriptTag({ content: `${helpers}
        ${model.match(/function usageWindow\([\s\S]*?\n}/)[0]}
        const $ = selector => document.querySelector(selector), calls = [], refreshed = [];
        const agent = ${JSON.stringify(agent)}, outcome = ${JSON.stringify(outcome)}, key = agent + ':fictional';
        const account = { key, agent, label: 'テスト', short: 'T', plan: 'prolite', signedIn: [], inHeader: true,
          usage: { status: 'error', code: 'login_required' }, limits: { at: Date.now(), source: 'live',
            primary: { usedPercent: 27, windowMinutes: 10080, resetsAt: Date.now() + 86400000 }, secondary: null } };
        const state = { filters: {}, board: { accounts: { accounts: [account], homes: [], colors: [], profiles: [],
          unknown: { codex: 0, claude: 0 }, refresh: { enabled: false, intervalMinutes: 5 } } } };
        const workspace = { hasDrafts: () => false }, load = async () => {}, toast = () => {};
        const colorVar = () => '#aaa', heat = () => 'normal', fmtDate = () => '記録時刻', relTime = () => '今';
        const closePopover = () => $('#menu').replaceChildren(), popover = (anchor, title, body) => $('#menu').replaceChildren(body);
        const pending = { id: 'pending', agent, expectedKey: key, pending: true, dir: '/tmp/fictional-canban-account' };
        let reply = { sessionId: 'fixture', state: 'waiting', authUrl: 'https://example.com/auth?state=fictional' };
        const completion = { sessionId: 'fixture', state: ['matching', 'wrong-account'].includes(outcome) ? 'succeeded' : outcome,
          account: { key: outcome === 'wrong-account' ? agent + ':other' : key }, authUrl: null };
        const bridge = { callTool: async (name, args) => {
          calls.push({ name, args });
          if (name === 'canban_login_browsers') return { result: { browsers: [{ id: 'safari', label: 'Safari', profiles: [] }] } };
          if (name === 'canban_start_account_login') return { result: { profile: pending, login: { ...reply } } };
          if (name === 'canban_account_login_status') return { result: { ...reply } };
          if (name === 'canban_account_login_open') return { result: { ...reply } };
          return { result: {} };
        } };
        const act = (name, args) => bridge.callTool(name, args);
        ${accounts}
        refreshAccountUsage = args => { if (!args.automatic) refreshed.push(args); };
        window.calls = calls; window.refreshed = refreshed;
        window.complete = () => { reply = completion; };
        accountsMenu($('#accountsBtn'));
      ` });
      const meter = page.locator('.acct-usage-grid');
      assert.equal(await meter.locator(':scope > div').count(), 1);
      assert.doesNotMatch(await meter.innerText(), /5時間枠|未取得/);
      const dimensions = await meter.evaluate(el => ({ total: el.clientWidth, item: el.firstElementChild.clientWidth }));
      assert.ok(Math.abs(dimensions.total - dimensions.item) <= 1, 'a single reported window fills the available width');
      await page.locator('.acct-auth-action').getByRole('button', { name: 'ターミナルでログイン', exact: true }).click();
      const terminal = await page.evaluate(() => window.calls.find(c => c.name === 'canban_start_account_login').args);
      assert.deepEqual(terminal, { agent, key: `${agent}:fictional`, method: 'terminal' });
      await page.getByRole('button', { name: 'ログインして最新の使用量を取得', exact: true }).click();
      await page.getByRole('dialog', { name: 'アカウントに再ログイン', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '追加してログイン', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'ログインを開始', exact: true }).click();
      const started = await page.evaluate(() => window.calls.filter(c => c.name === 'canban_start_account_login').at(-1).args);
      assert.equal(started.method, 'browser');
      assert.equal(started.key, terminal.key);
      assert.equal(started.agent, terminal.agent);
      await page.evaluate(() => window.complete());
      if (outcome === 'matching') {
        await page.getByRole('button', { name: 'ログインしました', exact: true }).waitFor();
        await page.waitForFunction(() => window.refreshed.length === 1);
        assert.deepEqual(await page.evaluate(() => window.refreshed), [{ key: `${agent}:fictional` }]);
        // A repeated view of the same completed session must not refresh usage twice.
        await page.evaluate(() => document.querySelector('.login-url-area button:last-child').click());
        await page.waitForFunction(() => window.calls.some(c => c.name === 'canban_account_login_open'));
        assert.equal(await page.evaluate(() => window.refreshed.length), 1);
      } else {
        const message = outcome === 'wrong-account' ? '別のアカウントでは更新されません。'
          : outcome === 'failed' ? '認証に失敗しました' : '認証をキャンセルしました';
        await page.locator('.login-status').filter({ hasText: message }).waitFor();
        assert.equal(await page.evaluate(() => window.refreshed.length), 0);
      }
      const dialogSize = await page.getByRole('dialog').evaluate(el => ({ width: el.clientWidth, content: el.scrollWidth }));
      assert.ok(dialogSize.content <= dialogSize.width + 1, 'reauthentication fits the viewport');
    });
  }
});

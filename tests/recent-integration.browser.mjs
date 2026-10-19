// Fictional sessions and an isolated shell only; never sends a conversation or opens a real agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { makeFixtures } from './helpers.mjs';

test('integrated composer, answers, terminal keys and palette keep drafts', { timeout: 120000 }, async t => {
  const fx = makeFixtures(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-integrate-'));
  const db = new DatabaseSync(path.join(fx.codexHome, 'state_5.sqlite'));
  db.prepare('UPDATE threads SET cwd=?, updated_at_ms=? WHERE id=?').run(dir, Date.now(), 't1'); db.close();
  fs.appendFileSync(fx.rollout, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', phase: 'final', content: [{ type: 'Text', text: '- A: 先に進む\n- B: 後で進む\n\nどちらにしますか？' }] } } }) + '\n');
  const port = 5400 + Math.floor(Math.random() * 400);
  const host = spawn(process.execPath, ['tests/dev-host.mjs', String(port)], { stdio: 'ignore', env: {
    ...process.env, CANBAN_DATA_DIR: dir, CANBAN_CODEX_HOME: fx.codexHome, CANBAN_CLAUDE_HOME: fx.claudeHome,
    CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir, CANBAN_LAUNCH_DRYRUN: '1', CANBAN_BACKGROUND: '0', CANBAN_SEARCH_INDEX: '0',
  } });
  t.after(() => { host.kill(); fx.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://localhost:${port}`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  const require = createRequire(process.env.CANBAN_PLAYWRIGHT_PACKAGE || import.meta.url);
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CANBAN_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://localhost:${port}/direct`);
  await page.locator('.card[data-card-id="codex:t1"]').click();
  const pane = page.locator('.pane[data-card-id="codex:t1"]');
  const input = pane.locator('.send-box textarea'); await input.waitFor();
  await input.fill('保持する下書き');
  await pane.locator('.cx-choice').nth(0).click();
  await pane.locator('.cx-choice').nth(1).click();
  assert.equal(await input.inputValue(), '保持する下書き\nBでお願いします。');
  await pane.evaluate(el => el.focus());
  await page.keyboard.press('t');
  await pane.getByRole('button', { name: /^終了/ }).waitFor();
  await page.keyboard.press('Shift+Escape');
  assert.equal(await pane.evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Meta+k');
  assert.ok((await page.locator('.palette').textContent()).includes('カードのターミナルを開閉'));
  assert.ok((await page.locator('.palette').textContent()).includes('ターミナルのシェルを終了'));
  await page.keyboard.press('Escape');
  await pane.evaluate(el => el.focus());
  await page.keyboard.press('Shift+X');
  await pane.getByRole('button', { name: /^開き直す/ }).waitFor();
  await page.keyboard.press('Shift+R');
  await pane.getByRole('button', { name: /^終了/ }).waitFor();
  assert.equal(await input.inputValue(), '保持する下書き\nBでお願いします。');
  const shots = process.env.CANBAN_INTEGRATION_SHOTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  for (const view of ['board', 'timeline']) {
    if (view === 'timeline') {
      await pane.locator('.pane-close').click();
      await page.locator('#sideBtn').focus();
      await page.keyboard.press('i');
      await page.locator('.irow[data-card-id="codex:t1"]').click();
      await input.waitFor();
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.waitForTimeout(100);
      if (shots) await page.screenshot({ path: path.join(shots, `${view}-${theme}.png`) });
      await pane.evaluate(el => el.focus());
      await page.keyboard.press('t');
      if (shots) await page.screenshot({ path: path.join(shots, `${view}-${theme}-composer.png`) });
      await page.keyboard.press('t');
      assert.equal(await input.inputValue(), '保持する下書き\nBでお願いします。');
    }
  }
  await pane.getByRole('button', { name: /^終了/ }).click();
  await page.locator('#sideBtn').focus();
  await page.keyboard.press('i');
  await page.locator('.card[data-card-id="codex:t1"]').click();
  assert.equal(await input.inputValue(), '保持する下書き\nBでお願いします。');
  assert.deepEqual(errors, []);
});

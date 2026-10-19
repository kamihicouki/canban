// Fictional conversation only. Answer buttons fill a draft; no prompt or approval is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { makeFixtures } from './helpers.mjs';

test('answered questions stop offering replies across live updates and reopening', { timeout: 120000 }, async t => {
  const fx = makeFixtures(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-answer-'));
  const question = '今回は公開を見送ってよいですか？', draft = '補足する未送信の文章';
  const events = fs.readFileSync(fx.rollout, 'utf8').trim().split('\n').map(JSON.parse), final = events.pop();
  for (let i = 0; i < 40; i++) events.push({ ...final, payload: { ...final.payload, item: { ...final.payload.item, id: `history-${i}`, content: [{ type: 'Text', text: `架空の過去メッセージ ${i}` }] } } });
  final.payload.item.content[0].text = question; events.push(final);
  fs.writeFileSync(fx.rollout, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  const db = new DatabaseSync(path.join(fx.codexHome, 'state_5.sqlite'));
  db.prepare('UPDATE threads SET title=?, name=?, updated_at_ms=? WHERE id=?').run('公開方針の確認', '公開方針の確認', Date.now(), 't1'); db.close();
  const root = path.resolve('.'), port = 5600 + Math.floor(Math.random() * 300);
  const host = spawn(process.execPath, ['tests/dev-host.mjs', String(port)], { stdio: 'ignore', env: {
    ...process.env, CANBAN_DATA_DIR: dir, CANBAN_CODEX_HOME: fx.codexHome, CANBAN_CLAUDE_HOME: fx.claudeHome,
    CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir, CANBAN_LAUNCH_DRYRUN: '1', CANBAN_BACKGROUND: '0', CANBAN_SEARCH_INDEX: '0',
    CANBAN_GH: path.join(root, 'tests/fake-gh.sh'), CANBAN_GLAB: path.join(root, 'tests/fake-glab.sh'), FAKE_GH_DATA: '/dev/null',
  } });
  t.after(() => { host.kill(); fx.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://localhost:${port}`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  const { chromium } = createRequire(process.env.CANBAN_PLAYWRIGHT_PACKAGE || import.meta.url)('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CANBAN_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }), errors = [], writes = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/rpc', async route => {
    const request = route.request(), name = request.method() === 'POST' ? request.postDataJSON()?.name : '';
    if (/^canban_(dispatch|send_prompt|start_session|create_task|approve)/.test(name)) {
      writes.push(name); await route.fulfill({ json: { result: { isError: true, content: [{ type: 'text', text: '試験では送信しません' }] } } });
    } else await route.continue();
  });
  await page.goto(`http://localhost:${port}/direct`);
  const stale = process.env.CANBAN_EXPECT_STALE_CHOICES === '1', expected = stale ? 2 : 0;
  const shots = process.env.CANBAN_ANSWERED_SHOTS; if (shots) fs.mkdirSync(shots, { recursive: true });
  const pane = page.locator('.pane[data-card-id="codex:t1"]'), input = pane.locator('.send-box textarea');
  const focusSamples = [];
  const checkChoiceFocus = async view => {
    const note = `架空の補足 ${view}`, last = pane.locator('.cx-choice').last();
    await input.focus(); await page.keyboard.press('Shift+Tab');
    assert.equal(await last.evaluate(el => el === document.activeElement), true, 'Shift+Tab reaches the last answer');
    const started = performance.now();
    fs.appendFileSync(fx.rollout, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', phase: 'commentary', content: [{ type: 'Text', text: note }] } } }) + '\n');
    await pane.locator('.fi-note').filter({ hasText: note }).waitFor();
    const retained = await last.evaluate(el => el === document.activeElement);
    assert.equal(retained, process.env.CANBAN_EXPECT_CHOICE_FOCUS_LOSS !== '1', 'unchanged choices keep keyboard focus');
    focusSamples.push({ view, retained, updateMs: Math.round((performance.now() - started) * 10) / 10 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      if (shots) await page.screenshot({ path: path.join(shots, `focus-${view}-${theme}.png`) });
    }
    await last.focus(); await page.keyboard.press('Tab');
    assert.equal(await input.evaluate(el => el === document.activeElement), true, 'Tab reaches the existing composer');
  };
  const answer = '今回は見送ります。';
  await page.locator('.card[data-card-id="codex:t1"]').click(); await pane.locator('.cx-choice').first().waitFor();
  await input.fill(draft); const feed = pane.locator('.feed');
  await checkChoiceFocus('board');
  assert.equal(await input.inputValue(), draft);
  await feed.evaluate(el => { el.scrollTop = 200; });
  const reading = await feed.evaluate(el => el.scrollTop);
  await page.keyboard.press('Meta+k'); await page.locator('.palette input').fill('答える:');
  assert.equal(await page.locator('.palette .picker-row').count(), 2);
  const appendAt = performance.now();
  fs.appendFileSync(fx.rollout, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'fictional-reply', content: [{ type: 'text', text: answer }] } } }) + '\n');
  await page.waitForFunction(answer => [...document.querySelectorAll('.fi-user .raw')].some(el => el.textContent === answer), answer);
  assert.equal(await pane.locator('.cx-choice').count(), expected);
  assert.equal(await page.locator('.palette .picker-row').count(), expected, 'an already-open palette drops old answers');
  assert.equal(await page.locator('.palette input').inputValue(), '答える:');
  assert.equal(await page.locator('.palette input').evaluate(el => el === document.activeElement), true);
  const appendToChoicesMs = Math.round((performance.now() - appendAt) * 10) / 10;
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    if (shots) await page.screenshot({ path: path.join(shots, `palette-${theme}.png`) });
  }
  await page.keyboard.press('Escape');
  assert.equal(await feed.evaluate(el => el.scrollTop), reading, 'live reply preserves the reading position');
  for (const view of ['board', 'timeline']) {
    if (view === 'timeline') {
      await page.keyboard.press('Escape'); await pane.locator('.pane-close').click();
      await page.locator('#sideBtn').focus(); await page.keyboard.press('i'); await page.locator('.irow[data-card-id="codex:t1"]').click();
      await input.waitFor();
    }
    assert.equal(await input.inputValue(), draft);
    assert.equal(await pane.locator('.cx-choice').count(), expected);
    await page.keyboard.press('Meta+k'); await page.locator('.palette input').fill('答える:');
    assert.equal(await page.locator('.palette .picker-row').count(), expected); await page.keyboard.press('Escape');
    if (!stale) {
      await input.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: '1', code: 'Digit1', altKey: true, bubbles: true, cancelable: true })));
      assert.equal(await input.inputValue(), draft, 'old answer shortcut cannot change the draft');
    }
    await feed.evaluate(el => { el.scrollTop = el.scrollHeight; }); await input.focus();
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      if (shots) await page.screenshot({ path: path.join(shots, `${view}-${theme}.png`) });
    }
  }
  await page.locator('#sideBtn').focus(); await page.keyboard.press('i'); await page.locator('.card[data-card-id="codex:t1"]').click();
  assert.equal(await input.inputValue(), draft); assert.equal(await pane.locator('.cx-choice').count(), expected);
  await page.reload();
  try { await input.waitFor({ timeout: 3000 }); } catch { await page.locator('.card[data-card-id="codex:t1"]').click(); await input.waitFor(); }
  assert.equal(await pane.locator('.cx-choice').count(), expected, 'initial full fetch also knows the question was answered');
  await page.keyboard.press('Meta+k'); await page.locator('.palette input').fill('答える:');
  fs.appendFileSync(fx.rollout, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', phase: 'final', content: [{ type: 'Text', text: '次の調査を始めてよいですか？' }] } } }) + '\n');
  await pane.locator('.cx-choice').first().waitFor(); assert.equal(await pane.locator('.cx-choice').count(), 2);
  assert.equal(await page.locator('.palette .picker-row').count(), 2, 'new answers appear in an already-open palette');
  assert.equal(await page.locator('.palette input').inputValue(), '答える:');
  const currentDraft = await input.inputValue();
  await page.keyboard.press('Enter');
  assert.equal(await input.inputValue(), currentDraft.trimEnd() ? `${currentDraft.trimEnd()}\nはい。` : 'はい。', 'fresh palette answer still fills the draft');
  await pane.locator('.pane-close').click();
  await page.locator('#sideBtn').focus(); await page.keyboard.press('i');
  await page.locator('.irow[data-card-id="codex:t1"]').click(); await input.waitFor();
  await checkChoiceFocus('timeline');
  assert.deepEqual(writes, []); assert.deepEqual(errors, []);
  if (shots) fs.writeFileSync(path.join(shots, 'metrics.json'), JSON.stringify({ viewport: [1280, 800], question, answer, choicesAfterReply: expected, paletteActionsAfterReply: expected, appendToChoicesMs, focusSamples, rawPreserved: true, draftPreserved: true, readingPositionPreserved: true, initialLoadChecked: true, nextQuestionChoices: 2, submitted: writes, errors }, null, 2));
});

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

test('yes/no picks preserve the question meaning, draft and reading position', { timeout: 120000 }, async t => {
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }), errors = [], writes = [], samples = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.url().endsWith('/rpc') && r.method() === 'POST') { const name = r.postDataJSON()?.name; if (/^canban_(send_prompt|start_session|create_task|approve)/.test(name)) writes.push(name); } });
  await page.goto(`http://localhost:${port}/direct`);
  const yes = process.env.CANBAN_EXPECT_YES_REPLY || 'はい。', no = process.env.CANBAN_EXPECT_NO_REPLY || 'いいえ。';
  const shots = process.env.CANBAN_ANSWER_SHOTS; if (shots) fs.mkdirSync(shots, { recursive: true });
  const pane = page.locator('.pane[data-card-id="codex:t1"]'), input = pane.locator('.send-box textarea');
  for (const view of ['board', 'timeline']) {
    const start = performance.now();
    await page.locator(`${view === 'board' ? '.card' : '.irow'}[data-card-id="codex:t1"]`).click();
    await pane.locator('.cx-choice').first().waitFor();
    samples.push({ view, cardOpenToAnswersMs: Math.round((performance.now() - start) * 10) / 10 });
    assert.equal(await pane.locator('.fi-asst .raw').last().textContent(), question);
    assert.deepEqual(await pane.locator('.cx-choice-t').allTextContents(), [yes.slice(0, -1), no.slice(0, -1)]);
    const feed = pane.locator('.feed'); await feed.evaluate(el => { el.scrollTop = 200; });
    const reading = await feed.evaluate(el => el.scrollTop);
    await pane.evaluate(el => el.focus()); await page.keyboard.press('i'); await input.fill(draft);
    assert.equal(await feed.evaluate(el => el.scrollTop), reading);
    await pane.locator('.cx-choice').first().click(); assert.equal(await input.inputValue(), `${draft}\n${yes}`);
    await page.keyboard.press('Alt+2'); assert.equal(await input.inputValue(), `${draft}\n${no}`);
    await page.keyboard.press('Meta+k'); await page.locator('.palette input').fill('答える: 1');
    await page.locator('.palette .picker-row').first().click(); assert.equal(await input.inputValue(), `${draft}\n${yes}`);
    await feed.evaluate(el => { el.scrollTop = el.scrollHeight; });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      if (shots) await page.screenshot({ path: path.join(shots, `${view}-${theme}.png`) });
    }
    await page.keyboard.press('Escape');
    if (view === 'board') await pane.locator('.pane-close').click();
    await page.locator('#sideBtn').focus(); await page.keyboard.press('i');
  }
  await page.locator('.card[data-card-id="codex:t1"]').click(); assert.equal(await input.inputValue(), `${draft}\n${yes}`);
  assert.deepEqual(writes, []); assert.deepEqual(errors, []);
  if (shots) fs.writeFileSync(path.join(shots, 'metrics.json'), JSON.stringify({ viewport: [1280, 800], messages: events.filter(e => e.payload?.item).length, question, yes, no, rawPreserved: true, draftPreserved: true, readingPositionPreserved: true, submitted: writes, errors, samples }, null, 2));
});

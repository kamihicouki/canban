// Compare the rendered numbering with fictional source messages; never submits a real conversation.
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
import { Store } from '../server/store.mjs';

test('continued numbering, original text, reading position and draft survive board/timeline', { timeout: 120000 }, async t => {
  const fx = makeFixtures(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-list-'));
  const original = '3. 変更内容を確認する\n4. 検証結果を読んでから反映する';
  const events = fs.readFileSync(fx.rollout, 'utf8').trim().split('\n').map(JSON.parse);
  for (const e of events) { const it = e.payload?.item; if (it && (it.type === 'UserMessage' || it.phase === 'final')) it.content[0].text = original; }
  const final = events.pop();
  for (let i = 0; i < 60; i++) events.push({ ...final, payload: { ...final.payload, item: { ...final.payload.item, id: `history-${i}`, content: [{ type: 'Text', text: `架空の過去メッセージ ${i}` }] } } });
  events.push(final); fs.writeFileSync(fx.rollout, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  const db = new DatabaseSync(path.join(fx.codexHome, 'state_5.sqlite'));
  db.prepare('UPDATE threads SET updated_at_ms=? WHERE id=?').run(Date.now(), 't1'); db.close();
  const fixtureStore = new Store(dir); await fixtureStore.load();
  const task = await fixtureStore.createTask({ title: '途中から続く手順', description: original }); fixtureStore.close();
  const port = 5600 + Math.floor(Math.random() * 300), root = path.resolve('.');
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }), errors = [], metrics = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://localhost:${port}/direct`);
  const shots = process.env.CANBAN_MARKDOWN_SHOTS, expected = Number(process.env.CANBAN_EXPECT_LIST_START || 3);
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const pane = page.locator('.pane[data-card-id="codex:t1"]'), input = pane.locator('.send-box textarea');
  for (const view of ['board', 'timeline']) {
    const start = performance.now();
    await page.locator(`${view === 'board' ? '.card' : '.irow'}[data-card-id="codex:t1"]`).click();
    await pane.locator('.fi-user .md ol').waitFor();
    metrics.push({ view, cardOpenToBodyMs: Math.round((performance.now() - start) * 10) / 10 });
    assert.equal(await pane.locator('.fi-user .raw').first().textContent(), original);
    assert.equal(await pane.locator('.fi-user .md ol').first().evaluate(el => el.start), expected);
    assert.equal(await pane.locator('.fi-asst .md ol').last().evaluate(el => el.start), expected);
    const feed = pane.locator('.feed');
    await feed.evaluate(el => { el.scrollTop = 0; });
    await pane.evaluate(el => el.focus()); await page.keyboard.press('i');
    await input.fill('保持する未送信の下書き');
    assert.equal(await feed.evaluate(el => el.scrollTop), 0, 'focusing composer preserves the reading position');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      if (shots) await page.screenshot({ path: path.join(shots, `${view}-${theme}.png`) });
    }
    await page.keyboard.press('Escape');
    assert.equal(await input.inputValue(), '保持する未送信の下書き');
    if (view === 'board') await pane.locator('.pane-close').click();
    await page.locator('#sideBtn').focus(); await page.keyboard.press('i');
  }
  await page.locator('.card[data-card-id="codex:t1"]').click();
  assert.equal(await input.inputValue(), '保持する未送信の下書き');
  await pane.locator('.pane-close').click();
  await page.locator(`.card[data-card-id="${task.cardId}"]`).click();
  const taskPane = page.locator('.pane[data-kind="task"]');
  const taskDescription = taskPane.getByRole('textbox', { name: '説明', exact: true });
  assert.equal(await taskDescription.inputValue(), original, 'task descriptions remain editable original text');
  assert.deepEqual(errors, []);
  if (shots) fs.writeFileSync(path.join(shots, 'metrics.json'), JSON.stringify({ viewport: [1280, 800], messages: events.filter(e => e.payload?.item).length, primaryActionsPerView: 4, expectedStart: expected, actualStart: expected, taskDescriptionUnchanged: true, rawPreserved: true, draftPreserved: true, readingPositionPreserved: true, errors, samples: metrics }, null, 2));
});

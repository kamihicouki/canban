// 作成されたチャット（案B：親子ネスト連結スタック）の実ブラウザ検証と 1280x800 スクリーンショット確認用テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { stopChild } from './helpers.mjs';

const chromeBin = process.env.CANBAN_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const envelope = (sourceId, input = '調査して') => `<codex_delegation>\n<source_thread_id>${sourceId}</source_thread_id>\n<input>${input}</input>\n</codex_delegation>`;

function makeCreatedChatsFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-created-browser-'));
  const codexHome = path.join(dir, 'codex');
  const claudeHome = path.join(dir, 'claude');
  const desktopDir = path.join(dir, 'desktop');
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.mkdirSync(desktopDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const nowSec = Math.floor(Date.now() / 1000);
  const nowIso = new Date().toISOString();
  const makeRollout = (name, id, parentId, assistantMsg, active = false) => {
    const file = path.join(codexHome, 'sessions', `${name}.jsonl`);
    const lines = [
      JSON.stringify({ timestamp: nowIso, type: 'session_meta', payload: { id } }),
      ...(parentId ? [JSON.stringify({
        timestamp: nowIso,
        type: 'event_msg',
        payload: { type: 'item_completed', item: { type: 'FunctionCallOutput', namespace: 'codex_app', name: 'create_thread', output: envelope(parentId, `${name} のタスク`) } },
      })] : [JSON.stringify({
        timestamp: nowIso,
        type: 'event_msg',
        payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: '本番リリース準備を開始して各確認を別チャットへ委任してください。' }] } },
      })]),
      ...(active
        ? [JSON.stringify({ timestamp: nowIso, type: 'event_msg', payload: { type: 'task_started' } })]
        : [JSON.stringify({ timestamp: nowIso, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', phase: 'final', content: [{ type: 'Text', text: assistantMsg }] } } })]),
    ];
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
  };

  const rParent = makeRollout('p1', 'p1', null, '', true);
  const rSame = makeRollout('c1', 'c1', 'p1', '', true);
  const rDone1 = makeRollout('c2', 'c2', 'p1', 'Preview 一覧・詳細の表示一致を確認しました。', false);
  const rDone2 = makeRollout('c3', 'c3', 'p1', '共有端末でのセッション分離を確認しました。', false);
  const rDormant = makeRollout('c4', 'c4', 'p1', '過去の仕様確認が完了しています。', false);
  const rSingle = makeRollout('s1', 's1', null, '日次セキュリティチェック完了。', false);

  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, updated_at_ms INTEGER,
    source TEXT, thread_source TEXT, cwd TEXT, title TEXT, name TEXT, archived INTEGER, git_branch TEXT, model TEXT,
    first_user_message TEXT, preview TEXT, agent_role TEXT, is_pinned INTEGER, thread_section_id TEXT)`);
  const ins = db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  ins.run('p1', rParent, nowSec - 600, nowSec - 10, (nowSec - 10) * 1000, 'vscode', 'user', '/r/pair-match', '本番リリース準備を開始', '本番リリース準備を開始', 0, 'main', 'gpt-6-sol', '本番リリース準備', '', null, 1, null);
  ins.run('c1', rSame, nowSec - 500, nowSec - 5, (nowSec - 5) * 1000, 'vscode', 'agent_created_thread', '/r/pair-match', 'グローバルセッション作成前の確認を毎回実行', 'グローバルセッション作成前の確認を毎回実行', 0, 'chore/precheck', 'gpt-6-sol', '', '', null, 0, null);
  ins.run('c2', rDone1, nowSec - 400, nowSec - 60, (nowSec - 60) * 1000, 'vscode', 'agent_created_thread', '/r/pair-match', 'Preview 一覧・詳細の表示が確定しない原因', 'Preview 一覧・詳細の表示が確定しない原因', 0, 'fix/preview', 'gpt-6-sol', '', '', null, 0, null);
  ins.run('c3', rDone2, nowSec - 300, nowSec - 120, (nowSec - 120) * 1000, 'vscode', 'agent_created_thread', '/r/pair-match', '共有端末の新規セッションでテスト選手が混在', '共有端末の新規セッションでテスト選手が混在', 0, 'fix/shared', 'gpt-6-sol', '', '', null, 0, null);
  const oldSec = nowSec - 10 * 86400;
  ins.run('c4', rDormant, oldSec, oldSec, oldSec * 1000, 'vscode', 'agent_created_thread', '/r/pair-match', '過去の構成メモ確認（休眠）', '過去の構成メモ確認（休眠）', 0, 'docs/old', 'gpt-6-sol', '', '', null, 0, null);
  ins.run('s1', rSingle, nowSec - 200, nowSec - 90, (nowSec - 90) * 1000, 'vscode', 'user', '/r/pair-match', '日次セキュリティチェックを回す', '日次セキュリティチェックを回す', 0, 'main', 'gpt-6-sol', '', '', null, 0, null);
  db.close();

  return {
    dir,
    codexHome,
    claudeHome,
    desktopDir,
    dataDir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('案B（親子ネスト連結スタック）がボード・照らし・時間軸・カード詳細で正しく動作する', {
  timeout: 90000,
  skip: !fs.existsSync(chromeBin) && 'Chrome executable not found',
}, async (t) => {
  const fx = makeCreatedChatsFixture();
  const port = 5600 + Math.floor(Math.random() * 200);
  const host = spawn(process.execPath, ['tests/dev-host.mjs', String(port)], {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...process.env,
      CANBAN_DATA_DIR: fx.dataDir,
      CANBAN_CODEX_HOME: fx.codexHome,
      CANBAN_CLAUDE_HOME: fx.claudeHome,
      CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir,
      CANBAN_LAUNCH_DRYRUN: '1',
      ...Object.fromEntries(['ANTIGRAVITY_DIR', 'GEMINI_HOME', 'CURSOR_HOME', 'CURSOR_WORKSPACE_DIR', 'CHATGPT_DIR', 'GROK_HOME']
        .map(key => ['CANBAN_' + key, path.join(fx.dir, 'empty')])),
      CANBAN_SEARCH_INDEX: '0',
      CANBAN_BACKGROUND: '0',
    },
  });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-created-chrome-'));
  const cdpPort = port + 1000;
  const chrome = spawn(chromeBin, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let ws;
  t.after(async () => {
    ws?.close();
    await Promise.all([stopChild(host), stopChild(chrome)]);
    fx.cleanup();
    fs.rmSync(profile, { recursive: true, force: true });
  });

  // dev-host 上で c2, c3 を完了リスト「done」へ配置
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}`)).ok) break; } catch {}
    await sleep(100);
  }
  const rpc = (name, args) => fetch(`http://127.0.0.1:${port}/rpc`, { method: 'POST', body: JSON.stringify({ name, arguments: args }) }).then((r) => r.json());
  const boardInit = (await rpc('canban_get_board', { days: 0 })).result.structuredContent;
  const doneList = boardInit.lists.find((l) => l.id === 'done') || boardInit.lists.at(-1);
  const doingList = boardInit.lists.find((l) => l.id === 'doing') || boardInit.lists[0];
  await rpc('canban_move_card', { cardId: 'codex:p1', toList: doingList.id, order: 1 });
  await rpc('canban_move_card', { cardId: 'codex:c1', toList: doingList.id, order: 2 });
  await rpc('canban_move_card', { cardId: 'codex:c2', toList: doneList.id, order: 1 });
  await rpc('canban_move_card', { cardId: 'codex:c3', toList: doneList.id, order: 2 });
  await rpc('canban_move_card', { cardId: 'codex:c4', toList: doingList.id, order: 3 });
  const task = (await rpc('canban_create_task', { title: 'リリース前の作業', listId: doingList.id })).result.structuredContent;
  await rpc('canban_link_session', { taskId: task.cardId, sessionId: 'codex:s1' });

  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(150);
    try { target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((x) => x.type === 'page'); } catch {}
  }
  assert.ok(target, 'Chrome started');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/direct` });

  for (let i = 0; i < 60; i++) {
    const ready = await cdp('Runtime.evaluate', { expression: '!!document.querySelector(".cc-stack .cc-nested")', returnByValue: true });
    if (ready.result?.result?.value) break;
    await sleep(200);
  }

  const shotsDir = process.env.CANBAN_CREATED_CHATS_SHOTS ? path.resolve(process.env.CANBAN_CREATED_CHATS_SHOTS) : null;
  if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

  const runCheck = async (expr) => {
    const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    assert.equal(r.result?.exceptionDetails, undefined, JSON.stringify(r.result?.exceptionDetails));
    return r.result?.result?.value;
  };

  // 1. ボード上の案Bネストと重複無し・別リスト親帯・照らし・Shift+P を確認
  const boardCheck = await runCheck(`
    const w = (ms = 200) => new Promise(r => setTimeout(r, ms));
    if (document.querySelector('#sideBtn')?.getAttribute('aria-pressed') === 'true') document.querySelector('#sideBtn').click();
    await w(150);
    const pCard = document.querySelector('.cc-stack > .card[data-card-id="codex:p1"]');
    const nested = document.querySelectorAll('.cc-stack .cc-nested[data-card-id="codex:c1"]');
    const allC1 = document.querySelectorAll('#board .card[data-card-id="codex:c1"]');
    const remoteBands = document.querySelectorAll('#board .card .cc-parent-band');
    const remoteNote = document.querySelector('.cc-stack-remote');
    if (!pCard) throw new Error('parent stack missing');
    if (nested.length !== 1 || allC1.length !== 1) throw new Error('nested child missing or duplicated: ' + nested.length + '/' + allC1.length);
    if (remoteBands.length < 2) throw new Error('remote child parent bands missing: ' + remoteBands.length);
    if (!remoteNote) throw new Error('remote summary button missing');
    if (pCard.querySelector('.session-kind')?.textContent !== 'セッション') throw new Error('ordinary session kind missing');
    if (nested[0].querySelector('.session-kind')?.textContent !== '作成チャット') throw new Error('created child kind missing');
    if (!nested[0].getAttribute('aria-label')?.includes('作成されたチャット')) throw new Error('card accessible name lacks its kind');
    if (!document.querySelector('#board .card.task .who-task')?.textContent.includes('タスクカード')) throw new Error('task kind missing');

    // 照らすボタンでファミリーハイライト + アプリバーチップ + Esc解除
    remoteNote.click(); await w(150);
    if (!document.querySelector('#board.lens-on')) throw new Error('family lens did not turn on');
    if (document.querySelectorAll('#board .card.lens-hit').length !== 4) throw new Error('expected 4 awake family cards lit, got ' + document.querySelectorAll('#board .card.lens-hit').length);
    if (!document.querySelector('#filterChips').textContent.includes('親子:')) throw new Error('filter chip missing for family lens');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await w(100);
    if (document.querySelector('#board.lens-on')) throw new Error('Esc did not clear family lens');

    // Shift+P でトグルできること
    pCard.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', code: 'KeyP', shiftKey: true, bubbles: true })); await w(100);
    if (!document.querySelector('#board.lens-on')) throw new Error('Shift+P did not enable family lens');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await w(100);

    // 折りたたみトグル
    const bar = pCard.querySelector('.cc-parent-bar');
    bar.click(); await w(100);
    if (document.querySelector('.cc-stack .cc-stack-children')) throw new Error('parent bar did not collapse children');
    bar.click(); await w(100);
    if (!document.querySelector('.cc-stack .cc-nested')) throw new Error('parent bar did not re-expand children');
    return { remoteText: remoteNote.textContent };
  `);
  assert.match(boardCheck.remoteText, /ほか/);

  if (shotsDir) {
    for (const theme of ['light', 'dark']) {
      await runCheck(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; await new Promise(r => setTimeout(r, 150));`);
      const shot = await cdp('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(shotsDir, `created-board-${theme}.png`), Buffer.from(shot.result.data, 'base64'));
    }
  }

  // 2. カード詳細（2カラム）関連セクション＆時間軸ツリー
  await runCheck(`
    const w = (ms = 200) => new Promise(r => setTimeout(r, ms));
    document.documentElement.dataset.theme = 'light';
    document.querySelector('.card[data-card-id="codex:p1"]').click();
    for (let i = 0; i < 40 && !document.querySelector('.pane[data-card-id="codex:p1"] [data-sec="related"]'); i++) await w(100);
    const relText = document.querySelector('.pane[data-card-id="codex:p1"] [data-sec="related"]').textContent;
    if (!relText.includes('作成されたチャット（4）')) throw new Error('detail missing created chats list: ' + relText);
    const childJump = [...document.querySelectorAll('.pane[data-card-id="codex:p1"] [data-sec="related"] .sub-row')].find(b => b.textContent.includes('Preview 一覧'));
    childJump.click();
    for (let i = 0; i < 40 && !document.querySelector('.pane[data-card-id="codex:c2"] [data-sec="related"]'); i++) await w(100);
    const childRel = document.querySelector('.pane[data-card-id="codex:c2"] [data-sec="related"]').textContent;
    if (!childRel.includes('作成元（親チャット）') || !childRel.includes('同じ親の作成チャット')) throw new Error('child detail missing parent/siblings: ' + childRel);
    document.querySelector('.pane-close')?.click(); await w(150);

    // 時間軸へ切替
    document.querySelector('#viewSwitch [aria-label="時間軸"]').click();
    await w(300);
    const subs = document.querySelectorAll('.iwork-created .irow-sub');
    if (subs.length < 1) throw new Error('timeline missing nested created chat rows');
    if (subs[0].querySelector('.session-kind')?.textContent !== '作成チャット') throw new Error('timeline created child kind missing');
    for (const btn of document.querySelectorAll('.iwork:not(.iwork-created) .irow-more[aria-expanded="false"]')) btn.click();
    const linked = document.querySelector('.iwork:not(.iwork-created) .irow-sub[data-card-id="codex:s1"]');
    if (linked?.querySelector('.session-kind')?.textContent !== 'セッション') throw new Error('linked session kind missing');
    if (!linked.dataset.parentId?.startsWith('task:') || subs[0].dataset.parentId !== 'codex:p1') throw new Error('existing grouping changed');
    const child = document.querySelector('.iwork-created .irow-sub');
    const childId = child.dataset.cardId;
    child.click(); await w(250);
    if (document.querySelector('.iwork-created .irow-sub[data-card-id="' + childId + '"]')?.getAttribute('aria-selected') !== 'true') throw new Error('timeline created child selection lost');
    const compactKind = () => document.querySelector('.pane[data-card-id="' + childId + '"][data-context-open="false"] .ws-current-state');
    for (let i = 0; i < 40 && !compactKind(); i++) await w(100);
    if (!compactKind()?.textContent.includes('作成チャット')) throw new Error('docked compact detail kind missing');
  `);

  if (shotsDir) {
    for (const theme of ['light', 'dark']) {
      await runCheck(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; await new Promise(r => setTimeout(r, 150));`);
      const shot = await cdp('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(shotsDir, `created-timeline-${theme}.png`), Buffer.from(shot.result.data, 'base64'));
    }
  }

  assert.deepEqual(pageErrors.filter((e) => !/ResizeObserver/.test(e)), []);
  ws.close();
});

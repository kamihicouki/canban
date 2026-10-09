#!/usr/bin/env node
// Render the current logo and source UI for the store. Only an isolated localhost
// development host and a temporary, extension-free Chrome profile are used.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { makeFixtures } from '../tests/helpers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, 'chrome/store');
const local = path.join(root, '.local/store-assets');
const chromeBin = process.env.CANBAN_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const brandingOnly = process.argv.includes('--branding-only');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-store-art-'));
const port = 5300 + Math.floor(Math.random() * 400);
const cdpPort = port + 1000;
let host, chrome, ws, fx, data;
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(local, { recursive: true });

try {
  chrome = spawn(chromeBin, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--disable-extensions', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((x) => x.type === 'page'); } catch {}
    if (!target) await sleep(100);
  }
  if (!target) throw new Error('Chrome could not start');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let serial = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
  };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  const size = (width, height) => cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const capture = async (file) => {
    const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log(path.relative(root, file));
  };
  await cdp('Runtime.enable');
  await cdp('Page.enable');

  const css = fs.readFileSync(path.join(root, 'ui/base.css'), 'utf8');
  const color = (token) => css.match(new RegExp(`--${token}:\\s*([^;]+)`))[1].trim();
  const logo = fs.readFileSync(path.join(root, 'ui/icons.js'), 'utf8').match(/const LOGO_SVG = '([^']+)'/)[1]
    .replace('class="logo-mark" ', '').replace('aria-hidden="true"', 'xmlns="http://www.w3.org/2000/svg"')
    .replaceAll('var(--logo-bg)', color('logo-bg')).replaceAll('var(--logo-fg)', color('logo-fg'));
  fs.writeFileSync(path.join(root, 'assets/canban.svg'), `${logo}\n`);
  const render = async (svg, width, height, file) => {
    await size(width, height);
    await cdp('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await cdp('Page.navigate', { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` });
    await sleep(180);
    await capture(file);
  };
  const icon = (px, inset) => `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}"><g transform="translate(${inset} ${inset}) scale(${(px - inset * 2) / 32})">${logo.replace(/<svg[^>]*>|<\/svg>/g, '')}</g></svg>`;
  for (const px of [16, 48, 128]) await render(icon(px, 0), px, px, path.join(root, `chrome/icons/icon-${px}.png`));
  await render(icon(512, 0), 512, 512, path.join(root, 'assets/canban.png'));
  const mark = (x, y, px) => `<g transform="translate(${x} ${y}) scale(${px / 32})">${logo.replace(/<svg[^>]*>|<\/svg>/g, '')}</g>`;
  const font = 'font-family="Avenir Next, Hiragino Sans, sans-serif"';
  const bg = `<defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="${color('board-bg')}"/><stop offset="1" stop-color="${color('board-bg-2')}"/></linearGradient></defs>`;
  const small = `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="280" viewBox="0 0 440 280">${bg}<rect width="440" height="280" fill="url(#bg)"/>${mark(188, 35, 64)}<g fill="white" ${font} text-anchor="middle"><text x="220" y="153" font-size="44" font-weight="700" letter-spacing="-.6">canban</text><text x="220" y="192" font-size="17" font-weight="600">AI の仕事を、ひとつのボードへ。</text><text x="220" y="237" font-size="14" opacity=".86">Codex · Claude Code</text></g></svg>`;
  const marquee = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="560" viewBox="0 0 1400 560">${bg}<rect width="1400" height="560" fill="url(#bg)"/>${mark(92, 112, 96)}<g fill="white" ${font}><text x="218" y="188" font-size="78" font-weight="700" letter-spacing="-1">canban</text><text x="92" y="302" font-size="35" font-weight="600">AI の仕事を、ひとつのボードへ。</text><text x="94" y="359" font-size="24" opacity=".86">Codex · Claude Code</text><text x="94" y="449" font-size="21" opacity=".86">ボード / 時間軸 / スレッド型のカード詳細</text></g><g fill="white"><rect x="833" y="102" width="134" height="356" rx="25" opacity=".18"/><rect x="995" y="102" width="134" height="242" rx="25" opacity=".18"/><rect x="1157" y="102" width="134" height="136" rx="25" opacity=".18"/><rect x="851" y="125" width="98" height="95" rx="13" opacity=".95"/><rect x="851" y="238" width="98" height="76" rx="13" opacity=".75"/><rect x="851" y="332" width="98" height="101" rx="13" opacity=".55"/><rect x="1013" y="125" width="98" height="82" rx="13" opacity=".95"/><rect x="1013" y="225" width="98" height="96" rx="13" opacity=".7"/><rect x="1175" y="125" width="98" height="89" rx="13" opacity=".9"/><circle cx="1224" cy="387" r="49" opacity=".95"/></g></svg>`;
  for (const [name, svg, width, height] of [['promo-small', small, 440, 280], ['promo-marquee', marquee, 1400, 560]]) {
    fs.writeFileSync(path.join(out, `${name}.svg`), `${svg}\n`);
    await render(svg, width, height, path.join(out, `${name}.png`));
  }
  if (brandingOnly) process.exitCode = 0;
  else {
    fx = makeFixtures();
    const now = Date.now();
    const iso = (age) => new Date(now - age).toISOString();
    const line = (x) => `${JSON.stringify(x)}\n`;
    const db = new DatabaseSync(path.join(fx.codexHome, 'state_5.sqlite'));
    db.exec('DELETE FROM threads; DELETE FROM thread_sections;');
    fs.writeFileSync(path.join(fx.codexHome, '.codex-global-state.json'), '{}');
    const insert = db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const samples = [
      ['ログイン画面をわかりやすくする', 'design/login', 30_000, '入力欄とエラー表示の見直しを進めています。', '実装前に、変更点と確認方法を整理してください。'],
      ['検索結果の表示を速くする', 'perf/search', 90_000, '表示時間を計測し、検索の処理を調べています。', '検索結果が出るまでの時間を短くしてください。'],
      ['通知設定の動作を確認する', 'test/notifications', 3_600_000, '通知の切り替えと保存を確認しました。', '通知設定が保存されることを確認してください。'],
      ['キーボード操作を整える', 'feat/shortcuts', 86_400_000, 'よく使う操作にキーとヒントを追加しました。', '操作の入口とショートカットを揃えてください。'],
      ['新しい料金表をレビューする', 'review/pricing', 2 * 86_400_000, '文言と小さい画面での表示を確認しました。', '料金表を読みやすさの観点でレビューしてください。'],
      ['リリースノートをまとめる', 'docs/release', 4 * 86_400_000, '変更点と利用者への案内をまとめました。', '今回のリリースノートを日本語で作成してください。'],
      ['画像の読み込みを軽くする', 'perf/images', 12 * 86_400_000, '画像のサイズと読み込み順を見直しました。', 'ページの画像を最適化してください。'],
    ];
    for (const [i, [title, branch, age, reply, prompt]] of samples.entries()) {
      const id = `store-demo-${i}`;
      const rollout = path.join(fx.codexHome, 'sessions', `${id}.jsonl`);
      const messages = line({ timestamp: iso(age + 60_000), type: 'session_meta', payload: { id } })
        + line({ timestamp: iso(age + 50_000), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: prompt }] } } })
        + line({ timestamp: iso(age + 40_000), type: 'event_msg', payload: { type: 'turn_started', turn_id: `turn-${i}` } })
        + line({ timestamp: iso(age), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', phase: i < 2 ? 'commentary' : 'final', content: [{ type: 'Text', text: reply }] } } })
        + (i === 0 ? line({ timestamp: iso(age), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: '入力欄の説明は短く、エラーは原因と次の操作がわかる文言にしてください。' }] } } })
          + line({ timestamp: iso(age), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', phase: 'commentary', content: [{ type: 'Text', text: '変更点を整理しました。\n\n- 入力欄に短い説明を添えます。\n- 入力を修正する場所にエラーを表示します。\n- キーボードだけでも送信できるようにします。\n\nライトとダークの両方で、文字の読みやすさとフォーカス表示を確認します。' }] } } }) : '')
        + (i < 2 ? '' : line({ timestamp: iso(age), type: 'event_msg', payload: { type: 'turn_complete' } }));
      fs.writeFileSync(rollout, messages);
      insert.run(id, rollout, Math.floor((now - age - 60_000) / 1000), Math.floor((now - age) / 1000), now - age, 'cli', 'user', '/demo/website', title, title, 0, branch, 'gpt-6-sol', prompt, '', null, 0, null);
    }
    db.close();
    fs.rmSync(path.join(fx.claudeHome, 'projects'), { recursive: true });
    fs.rmSync(fx.desktopDir, { recursive: true });
    fs.mkdirSync(fx.desktopDir, { recursive: true });
    const project = path.join(fx.claudeHome, 'projects', '-demo-website');
    fs.mkdirSync(project, { recursive: true });
    for (const [i, title] of ['スマートフォンの表示を整える', 'カード一覧の余白を見直す', 'お問い合わせフォームを確認する'].entries()) {
      const age = (i + 1) * 3_600_000;
      fs.writeFileSync(path.join(project, `store-claude-${i}.jsonl`), line({ type: 'user', cwd: '/demo/website', gitBranch: 'main', timestamp: iso(age + 60_000), message: { role: 'user', content: title + '。変更点を説明してください。' } }) + line({ type: 'assistant', timestamp: iso(age), message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 1200, output_tokens: 300 }, content: [{ type: 'text', text: '読みやすさと操作しやすさを確認し、調整しました。' }] } }) + line({ type: 'custom-title', customTitle: title, sessionId: `store-claude-${i}` }));
    }
    data = fs.mkdtempSync(path.join(local, 'data-'));
    host = spawn(process.execPath, ['tests/dev-host.mjs', String(port)], { cwd: root, detached: true, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, CANBAN_DATA_DIR: data, CANBAN_CODEX_HOME: fx.codexHome, CANBAN_CLAUDE_HOME: fx.claudeHome, CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir, CANBAN_LAUNCH_DRYRUN: '1', CANBAN_SEARCH_INDEX: '0', CANBAN_BACKGROUND: '0' } });
    for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://127.0.0.1:${port}`)).ok) break; } catch {} await sleep(100); }
    const tool = async (name, args = {}) => {
      const r = await (await fetch(`http://127.0.0.1:${port}/rpc`, { method: 'POST', body: JSON.stringify({ name, arguments: args }) })).json();
      if (r.error || r.result?.isError) throw new Error(JSON.stringify(r));
      return r.result?.structuredContent;
    };
    let board = await tool('canban_get_board');
    const titles = ['これから', '作業中', 'レビュー', '完了'];
    for (const [i, list] of board.lists.entries()) await tool('canban_update_list', { listId: list.id, title: titles[i] || list.title });
    for (let i = board.lists.length; i < titles.length; i++) await tool('canban_create_list', { title: titles[i] });
    board = await tool('canban_get_board');
    const listIds = Object.fromEntries(board.lists.map((x) => [x.title, x.id]));
    for (const card of board.lists.flatMap((list) => list.cards)) {
      const targetList = /ログイン|検索結果|スマートフォン/.test(card.title) ? '作業中' : /料金表|余白|通知/.test(card.title) ? 'レビュー' : '完了';
      await tool('canban_move_card', { cardId: card.id, toList: listIds[targetList], position: 'bottom' });
    }
    for (const [title, description, list] of [
      ['次のリリースの確認項目', '公開前の確認をひとつのカードにまとめます。\n\n- ボードと時間軸の表示\n- キーボード操作\n- ライトとダークの読みやすさ\n\n関連するセッションをここに紐付けて進めます。', 'これから'],
      ['ヘルプの説明を更新する', '新しい操作に合わせて、利用者向けの説明を見直します。', 'これから'],
      ['はじめての利用をわかりやすく', 'ボードで仕事を見つけ、カードから続きを進める流れを整えます。', 'これから'],
      ['フォームの改善案を比較する', '入力しやすさを確認し、次の実装を決めます。', 'レビュー'],
    ]) await tool('canban_create_task', { title, description, list: listIds[list] });
    await size(1280, 800);
    await cdp('Emulation.setDefaultBackgroundColorOverride');
    const openTheme = async (theme) => {
      await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/direct?theme=${theme}` });
      for (let i = 0; i < 100; i++) { if (await evaluate("!!document.querySelector('.card.face')")) break; await sleep(100); }
      await sleep(1200);
    };
    await openTheme('light');
    const key = async (key) => { await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true}))`); await sleep(500); };
    await evaluate("document.querySelector('#sideBtn').click()"); await sleep(500);
    await capture(path.join(out, 'screenshot-board-light.png'));
    await openTheme('dark');
    await capture(path.join(out, 'screenshot-board-dark.png'));
    await openTheme('light');
    await evaluate("document.querySelector('#sideBtn').click()"); await sleep(500); await key('i');
    await capture(path.join(out, 'screenshot-timeline.png'));
    await key('i');
    await evaluate("[...document.querySelectorAll('.card.face.task')].find(x=>x.textContent.includes('次のリリース')).click()"); await sleep(900); await key('d');
    await capture(path.join(out, 'screenshot-task-detail.png'));
    await key('Escape'); await key('Escape');
    await evaluate("[...document.querySelectorAll('.card.face:not(.task)')].find(x=>x.textContent.includes('ログイン')).click()"); await sleep(2000); await key('d');
    await capture(path.join(out, 'screenshot-conversation.png'));
    if (errors.length) throw new Error(errors.join('\n'));
  }
} finally {
  ws?.close();
  if (host?.pid) try { process.kill(-host.pid, 'SIGTERM'); } catch {}
  chrome?.kill();
  await sleep(350);
  fx?.cleanup();
  if (data) fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(profile, { recursive: true, force: true });
}

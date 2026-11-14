import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../ui/card-overlay-model.js', import.meta.url), 'utf8');
const action = vm.runInNewContext(`${source}\ncontinueAction`);
const card = { id: 'claude:a', agent: 'claude', status: 'completed' };
const launch = { desktop: { exact: true, url: 'claude://session/a' }, terminal: { command: 'claude --resume a' } };
const available = { open: { status: 'available' } };

test('desktop label identifies the app and waiting answer route without claiming execution', () => {
  assert.equal(action(card, launch, available).label, 'Claude で開く');
  assert.equal(action({ ...card, status: 'waiting' }, launch, available).label, 'Claude で答える');
  assert.equal(action({ ...card, status: 'waiting', statusKnown: false }, launch, available).label, 'Claude で開く');
  assert.equal(action({ agent: 'antigravity' }, launch, available).label, 'Antigravity で開く');
});
test('route capabilities override aggregate availability', () => {
  const caps = { open: { status: 'available', routes: { desktop: { status: 'unknown', reason: '所有者を確認中' }, terminal: { status: 'available' } } } };
  assert.equal(action(card, launch, caps).disabled, true);
  assert.match(action(card, launch, caps).reason, /所有者を確認中/);
  assert.equal(action(card, launch, caps, { route: 'terminal' }).disabled, false);
  assert.equal(action(card, launch, caps, { route: 'terminal' }).label, 'ターミナルで再開');
});
test('missing route and blocked route are visible and do not fall back silently', () => {
  for (const status of ['blocked', 'unknown', 'unsupported']) {
    const value = action(card, launch, { open: { status, reason: '接続を確認してください' } });
    assert.equal(value.disabled, true);
    assert.match(value.reason, /接続を確認してください/);
  }
  assert.equal(action(card, {}, available, { route: 'terminal' }).disabled, true);
  assert.equal(action(card, launch, available, { route: 'terminal', terminalAvailable: false }).disabled, true);
});
test('inexact desktop link explains opening a folder and cloud link does not claim continuation', () => {
  const folder = action(card, { ...launch, desktop: { exact: false } }, available);
  assert.equal(folder.label, '同じフォルダーで新しく開く');
  assert.match(folder.reason, /直接開けません/);
  const cloud = action({ agent: 'codex', sourceKind: 'codex-cloud' }, { desktop: { exact: false } }, available);
  assert.equal(cloud.label, 'Codex を開く');
  assert.match(cloud.reason, /元アプリ/);
  assert.equal(action({ agent: 'codex', sourceKind: 'codex-cloud' }, { desktop: { exact: false, url: 'codex://' } }, { open: { status: 'unsupported' } }).disabled, false);
});
test('managed Desktop live guard can resolve unknown but never override an explicit block', () => {
  const unknown = { open: { status: 'available', routes: { desktop: { status: 'unknown', reason: '古い状態' } } } };
  assert.equal(action(card, launch, unknown, { desktopState: { status: 'available' } }).disabled, false);
  const blocked = { open: { status: 'blocked', routes: { desktop: { status: 'blocked', reason: 'アカウント不一致' } } } };
  assert.equal(action(card, launch, blocked, { desktopState: { status: 'available' } }).disabled, true);
});


test('keyboard continuation is blocked by the open pane route guard before any native action', async () => {
  const resumeSource = fs.readFileSync(new URL('../ui/resume.js', import.meta.url), 'utf8');
  let opened = 0, message = '';
  const resume = vm.runInNewContext(`${resumeSource}\nresume`, {
    panes: [{ id: 'claude:a', continueState: () => ({ disabled: true, reason: '所有アカウントを確認中' }) }],
    toast: text => { message = text; },
    bridge: { callTool: () => { opened++; } },
    desktopAccounts: { startResume: () => { opened++; } },
  });
  await resume('claude:a', { route: 'desktop' });
  assert.equal(opened, 0);
  assert.equal(message, '所有アカウントを確認中');
});

test('o explains an unavailable default route and opens explicit choices without native launch', () => {
  const resumeSource = fs.readFileSync(new URL('../ui/resume.js', import.meta.url), 'utf8');
  const overlay = fs.readFileSync(new URL('../ui/card-overlay.js', import.meta.url), 'utf8');
  const start = overlay.indexOf("document.addEventListener('keydown', e => {");
  const keys = overlay.slice(start, overlay.indexOf('// ---- a small ?', start));
  let handler, opened = 0, choices = 0, message = '', prevented = false;
  const pane = { id: 'claude:a', kind: 'session',
    continueState: () => ({ disabled: true, reason: '開けるか確認できていません: 所有アカウントを確認中', route: 'desktop' }),
    el: { querySelector: selector => selector === '.continue-options' ? { click: () => { choices++; } } : null } };
  const context = vm.createContext({ panes: [pane], paneLayer: { hidden: false }, exchangeTrail: null,
    focusedPane: () => pane, paneDocked: () => true, inDockedPane: () => true, typingIn: () => false,
    document: { addEventListener: (name, fn) => { handler = fn; }, querySelector: () => null },
    paneKeyButton: () => ({ disabled: true, click() {} }),
    toast: text => { message = text; },
    bridge: { callTool: () => { opened++; } }, desktopAccounts: { startResume: () => { opened++; } },
  });
  vm.runInContext(`${resumeSource}\n${keys}`, context);
  handler({ key: 'o', target: pane.el, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.match(message, /所有アカウントを確認中/);
  assert.equal(choices, 1, 'unavailable default offers explicit route choices');
  assert.equal(opened, 0, 'unknown Desktop must not silently launch Terminal');
});

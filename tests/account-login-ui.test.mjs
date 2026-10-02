import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function menu(profiles = []) {
  const source = fs.readFileSync(new URL('../ui/accounts.js', import.meta.url), 'utf8');
  const nodes = [], calls = [];
  const h = (tag, attrs = {}, ...children) => {
    const node = { tag, value: tag === 'select' ? children[0]?.value : '', ...attrs, children: children.flat(Infinity), dataset: {}, isConnected: true,
      append(...items) { this.children.push(...items); }, addEventListener() {},
      querySelectorAll() { return []; } };
    nodes.push(node); return node;
  };
  const state = { filters: {}, board: { accounts: { accounts: [], profiles, homes: [], colors: [], unknown: { codex: 0, claude: 0 }, refresh: { enabled: false, intervalMinutes: 5 } } } };
  const context = vm.createContext({ state, h, workspace: { hasDrafts: () => false },
    popover() {}, updateAccountMenuUsage() {}, refreshAccountUsage() {}, accountScheduleText: () => '',
    setTimeout() {}, clearTimeout() {}, toast() {},
    act: async (name, args) => { calls.push({ name, args }); return { result: {} }; },
    bridge: { callTool: async () => ({ result: {} }) },
    navigator: { clipboard: { writeText: async () => {} } }, load: async () => {} });
  vm.runInContext(source.slice(source.indexOf('function accountsMenu('), source.indexOf("$('#accountsBtn').addEventListener")), context);
  context.accountLoginDialog = (anchor, args) => calls.push({ name: 'browser-dialog', args });
  context.accountsMenu({});
  return { nodes, calls, context };
}

test('account addition exposes terminal login and authentication in any browser', async () => {
  const { nodes, calls } = menu();
  const terminal = nodes.find(n => n.tag === 'button' && n.text === 'ターミナルでログイン');
  const browser = nodes.find(n => n.tag === 'button' && n.text === '任意のブラウザで認証');
  assert.ok(terminal, 'terminal login must remain an explicit account-add action');
  assert.ok(browser, 'users must be able to choose a browser instead of the default browser');
  await terminal.onclick();
  assert.equal(calls[0].args.method, 'terminal');
  assert.equal(calls[0].args.agent, 'codex');
  await browser.onclick();
  assert.equal(calls[1].name, 'browser-dialog');
  assert.equal(calls[1].args.agent, 'codex');
});

test('a persisted pending login retains both methods and a copyable terminal command', async () => {
  const p = { id: 'pending', agent: 'claude', pending: true, expectedKey: 'claude:test' };
  const { nodes, calls } = menu([p]);
  const terminal = nodes.filter(n => n.tag === 'button' && n.text === 'ターミナルでログイン').at(-1);
  const browser = nodes.filter(n => n.tag === 'button' && n.text === '任意のブラウザで認証').at(-1);
  assert.ok(nodes.find(n => n.text === 'ログインコマンドをコピー'));
  await terminal.onclick();
  assert.equal(calls[0].args.profileId, p.id);
  assert.equal(calls[0].args.key, p.expectedKey);
  await browser.onclick();
  assert.equal(calls[1].args.home.id, p.id);
  assert.equal(calls[1].args.key, p.expectedKey);
});

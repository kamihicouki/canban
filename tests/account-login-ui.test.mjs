import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function menu(profiles = [], accounts = []) {
  const source = fs.readFileSync(new URL('../ui/accounts.js', import.meta.url), 'utf8');
  const nodes = [], calls = [];
  const h = (tag, attrs = {}, ...children) => {
    const node = { tag, value: tag === 'select' ? children[0]?.value : '', ...attrs, children: children.flat(Infinity), dataset: {}, isConnected: true,
      append(...items) { this.children.push(...items); }, addEventListener() {},
      querySelectorAll() { return []; } };
    nodes.push(node); return node;
  };
  const state = { filters: {}, board: { accounts: { accounts, profiles, homes: [], colors: [], unknown: { codex: 0, claude: 0 }, refresh: { enabled: false, intervalMinutes: 5 } } } };
  const context = vm.createContext({ state, h, workspace: { hasDrafts: () => false },
    popover() {}, updateAccountMenuUsage() {}, refreshAccountUsage() {}, accountScheduleText: () => '',
    usageTitle: () => '', ringFor: () => h('span'), accountUsageContent: () => h('div'), accountUpdateText: () => '',
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

for (const agent of ['codex', 'claude']) test(`${agent} reauthentication routes both methods to the selected account`, async () => {
  const account = { agent, key: `${agent}:test`, label: 'テスト', signedIn: [], usage: { code: 'login_required' } };
  const { nodes, calls } = menu([], [account]);
  const row = nodes.find(n => n.class === 'acct-row');
  const button = {};
  row._loginAction({ currentTarget: button });
  assert.equal(calls[0].name, 'browser-dialog');
  assert.equal(calls[0].args.agent, agent);
  assert.equal(calls[0].args.key, account.key);
  await row._terminalLoginAction();
  assert.equal(calls[1].args.method, 'terminal');
  assert.equal(calls[1].args.agent, agent);
  assert.equal(calls[1].args.key, account.key);
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

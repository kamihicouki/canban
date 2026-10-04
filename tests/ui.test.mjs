// The board page is assembled from ui/board.html and the files it includes; hosts and
// the Chrome build expect exactly one inline <style> and one inline <script>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { boardHtml } from '../server/ui.mjs';

const ui = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');

test('assembled board: one style, one script, every include inlined, script compiles', () => {
  const html = boardHtml({ version: '9.9.9' });
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/gi)];
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  assert.equal(styles.length, 1);
  assert.equal(scripts.length, 1);
  assert.doesNotMatch(html, /@include|__CANBAN_VERSION__/);
  assert.match(html, /9\.9\.9/);
  new vm.Script(scripts[0][1]); // throws on a syntax error
  const src = fs.readFileSync(path.join(ui, 'board.html'), 'utf8');
  const included = [...src.matchAll(/@include ([\w-]+\.(?:css|js))/g)].map((m) => m[1]).sort();
  assert.deepEqual(included, ['accounts.css', 'accounts.js', 'header.css', 'header.js', 'icons.js', 'layouts.css', 'layouts.js', 'prompt-composer.css', 'prompt-composer.js', 'task-dashboard-model.js', 'task-dashboard.css', 'task-dashboard.js', 'task-quick-add-model.js', 'task-quick-add.css', 'task-quick-add.js', 'workspace-model.js', 'workspace.css', 'workspace.js']);
  for (const f of included) assert.ok(html.includes(fs.readFileSync(path.join(ui, f), 'utf8').trimEnd()), f);
});

test('only plain file names are included (no paths)', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'canban-ui-'));
  try {
    fs.writeFileSync(path.join(dir, 'board.html'), '<style>\n/* @include ../x.css */\n</style><script>\n// @include a.js\n</script>');
    fs.writeFileSync(path.join(dir, 'a.js'), 'const a = 1;\n');
    const html = boardHtml({ dir });
    assert.match(html, /@include \.\.\/x\.css/); // left alone
    assert.match(html, /const a = 1;/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rule replay prevents duplicate clicks, reports zero moves and restores buttons after an error', async () => {
  const html = boardHtml();
  const source = html.slice(html.indexOf('const runningRules ='), html.indexOf('function rulesMenu('));
  const button = { dataset: { runRule: 'r1' }, setAttribute(key, value) { this[key] = value; } };
  let calls = 0, finish;
  const messages = [];
  const context = vm.createContext({ document: { querySelectorAll: () => [button] },
    act: async (name, args) => {
      assert.equal(name, 'canban_run_rule');
      assert.equal(args.ruleId, 'r1');
      calls++;
      return new Promise((resolve, reject) => { finish = { resolve, reject }; });
    }, toast: (message) => messages.push(message) });
  vm.runInContext(source, context);
  const pending = vm.runInContext("runRuleNow('r1')", context);
  assert.equal(button.disabled, true);
  assert.equal(button['aria-busy'], 'true');
  await vm.runInContext("runRuleNow('r1')", context);
  assert.equal(calls, 1);
  finish.resolve({ result: { moved: 0, errors: [] } });
  await pending;
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, '今すぐ実行');
  assert.equal(messages[0], '0 件のカードを移動しました');
  const failed = vm.runInContext("runRuleNow('r1')", context);
  finish.reject(new Error('fixture failure'));
  await failed;
  assert.equal(button.disabled, false);
  assert.equal(button['aria-busy'], 'false');
  assert.equal(messages.length, 1); // failure must not announce success
  const partial = vm.runInContext("runRuleNow('r1')", context);
  finish.resolve({ result: { moved: 1, errors: ['host unavailable'] } });
  await partial;
  assert.match(messages[1], /1 件.*一部のセッション/);
});

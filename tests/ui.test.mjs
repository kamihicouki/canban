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
  assert.deepEqual(included, ['accounts.css', 'accounts.js', 'header.css', 'header.js', 'task-dashboard-model.js', 'task-dashboard.css', 'task-dashboard.js', 'task-quick-add-model.js', 'task-quick-add.css', 'task-quick-add.js', 'workspace-icons.js', 'workspace-model.js', 'workspace.css', 'workspace.js']);
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

// The board UI is one HTML page with one inline <style> and one inline <script>
// (MCP Apps hosts load it as a single resource; the Chrome build splits those two
// blocks out again). Larger features live in their own files under ui/ and are
// inlined here at their marker, so they share the page's scope:
//   /* @include name.css */   inside the <style>
//   // @include name.js       inside the <script>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const MARKER = /^[ \t]*(?:\/\* @include ([\w-]+\.css) \*\/|\/\/ @include ([\w-]+\.js))[ \t]*$/gm;

export function boardHtml({ version = '0.0.0', dir = UI_DIR } = {}) {
  const html = fs.readFileSync(path.join(dir, 'board.html'), 'utf8');
  return html.replace(MARKER, (_m, css, js) => fs.readFileSync(path.join(dir, css || js), 'utf8').trimEnd()).replaceAll('__CANBAN_VERSION__', version);
}

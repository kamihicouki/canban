// Assemble one self-contained resource for MCP Apps and the Chrome build.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const MARKER = /^[ \t]*(?:\/\* @include ([\w-]+\.css) \*\/|\/\/ @include ([\w-]+\.js))[ \t]*$/gm;
export function boardHtml({ version = '0.0.0', dir = UI_DIR, uiToken = '' } = {}) {
  return fs.readFileSync(path.join(dir, 'board.html'), 'utf8')
    .replace(MARKER, (_, css, js) => fs.readFileSync(path.join(dir, css || js), 'utf8'))
    .replaceAll('__CANBAN_VERSION__', version)
    .replaceAll('__CANBAN_UI_TOKEN__', uiToken);
}

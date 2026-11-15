// Assemble one self-contained resource for MCP Apps and the Chrome build.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const MARKER = /^[ \t]*(?:\/\* @include ([\w-]+\.css) \*\/|\/\/ @include ([\w-]+\.js))[ \t]*$/gm;
// Keep MCP Apps and Chrome offline and identical; read/encode the immutable font once.
const readingFont = fs.readFileSync(path.join(UI_DIR, '..', 'assets', 'fonts', 'noto-sans-jp.woff2')).toString('base64');
const readingFace = `@font-face { font-family: "Canban Noto Sans JP"; font-style: normal; font-weight: 100 900; font-display: swap; src: url(data:font/woff2;base64,${readingFont}) format("woff2"); }`;
export function boardHtml({ version = '0.0.0', dir = UI_DIR, uiToken = '', embedFonts = true } = {}) {
  return fs.readFileSync(path.join(dir, 'board.html'), 'utf8')
    .replace(MARKER, (_, css, js) => fs.readFileSync(path.join(dir, css || js), 'utf8'))
    .replace('<style>', `<style>\n${embedFonts ? readingFace : readingFace.replace(/data:font\/woff2;base64,[A-Za-z0-9+/=]+/, 'noto-sans-jp.woff2')}`)
    .replaceAll('__CANBAN_VERSION__', version)
    .replaceAll('__CANBAN_UI_TOKEN__', uiToken);
}

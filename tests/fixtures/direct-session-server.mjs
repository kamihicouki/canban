// Only this disposable RPC test server sees a synthetic Codex application build.
// Production still reads the installed app and requires its matching receipt.
import fs from 'node:fs/promises';
const stat = fs.stat;
fs.stat = async function (filename, options) {
  if (filename === '/Applications/ChatGPT.app/Contents/Resources/app.asar') {
    return { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n };
  }
  return stat.call(this, filename, options);
};
await import('../../server/index.mjs');

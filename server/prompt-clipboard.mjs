import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { promptImages } from './prompt-input.mjs';
import { appEnv } from './launcher.mjs';
const helper = fileURLToPath(new URL('../scripts/prompt-clipboard.jxa', import.meta.url));
const execute = promisify(execFile);
const nativeRun = async (file, args) => (await execute(file, args, { env: appEnv(), timeout: 15000, maxBuffer: 4096 })).stdout;
export async function copyPromptImages(input, { platform = process.platform, run = nativeRun, uiAuthorized = false } = {}) {
  if (!uiAuthorized) throw new Error('この操作はボードUIから確認してください');
  if (Object.keys(input).some(k => !['dataDir','imageIds'].includes(k)) || !input.imageIds?.length) throw new Error('コピーする画像IDを指定してください');
  if (platform !== 'darwin') return { state:'unsupported', count:0, reason:'このOSではファイルのコピーに対応していません。アプリの添付操作を使ってください' };
  const images = promptImages(input.dataDir, input.imageIds);
  let response;
  try { response = JSON.parse(await run('osascript', ['-l', 'JavaScript', helper, ...images.map(i => i.path)])); }
  catch { throw new Error('画像をクリップボードへコピーできませんでした'); }
  if (response.copied !== true || response.count !== images.length) throw new Error('画像のコピー結果を確認できません');
  return { state:'copied', count:images.length, nextAction:'paste-in-desktop' };
}

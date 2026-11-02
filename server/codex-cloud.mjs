// "実行場所: クラウド" of the Codex app. The app's new-thread link cannot choose Cloud,
// so the task goes through the official CLI (`codex cloud exec`), which submits it
// to the same Codex Cloud environment the app lists. Nothing is prefilled: it starts.
import { execFile } from 'node:child_process';
import { shq } from './agents.mjs';
import { cleanEnv, resolveBin } from './dispatch.mjs';

const ENV_ID = /^[A-Za-z0-9_.~-]{1,200}$/;

// prefix: startAccount()'s CLI prefix (CODEX_HOME of the chosen account) or ''.
export function codexCloudCommand({ environment, prompt, prefix = '' }) {
  if (!ENV_ID.test(String(environment || ''))) throw new Error('Codex Cloud の環境を選んでください');
  if (!String(prompt || '').trim()) throw new Error('クラウドで開始するには依頼内容が必要です');
  return `${prefix}${shq(resolveBin('codex') || 'codex')} cloud exec --env ${shq(environment)} -- ${shq(prompt)}`;
}

let runner = (command, { cwd }) => new Promise((resolve, reject) => {
  execFile('/bin/sh', ['-c', command], { cwd: cwd || undefined, env: cleanEnv(), timeout: 120000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(String(stderr || stdout || error.message).trim().slice(0, 500) || 'Codex Cloud に送信できませんでした'));
    else resolve(String(stdout));
  });
});
export function setCloudRunner(fn) { const previous = runner; runner = fn; return previous; }

// cwd: a local checkout of the environment's repository; its current branch is used.
export async function startCodexCloud({ environment, prompt, prefix = '', cwd = null }) {
  const command = codexCloudCommand({ environment, prompt, prefix });
  const out = await runner(command, { cwd });
  const url = out.match(/https:\/\/chatgpt\.com\/codex\/tasks\/[A-Za-z0-9_-]+/)?.[0] || null;
  return { route: 'cloud', command, url };
}

// Only browser metadata is read; cookies and browser credentials are never read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

export function loginBrowsers({ platform = process.platform, home = os.homedir(), apps = '/Applications', systemApps = '/System/Applications' } = {}) {
  if (platform !== 'darwin') return [];
  const out = [];
  const chrome = path.join(apps, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome');
  if (fs.existsSync(chrome)) {
    const root = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    let info = {};
    try { info = JSON.parse(fs.readFileSync(path.join(root, 'Local State'), 'utf8')).profile?.info_cache || {}; } catch {}
    const profiles = Object.entries(info)
      .filter(([id]) => /^(Default|Profile \d+)$/.test(id) && fs.existsSync(path.join(root, id)))
      .map(([id, v]) => ({ id, label: String(v.name || id).slice(0, 100) }))
      .sort((a, b) => a.id.localeCompare(b.id));
    out.push({ id: 'chrome', label: 'Google Chrome', profiles, executable: chrome });
  }
  const safari = [path.join(apps, 'Safari.app'), path.join(systemApps, 'Safari.app')].find((p) => fs.existsSync(p));
  if (safari) out.push({ id: 'safari', label: 'Safari', profiles: [], executable: safari });
  return out;
}

export function loginTarget(input, browsers) {
  const mode = input?.mode || 'manual';
  if (!['auto', 'manual'].includes(mode)) throw new Error('認証URLの開き方が不正です');
  if (mode === 'manual') return { mode, ...(['chrome', 'safari'].includes(input?.browserId) ? { browserId: input.browserId,
    ...(input.browserId === 'chrome' && /^(Default|Profile \d+)$/.test(input.profileId) ? { profileId: input.profileId } : {}) } : {}) };
  const browser = browsers.find((b) => b.id === input.browserId);
  if (!browser) throw new Error('選んだブラウザが見つかりません。選び直してください');
  if (browser.id === 'chrome') {
    if (!browser.profiles.some((p) => p.id === input.profileId)) throw new Error('Chromeのプロファイルを選んでください。保存したプロファイルがない場合は選び直してください');
    return { mode, browserId: browser.id, profileId: input.profileId };
  }
  if (input.profileId) throw new Error('このブラウザのプロファイルはURLをコピーして選択してください');
  return { mode, browserId: browser.id };
}

function launchFile(file, args, options, callback) {
  if (file === '/usr/bin/open') return execFile(file, args, options, callback);
  // On its first launch Chrome can stay running. Never time out and kill the
  // user's browser merely because the launcher process remains alive.
  const child = spawn(file, args, { detached: true, stdio: 'ignore' });
  let timer, done = false;
  const finish = (error) => { if (done) return; done = true; clearTimeout(timer); child.unref(); callback(error); };
  child.once('error', finish);
  child.once('exit', (code) => finish(code === 0 ? null : new Error('browser exited')));
  child.once('spawn', () => { timer = setTimeout(() => finish(null), 500); });
  return child;
}
export async function openLoginBrowser(target, url, browsers, run = launchFile) {
  const selected = loginTarget(target, browsers);
  const b = browsers.find((x) => x.id === selected.browserId);
  if (!b) throw new Error('ブラウザを選んでください');
  const [file, args] = b.id === 'chrome'
    ? [b.executable, [`--profile-directory=${selected.profileId}`, url]]
    : ['/usr/bin/open', ['-a', b.executable, url]];
  await new Promise((resolve, reject) => run(file, args, { timeout: 10000, maxBuffer: 1024 }, (error) => {
    if (!error) return resolve();
    const reason = error.code === 'ENOENT' ? '（アプリが見つかりません）' : error.code === 'EACCES' ? '（実行権限がありません）' : '';
    reject(Object.assign(new Error('browser launch failed'), { browserReason: `${b.label}を開けませんでした${reason}。認証URLをコピーして開いてください` }));
  }));
}

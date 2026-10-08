// Opens sessions: desktop deep links via the OS URL handler, or a resume command in a
// terminal via AppleScript. Nothing goes through a shell; the command is passed to
// osascript as an argv item, so no AppleScript string escaping is involved.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { loginBrowsers, openLoginBrowser } from './login-browsers.mjs';

const ALLOWED_SCHEMES = new Set(['codex:', 'claude:']);

let runner = (file, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: 15000 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout.trim()),
    );
    if (input != null) child.stdin.end(input);
  });

// Tests replace the process runner to record calls instead of launching apps.
export function setRunner(fn) {
  const prev = runner;
  runner = fn;
  return prev;
}

export async function openUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('不正な URL です');
  }
  if (!ALLOWED_SCHEMES.has(u.protocol)) throw new Error(`許可されていないスキームです: ${u.protocol}`);
  if (process.platform === 'darwin') return runner('open', [u.toString()]);
  if (process.platform === 'linux') return runner('xdg-open', [u.toString()]);
  throw new Error('この OS ではデスクトップアプリを開けません');
}

const APP_PATHS = {
  ghostty: ['/Applications/Ghostty.app'],
  terminal: ['/System/Applications/Utilities/Terminal.app', '/Applications/Utilities/Terminal.app'],
  iterm: ['/Applications/iTerm.app'],
};
export const TERMINAL_LABELS = { ghostty: 'Ghostty', terminal: 'Terminal.app', iterm: 'iTerm2' };
// Which targets each terminal can do natively (others fall back to a new window).
export const TERMINAL_CAPS = {
  ghostty: ['new-window', 'new-tab', 'split', 'current'],
  terminal: ['new-window', 'new-tab', 'current'],
  iterm: ['new-window', 'new-tab', 'split', 'current'],
};

export function installedTerminals() {
  if (process.platform !== 'darwin') return [];
  const home = os.homedir();
  return Object.entries(APP_PATHS)
    .filter(([, paths]) => paths.some((p) => fs.existsSync(p) || fs.existsSync(path.join(home, p))))
    .map(([id]) => ({ id, label: TERMINAL_LABELS[id], targets: TERMINAL_CAPS[id] }));
}

const SCRIPTS = {
  ghostty: `on run argv
  set cmd to item 1 of argv
  set mode to item 2 of argv
  tell application "Ghostty"
    activate
    set hasWin to (count of windows) > 0
    if mode is "current" and hasWin then
      set t to focused terminal of selected tab of front window
      input text cmd to t
      send key "enter" to t
    else
      set cfg to new surface configuration
      set initial input of cfg to cmd & linefeed
      if mode is "new-tab" and hasWin then
        new tab in front window with configuration cfg
      else if mode is "split" and hasWin then
        split (focused terminal of selected tab of front window) direction right with configuration cfg
      else
        new window with configuration cfg
      end if
    end if
  end tell
end run`,
  terminal: `on run argv
  set cmd to item 1 of argv
  set mode to item 2 of argv
  tell application "Terminal"
    activate
    set hasWin to (count of windows) > 0
    if mode is "current" and hasWin then
      do script cmd in selected tab of front window
    else if mode is "new-tab" and hasWin then
      tell application "System Events" to keystroke "t" using command down
      delay 0.4
      do script cmd in selected tab of front window
    else
      do script cmd
    end if
  end tell
end run`,
  iterm: `on run argv
  set cmd to item 1 of argv
  set mode to item 2 of argv
  tell application "iTerm"
    activate
    set hasWin to (count of windows) > 0
    if mode is "current" and hasWin then
      tell current session of current window to write text cmd
    else if mode is "new-tab" and hasWin then
      tell current window to create tab with default profile
      tell current session of current window to write text cmd
    else if mode is "split" and hasWin then
      tell current session of current window
        set s to (split vertically with default profile)
      end tell
      tell s to write text cmd
    else
      create window with default profile
      tell current session of current window to write text cmd
    end if
  end tell
end run`,
};

export async function runInTerminal({ terminal, target, command }) {
  if (process.platform !== 'darwin') throw new Error('ターミナル起動は現在 macOS のみ対応しています');
  if (!SCRIPTS[terminal]) throw new Error(`未対応のターミナルです: ${terminal}`);
  if (!command) throw new Error('再開コマンドがありません');
  const mode = TERMINAL_CAPS[terminal].includes(target) ? target : 'new-window';
  await runner('osascript', ['-', command, mode], SCRIPTS[terminal]);
  return { terminal, target: mode, fellBack: mode !== target };
}

// Opens an http(s) link in the browser chosen in settings; '' follows the OS default.
export async function openExternal(url, { linkBrowser = '', linkProfile = '' } = {}, browsers = loginBrowsers) {
  let u;
  try { u = new URL(url); } catch { throw new Error('不正な URL です'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`許可されていないスキームです: ${u.protocol}`);
  const catalog = linkBrowser ? browsers() : [];
  const b = catalog.find((x) => x.id === linkBrowser);
  if (!b) {
    if (process.platform === 'darwin') return runner('open', [u.toString()]);
    if (process.platform === 'linux') return runner('xdg-open', [u.toString()]);
    throw new Error('この OS ではブラウザを開けません');
  }
  const profileId = b.id === 'chrome' ? (b.profiles.some((p) => p.id === linkProfile) ? linkProfile : b.profiles[0]?.id) : undefined;
  try { await openLoginBrowser({ mode: 'auto', browserId: b.id, profileId }, u.toString(), catalog); }
  catch (e) { throw new Error(e.browserReason || e.message); }
}

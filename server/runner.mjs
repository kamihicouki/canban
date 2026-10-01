// Account runner: config folders that Canban creates so several accounts of the same
// agent run side by side (each session with its own CLAUDE_CONFIG_DIR / CODEX_HOME).
//
// This is the only part of Canban that writes for the agents, and only here:
//   <data>/accounts/<agent>-<name>/   the folders (marked by .canban-home.json)
//   <data>/accounts/.trash/           removed folders (never deleted)
//   <data>/usage/                     Claude usage written by the statusline tap
// It never touches ~/.claude, ~/.codex, the desktop apps' data, or the files of other
// account switchers; it never reads a token. Logging in runs the agent's own CLI in a
// terminal (`claude auth login` / `codex login`).
//
// Shared with the default folder (symlinks) when chosen:
//   Claude  projects/ (conversations: any account can continue any session),
//           CLAUDE.md, skills, agents, commands, hooks, output-styles
//   Codex   AGENTS.md, skills, prompts
// Copied: Claude settings.json (statusLine swapped for the tap, which still runs the
// original one), Codex config.toml.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKER = '.canban-home.json';
const AGENTS = ['claude', 'codex'];
const SHARED = {
  claude: ['CLAUDE.md', 'skills', 'agents', 'commands', 'hooks', 'output-styles'],
  codex: ['AGENTS.md', 'skills', 'prompts'],
};
const TAP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'statusline-tap.mjs');

export function runnerRoot(dataDir) {
  return path.join(dataDir, 'accounts');
}
export function usageDir(dataDir) {
  return path.join(dataDir, 'usage');
}

export function slugName(name) {
  const s = String(name ?? '').normalize('NFKC').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  if (!s) throw new Error('名前には英数字を含めてください（フォルダ名に使います）');
  return s;
}

// The folder must be a direct child of the root, for real (no link leading elsewhere).
function inside(root, dir) {
  const r = fs.realpathSync(root);
  const d = fs.realpathSync(dir);
  return path.dirname(d) === r;
}

function readMarker(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
    return m && m.managedBy === 'canban' && AGENTS.includes(m.agent) ? m : null;
  } catch {
    return null;
  }
}

// Folders created by Canban: [{ id, agent, name, dir, createdAt, shareProjects }]
export function listRunnerHomes(dataDir) {
  const root = runnerRoot(dataDir);
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = path.join(root, e.name);
    const m = readMarker(dir);
    if (m) out.push({ id: e.name, agent: m.agent, name: m.name, dir, createdAt: m.createdAt, shareProjects: !!m.shareProjects });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function link(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.symlinkSync(src, dest);
  return true;
}

// The statusLine command Claude runs in this folder: the tap, which records usage and
// then runs the original command (kept in the marker) with the same input.
export function tapCommand(dataDir, homeId) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return `${q(process.execPath)} ${q(TAP)} ${q(usageDir(dataDir))} ${q(homeId)}`;
}

export function createHome({ dataDir, agent, name, sourceHome, shareProjects = true, shareConfig = true, now = Date.now() }) {
  if (!AGENTS.includes(agent)) throw new Error('Claude か Codex を選んでください');
  const slug = slugName(name);
  const root = runnerRoot(dataDir);
  fs.mkdirSync(root, { recursive: true });
  const id = `${agent}-${slug}`;
  const dir = path.join(root, id);
  if (fs.existsSync(dir)) throw new Error(`「${id}」はもうあります`);
  fs.mkdirSync(dir);
  if (!inside(root, dir)) throw new Error('フォルダの場所が不正です');
  const marker = { managedBy: 'canban', agent, name: String(name).trim().slice(0, 60), createdAt: now, source: sourceHome, shareProjects: agent === 'claude' && !!shareProjects, shared: [], statusLine: null };
  try {
    if (agent === 'claude') {
      if (marker.shareProjects) {
        fs.mkdirSync(path.join(sourceHome, 'projects'), { recursive: true });
        link(path.join(sourceHome, 'projects'), path.join(dir, 'projects'));
      }
      let settings = {};
      try {
        settings = JSON.parse(fs.readFileSync(path.join(sourceHome, 'settings.json'), 'utf8'));
      } catch {}
      if (!shareConfig) settings = {};
      marker.statusLine = settings.statusLine?.type === 'command' && typeof settings.statusLine.command === 'string' ? settings.statusLine.command : null;
      settings.statusLine = { type: 'command', command: tapCommand(dataDir, id) };
      fs.writeFileSync(path.join(dir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
    } else if (shareConfig) {
      try {
        fs.copyFileSync(path.join(sourceHome, 'config.toml'), path.join(dir, 'config.toml'));
      } catch {}
    }
    if (shareConfig) for (const f of SHARED[agent]) if (link(path.join(sourceHome, f), path.join(dir, f))) marker.shared.push(f);
    fs.writeFileSync(path.join(dir, MARKER), `${JSON.stringify(marker, null, 2)}\n`);
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true }); // only what was just made here
    throw e;
  }
  return { id, agent, name: marker.name, dir, shareProjects: marker.shareProjects, shared: marker.shared };
}

export function loginCommand(home) {
  const q = (s) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
  return home.agent === 'codex' ? `CODEX_HOME=${q(home.dir)} codex login` : `CLAUDE_CONFIG_DIR=${q(home.dir)} claude auth login`;
}

// Moves a Canban-made folder to .trash (the agent's login may stay in the keychain).
export function removeHome({ dataDir, id, now = Date.now() }) {
  const root = runnerRoot(dataDir);
  const dir = path.join(root, String(id));
  if (path.basename(dir) !== id || id.startsWith('.') || !fs.existsSync(dir) || !inside(root, dir) || !readMarker(dir)) throw new Error('Canban が作ったフォルダではありません');
  const trash = path.join(root, '.trash');
  fs.mkdirSync(trash, { recursive: true });
  const dest = path.join(trash, `${id}-${now}`);
  fs.renameSync(dir, dest);
  return { id, movedTo: dest };
}

// Claude usage the tap recorded: [{ homeId, at, fiveHour, sevenDay }] (newest per folder).
export function readTapUsage(dataDir) {
  const dir = usageDir(dataDir);
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const m = /^home-([a-z0-9-]+)\.json$/.exec(n);
    if (!m) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (typeof j.at === 'number') out.push({ homeId: m[1], at: j.at, fiveHour: j.five_hour || null, sevenDay: j.seven_day || null });
    } catch {}
  }
  return out;
}


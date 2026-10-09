// What the Codex desktop app keeps about threads outside the state DB (read-only):
// projects and which thread belongs to which, pinned threads, follow-ups queued in
// the app, and registered remote connections. Source: ~/.codex/.codex-global-state.json
// (over 1 MB on a long history), parsed only when its mtime / size changes.
import path from 'node:path';
import { exists, readJson, stat, queryReadOnly } from './readonly.mjs';
import { codexHome, findStateDb } from './codex.mjs';
import { perf } from '../perf.mjs';
import { parseDotCache } from './codex-dots.mjs';

const EMPTY = Object.freeze({ projects: new Map(), assignments: new Map(), followUps: new Map(), pinned: new Set(), remoteConnections: [], dots: new Map(), dotSessions: [] });
const cache = new Map(); // file -> { sig, value }
export const codexAppCounters = { parses: 0, hits: 0 };

export async function codexAppState({ home = codexHome() } = {}) {
  const file = path.join(home, '.codex-global-state.json');
  const st = exists(file) ? await stat(file) : null;
  if (!st) return EMPTY;
  const sig = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(file);
  if (hit && hit.sig === sig) {
    codexAppCounters.hits++;
    return hit.value;
  }
  const value = await perf.timed('codexApp.read', async () => {
    let raw;
    try {
      raw = await readJson(file);
    } catch {
      return hit?.value ?? EMPTY; // mid-write: keep the last good state
    }
    codexAppCounters.parses++;
    return parseAppState(raw, await dbProjects(home));
  });
  cache.set(file, { sig, value });
  return value;
}

// Projects from the state DB (newer app versions); used for ids the JSON lacks.
async function dbProjects(home) {
  const db = await findStateDb(home);
  if (!db) return [];
  try {
    return queryReadOnly(db, (d) => {
      const has = (t) => d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
      if (!has('projects')) return [];
      const roots = has('project_roots') ? d.prepare('SELECT project_id, path FROM project_roots ORDER BY position').all() : [];
      return d.prepare('SELECT id, name FROM projects').all().map((p) => ({ id: p.id, name: p.name, roots: roots.filter((r) => r.project_id === p.id).map((r) => r.path) }));
    });
  } catch {
    return [];
  }
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function parseAppState(raw, extraProjects = []) {
  const projects = new Map();
  const add = (id, name, roots, hostId = null) => {
    if (!str(id) || !str(name) || projects.has(id)) return;
    projects.set(id, { id, name: str(name).slice(0, 120), roots: (roots || []).filter((r) => typeof r === 'string'), hostId });
  };
  const local = raw?.['local-projects'];
  if (local && typeof local === 'object') for (const [id, p] of Object.entries(local)) add(p?.id || id, p?.name, p?.rootPaths);
  for (const p of Array.isArray(raw?.['remote-projects']) ? raw['remote-projects'] : []) add(p?.id, p?.label, p?.remotePath ? [p.remotePath] : [], str(p?.hostId));
  for (const p of extraProjects) add(p.id, p.name, p.roots);

  const assignments = new Map();
  const asg = raw?.['thread-project-assignments'];
  if (asg && typeof asg === 'object') for (const [thread, a] of Object.entries(asg)) if (str(a?.projectId) && projects.has(a.projectId)) assignments.set(thread, a.projectId);

  const followUps = new Map();
  const q = raw?.['queued-follow-ups'];
  if (q && typeof q === 'object') for (const [thread, items] of Object.entries(q)) if (Array.isArray(items) && items.length) followUps.set(thread, items.length);

  const pinned = new Set((Array.isArray(raw?.['pinned-thread-ids']) ? raw['pinned-thread-ids'] : []).filter((x) => typeof x === 'string'));
  const remoteConnections = Array.isArray(raw?.['codex-managed-remote-connections']) ? raw['codex-managed-remote-connections'] : [];
  const dotCache = parseDotCache(raw);
  return { projects, assignments, followUps, pinned, remoteConnections, dots: dotCache.dots, dotSessions: dotCache.sessions };
}

// Put the app's view on Codex sessions. `project` becomes the Codex project when the
// thread belongs to one; the folder name it used to be stays available as `folder`.
export function annotateCodexApp(sessions, app) {
  for (const s of sessions) {
    s.folder = s.folder ?? s.project ?? null;
    if (s.agent !== 'codex') continue;
    const dot = app.dots?.get(s.nativeId);
    s.dot = dot ? { ...dot, relation: s.threadSource === 'aeon_child' ? 'created' : dot.relation } : null;
    const p = app.projects.get(app.assignments.get(s.nativeId));
    s.codexProject = p ? { id: p.id, name: p.name } : null;
    s.project = p ? p.name : s.folder; // recomputed each time: remote sessions are cached objects
    s.pinnedInAgent = app.pinned.has(s.nativeId);
    s.codexFollowUps = app.followUps.get(s.nativeId) || 0;
  }
  return sessions;
}

// Codex projects with how many of the given sessions belong to them (for the UI).
export function codexProjectList(app, sessions) {
  const counts = new Map();
  for (const s of sessions) if (s.codexProject) counts.set(s.codexProject.id, (counts.get(s.codexProject.id) || 0) + 1);
  return [...app.projects.values()].map((p) => ({ ...p, count: counts.get(p.id) || 0 })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

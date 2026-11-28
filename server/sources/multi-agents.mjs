// Read-only session readers for Gemini CLI, Antigravity IDE, Cursor (IDE & CLI),
// ChatGPT Desktop, and Grok CLI/Bot.
// Every file / SQLite operation goes exclusively through ./readonly.mjs.
import os from 'node:os';
import path from 'node:path';
import {
  exists,
  stat,
  listDir,
  listSubdirs,
  readJson,
  readText,
  readJsonLines,
  readJsonLinesFrom,
  queryReadOnly,
} from './readonly.mjs';
import { projectName, clip, cleanPrompt, firstLine, LOCAL_HOST, sessionKey } from './util.mjs';
import { resolveRepoContext } from '../git.mjs';

const annotationTitleCache = new Map(); // annotationPath -> { mtimeMs, size, title }
const antigravityProjectFileCache = new Map(); // filePath -> { mtimeMs, size, proj }
const antigravityTranscriptCache = new Map(); // transcriptPath -> { ino, mtimeMs, size, offset, data }
const antigravityTaskCache = new Map(); // convPath -> { dirMtimeMs, taskSig, artifacts, planSteps, taskHeading }
const antigravityDbCache = new Map(); // csDbPath -> { sig, rows }
const genericSessionCache = new Map(); // filePath -> { ino, mtimeMs, size, offset, defaultCwd, defaultModel, state, parsed }
const geminiRootFileCache = new Map(); // rootFilePath -> { mtimeMs, size, cwd }
const cursorVscdbCache = new Map(); // dbPath -> { sig, wsSig, cwd, composers, prompts, generations }
const chatgptFileCache = new Map(); // filePath -> { ino, mtimeMs, size, projKey, items }

export function resetMultiAgentCaches() {
  annotationTitleCache.clear();
  antigravityProjectFileCache.clear();
  antigravityTranscriptCache.clear();
  antigravityTaskCache.clear();
  antigravityDbCache.clear();
  genericSessionCache.clear();
  geminiRootFileCache.clear();
  cursorVscdbCache.clear();
  chatgptFileCache.clear();
  cursorRawCache.clear();
  chatgptRawCache.clear();
}

async function sqliteSig(dbPath) {
  const [mainSt, walSt] = await Promise.all([stat(dbPath), stat(`${dbPath}-wal`)]);
  if (!mainSt) return null;
  return `${mainSt.ino}:${mainSt.mtimeMs}:${mainSt.size}|${walSt ? `${walSt.mtimeMs}:${walSt.size}` : '-'}`;
}

const MAX_SUMMARY_CACHE = 2500;
const MAX_RAW_CACHE = 4;
const RAW_CACHE_TTL_MS = 5000;
const HEAD_CHECK_BYTES = 512;
const cursorRawCache = new Map(); // dbPath -> { sig, at, compById, prompts, generations }
const chatgptRawCache = new Map(); // filePath -> { ino, mtimeMs, size, at, list }

function setBounded(map, key, value, max = MAX_SUMMARY_CACHE) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function getShortRaw(map, key, now = Date.now()) {
  for (const [k, v] of map) {
    if (now - v.at > RAW_CACHE_TTL_MS) map.delete(k);
  }
  const hit = map.get(key);
  return hit && now - hit.at <= RAW_CACHE_TTL_MS ? hit : null;
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

function isIsolatedTestEnv() {
  return Boolean(
    process.env.CANBAN_CODEX_HOME ||
    process.env.CANBAN_CLAUDE_HOME ||
    process.env.CANBAN_CLAUDE_DESKTOP_DIR
  );
}

function resolveSourceDir(explicitOpt, envVar, defaultPaths) {
  if (explicitOpt) return [explicitOpt];
  if (process.env[envVar]) return [process.env[envVar]];
  if (isIsolatedTestEnv()) return [];
  return defaultPaths.filter(Boolean);
}

function makeEntityObservation({ provider, scopeId, kind, nativeId, name, product, surface, cwd, roots, hostId = 'local', updatedAt }) {
  if (!nativeId || !name) return null;
  const ts = Math.round(updatedAt || Date.now());
  const normalizedRoots = Array.isArray(roots) && roots.length ? [...new Set(roots.filter(Boolean).map(String))] : (cwd ? [String(cwd)] : []);
  return {
    status: 'known',
    source: `${provider}-${kind}`,
    observedAt: ts,
    sourceUpdatedAt: ts,
    ref: {
      provider: String(provider),
      identityDomain: 'local',
      scopeId: String(scopeId || provider),
      kind: String(kind),
      nativeId: String(nativeId),
    },
    name: String(name),
    product: String(product || provider),
    surface: String(surface || 'cli'),
    roots: normalizedRoots,
    hostId: String(hostId || 'local'),
  };
}

function toMs(v, fallback = 0) {
  if (!v) return fallback;
  if (typeof v === 'number') return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : fallback;
}

function extractAntigravityUserText(raw) {
  if (!raw) return '';
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const reqMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(text);
  if (reqMatch && reqMatch[1].trim()) return reqMatch[1].trim();
  // Strip <user_information>, <USER_ADDED_ACTIVE_SELECTION>, <CONTEXT_SUMMARY> etc. for clean title/preview
  const stripped = text
    .replace(/<(?:CONTEXT_SUMMARY|user_information|USER_ADDED_ACTIVE_SELECTION|SYSTEM_MESSAGE|ADDITIONAL_METADATA)[^>]*>[\s\S]*?<\/(?:CONTEXT_SUMMARY|user_information|USER_ADDED_ACTIVE_SELECTION|SYSTEM_MESSAGE|ADDITIONAL_METADATA)>/gi, '')
    .trim();
  return cleanPrompt(stripped || text);
}

function extractAntigravityCwd(raw) {
  if (typeof raw !== 'string') return null;
  const cwdMatch = /Command Working Directory:\s*([^\r\n<]+)/i.exec(raw);
  if (cwdMatch && cwdMatch[1].trim().startsWith('/')) return cwdMatch[1].trim();
  const wsMatch = /Active Workspaces:\s*\r?\n\s*-\s*([^\r\n<]+)/i.exec(raw);
  if (wsMatch && wsMatch[1].trim().startsWith('/')) return wsMatch[1].trim();
  return null;
}

function parseMarkdownChecklist(mdText) {
  if (!mdText) return null;
  const steps = [];
  for (const line of String(mdText).split('\n')) {
    const m = /^\s*[-*]\s*\[([ xX/])\]\s+(.+)$/.exec(line);
    if (!m) continue;
    const mark = m[1].toLowerCase();
    const status = mark === 'x' ? 'completed' : mark === '/' ? 'in_progress' : 'pending';
    steps.push({ step: m[2].trim().replace(/`/g, ''), status });
  }
  return steps.length ? steps : null;
}

function fileUriToPath(uri) {
  if (!uri || typeof uri !== 'string') return null;
  if (uri.startsWith('/')) return uri;
  try {
    const parsed = new URL(uri);
    return decodeURIComponent(parsed.pathname);
  } catch {
    return decodeURIComponent(uri.replace(/^[a-z0-9+-.]+:\/\/[^/]+/i, ''));
  }
}

async function readAnnotationTitle(annotationPath) {
  const st = await stat(annotationPath);
  if (!st) {
    annotationTitleCache.delete(annotationPath);
    return null;
  }
  const hit = annotationTitleCache.get(annotationPath);
  if (hit && hit.ino === st.ino && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.title;
  try {
    const text = await readText(annotationPath, 4096);
    const m = /title:\s*"([^"]+)"/.exec(text);
    const title = m ? m[1].trim() : null;
    setBounded(annotationTitleCache, annotationPath, { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, title });
    return title;
  } catch {
    return null;
  }
}

const cleanFsPath = (p) => (typeof p === 'string' && p ? p.replace(/\/+$/, '') || '/' : null);

async function loadAntigravityProjects(configProjectsDir) {
  const projects = new Map();
  if (!configProjectsDir || !exists(configProjectsDir)) return projects;
  try {
    const files = await listDir(configProjectsDir);
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.json')) continue;
      const filePath = path.join(configProjectsDir, f.name);
      const st = await stat(filePath);
      if (!st) continue;
      const hit = antigravityProjectFileCache.get(filePath);
      if (hit && hit.ino === st.ino && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        if (hit.proj) projects.set(hit.proj.id, hit.proj);
        continue;
      }
      try {
        const data = await readJson(filePath);
        if (!data || !data.id) {
          setBounded(antigravityProjectFileCache, filePath, { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, proj: null }, 500);
          continue;
        }
        const resources = Array.isArray(data.projectResources?.resources) ? data.projectResources.resources : [];
        const roots = [...new Set(resources.map((r) => cleanFsPath(fileUriToPath(r?.gitFolder?.folderUri || r?.folderUri))).filter(Boolean))];
        const mainCwd = roots[0] || null;
        const envs = new Map();
        const envPaths = new Set();
        if (Array.isArray(data.environments?.environments)) {
          for (const env of data.environments.environments) {
            const paths = (Array.isArray(env.resources?.resources) ? env.resources.resources : [])
              .map((r) => cleanFsPath(fileUriToPath(r?.folderUri || r?.gitFolder?.folderUri)))
              .filter(Boolean);
            for (const ep of paths) envPaths.add(ep);
            const envObj = { id: env.id, name: env.name, path: paths[0] || null, paths };
            if (env.id) envs.set(env.id, envObj);
            if (env.name) envs.set(env.name, envObj);
          }
        }
        const proj = {
          id: data.id,
          name: data.name || path.basename(filePath, '.json'),
          mainCwd,
          roots,
          envPaths: [...envPaths],
          defaultBranch: resources.find((r) => r?.gitFolder?.defaultBranch)?.gitFolder?.defaultBranch || 'main',
          environments: envs,
        };
        setBounded(antigravityProjectFileCache, filePath, { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, proj }, 500);
        projects.set(proj.id, proj);
      } catch {}
    }
  } catch {}
  return projects;
}

function findAntigravityProjectForCwd(projectMap, rawCwd) {
  const cwd = cleanFsPath(rawCwd);
  if (!cwd || !projectMap.size) return null;
  const matches = [];
  for (const proj of projectMap.values()) {
    const paths = [...proj.roots, ...(proj.envPaths || [])];
    if (paths.some((p) => cwd === p || cwd.startsWith(`${p}/`))) {
      matches.push(proj);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function buildAntigravityProjectObservation({ scopeId, proj, projId, projName, cwd, host, updatedAt }) {
  const ts = Math.round(updatedAt || Date.now());
  if (!proj && (!projId || projId === 'outside-of-project')) {
    return { status: 'absent', source: 'antigravity-project', observedAt: ts, sourceUpdatedAt: ts, reason: null };
  }
  return makeEntityObservation({
    provider: 'antigravity',
    scopeId,
    kind: 'project',
    nativeId: proj?.id || projId,
    name: proj?.name || projName || projectName(cwd) || String(projId),
    product: 'Antigravity',
    surface: 'ide',
    cwd: proj?.mainCwd || cwd,
    roots: proj?.roots,
    hostId: host.id || 'local',
    updatedAt: ts,
  });
}

function newAntigravityTranscriptState() {
  return {
    firstPrompt: '',
    lastPrompt: '',
    lastMessage: '',
    detectedCwd: null,
    turns: 0,
    lastStep: null,
    model: 'gemini',
    maxStepTs: 0,
  };
}

function foldAntigravityStep(state, step) {
  if (!step || typeof step !== 'object') return;
  state.lastStep = {
    type: step.type || null,
    status: step.status || null,
    tool_calls: Array.isArray(step.tool_calls) ? step.tool_calls : null,
  };
  const ts = toMs(step.created_at, 0);
  if (ts && ts > state.maxStepTs) state.maxStepTs = ts;
  if (step.model && typeof step.model === 'string') state.model = step.model;
  if (step.type === 'USER_INPUT' || step.source === 'USER_EXPLICIT') {
    const cwdFromStep = extractAntigravityCwd(step.content);
    if (cwdFromStep) state.detectedCwd = cwdFromStep;
    const clean = extractAntigravityUserText(step.content);
    if (clean) {
      if (!state.firstPrompt) state.firstPrompt = clean;
      state.lastPrompt = clean;
      state.turns++;
    }
  } else if (step.type === 'PLANNER_RESPONSE' || step.source === 'MODEL') {
    if (typeof step.content === 'string' && step.content.trim()) {
      state.lastMessage = step.content.trim();
    }
  }
}

async function readAntigravityTranscriptSummary(transcriptPath) {
  const st = await stat(transcriptPath);
  if (!st) {
    antigravityTranscriptCache.delete(transcriptPath);
    return null;
  }
  const hit = antigravityTranscriptCache.get(transcriptPath);
  if (hit && hit.ino === st.ino && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    return { ...hit.data, transcriptUpdatedAt: Math.max(st.mtimeMs, hit.data.maxStepTs) };
  }
  let head = '';
  let grown = false;
  if (hit && hit.ino === st.ino && st.size > hit.size && hit.offset > 0 && hit.head !== undefined) {
    head = await readText(transcriptPath, Math.min(HEAD_CHECK_BYTES, st.size)).catch(() => '');
    grown = head.slice(0, hit.head.length) === hit.head;
  }
  const state = grown ? structuredClone(hit.data) : newAntigravityTranscriptState();
  let offset = grown ? hit.offset : 0;
  if (st.size > offset) {
    for await (const { value, end } of readJsonLinesFrom(transcriptPath, offset, grown ? null : (h) => { head = h; })) {
      foldAntigravityStep(state, value);
      offset = end;
    }
  }
  setBounded(antigravityTranscriptCache, transcriptPath, {
    ino: st.ino,
    mtimeMs: st.mtimeMs,
    size: st.size,
    offset,
    head,
    data: state,
  });
  return { ...state, transcriptUpdatedAt: Math.max(st.mtimeMs, state.maxStepTs) };
}

async function readAntigravityTaskMeta(convPath, convStat) {
  const taskPath = path.join(convPath, 'task.md');
  const taskStat = await stat(taskPath);
  const taskSig = taskStat ? `${taskStat.ino}:${taskStat.mtimeMs}:${taskStat.size}` : '-';
  const hit = antigravityTaskCache.get(convPath);
  if (hit && hit.dirIno === convStat.ino && hit.dirMtimeMs === convStat.mtimeMs && hit.taskSig === taskSig) {
    return hit;
  }
  let planSteps = null;
  let taskHeading = '';
  let artifacts = [];
  try {
    const dirEntries = await listDir(convPath);
    artifacts = dirEntries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name);
    if (taskStat && artifacts.includes('task.md')) {
      const taskText = await readText(taskPath, 32 * 1024);
      planSteps = parseMarkdownChecklist(taskText);
      const hMatch = /^#\s+(.+)$/m.exec(taskText);
      if (hMatch) taskHeading = hMatch[1].trim();
    }
  } catch {}
  const entry = { dirIno: convStat.ino, dirMtimeMs: convStat.mtimeMs, taskSig, artifacts, planSteps, taskHeading };
  setBounded(antigravityTaskCache, convPath, entry);
  return entry;
}

// ============================================================================
// 1. Antigravity IDE / Brain reader (agent: 'antigravity')
// ============================================================================
export async function listAntigravitySessions(rawOpts = {}) {
  const opts = typeof rawOpts === 'string' ? { antigravityDir: rawOpts } : rawOpts || {};
  const host = opts.host || LOCAL_HOST;
  const roots = resolveSourceDir(opts.antigravityDir || opts.dir, 'CANBAN_ANTIGRAVITY_DIR', [
    path.join(os.homedir(), '.gemini', 'antigravity'),
  ]);
  const sessions = [];
  const seenIds = new Set();

  for (const root of roots) {
    const agyRoot = root.endsWith('brain') ? path.dirname(root) : root;
    const brainDir = exists(path.join(agyRoot, 'brain')) ? path.join(agyRoot, 'brain') : (exists(root) ? root : null);
    const csDbPath = path.join(agyRoot, 'conversation_summaries.db');
    const annotationsDir = path.join(agyRoot, 'annotations');
    const hasAnnotationsDir = exists(annotationsDir);
    const projectsDir = path.join(path.dirname(agyRoot), 'config', 'projects');

    const projectMap = await loadAntigravityProjects(projectsDir);

    // Helper to read conversation brain data (transcript & task.md) with incremental caching
    async function readBrainData(convId) {
      if (!brainDir) return null;
      const convPath = path.join(brainDir, convId);
      const convStat = await stat(convPath);
      if (!convStat || !convStat.isDirectory()) return null;
      const logDir = path.join(convPath, '.system_generated', 'logs');
      const transcriptPath = exists(path.join(logDir, 'transcript.jsonl'))
        ? path.join(logDir, 'transcript.jsonl')
        : exists(path.join(logDir, 'transcript_full.jsonl'))
          ? path.join(logDir, 'transcript_full.jsonl')
          : exists(path.join(convPath, 'transcript.jsonl'))
            ? path.join(convPath, 'transcript.jsonl')
            : null;

      const [tSummary, taskMeta] = await Promise.all([
        transcriptPath ? readAntigravityTranscriptSummary(transcriptPath) : Promise.resolve(null),
        readAntigravityTaskMeta(convPath, convStat),
      ]);

      return {
        convPath,
        transcriptPath,
        firstPrompt: tSummary?.firstPrompt || '',
        lastPrompt: tSummary?.lastPrompt || '',
        lastMessage: tSummary?.lastMessage || '',
        detectedCwd: tSummary?.detectedCwd || null,
        turns: tSummary?.turns || 0,
        lastStep: tSummary?.lastStep || null,
        model: tSummary?.model || 'gemini',
        transcriptUpdatedAt: tSummary?.transcriptUpdatedAt || 0,
        planSteps: taskMeta.planSteps,
        taskHeading: taskMeta.taskHeading,
        artifacts: taskMeta.artifacts,
      };
    }

    // 1. Primary: load from conversation_summaries.db (cached by DB + WAL signature)
    let csRows = [];
    const dbSig = await sqliteSig(csDbPath);
    if (dbSig) {
      const dbHit = antigravityDbCache.get(csDbPath);
      if (dbHit && dbHit.sig === dbSig) {
        csRows = dbHit.rows;
      } else {
        try {
          csRows = queryReadOnly(csDbPath, (db) =>
            db
              .prepare(`
                SELECT conversation_id, title, preview, step_count, last_modified_time, last_user_input_time,
                       workspace_uris, status, project_id, agent_name, killed, not_fully_idle
                FROM conversation_summaries
                ORDER BY last_modified_time DESC
              `)
              .all()
          ) || [];
          setBounded(antigravityDbCache, csDbPath, { sig: dbSig, rows: csRows }, 32);
        } catch {}
      }
    } else {
      antigravityDbCache.delete(csDbPath);
    }

    const uniqueRows = [];
    for (const row of csRows) {
      const convId = row.conversation_id;
      if (!convId || seenIds.has(convId)) continue;
      seenIds.add(convId);
      uniqueRows.push(row);
    }
    const rowMeta = await mapPool(uniqueRows, 8, async (row) => {
      const convId = row.conversation_id;
      const [brain, annoTitle] = await Promise.all([
        readBrainData(convId),
        hasAnnotationsDir ? readAnnotationTitle(path.join(annotationsDir, `${convId}.pbtxt`)) : Promise.resolve(null),
      ]);
      return { row, convId, brain, annoTitle };
    });

    for (const { row, convId, brain, annoTitle } of rowMeta) {
      const dbTitle = row.title ? row.title.trim() : null;
      const titleCandidate = annoTitle || dbTitle || brain?.taskHeading || firstLine(brain?.firstPrompt) || firstLine(row.preview) || convId;
      const title = clip(titleCandidate, 120);

      let uris = [];
      try {
        uris = typeof row.workspace_uris === 'string' ? JSON.parse(row.workspace_uris) : (row.workspace_uris || []);
      } catch {}
      const firstUri = Array.isArray(uris) && uris[0] ? uris[0] : null;
      const wsPath = fileUriToPath(firstUri);
      const explicitOutside = row.project_id === 'outside-of-project';
      const rowProjId = row.project_id && !explicitOutside ? row.project_id : null;
      const proj = explicitOutside
        ? null
        : (rowProjId ? projectMap.get(rowProjId) : null)
          || findAntigravityProjectForCwd(projectMap, wsPath || brain?.detectedCwd)
          || (!row.project_id && projectMap.size === 1 ? Array.from(projectMap.values())[0] : null);

      let cwd = wsPath || brain?.detectedCwd || proj?.mainCwd || null;
      let branch = null;
      let envName = null;
      if (wsPath) {
        const wtMatch = /worktrees\/[^/]+\/([^/]+)/.exec(wsPath);
        if (wtMatch) branch = wtMatch[1];
      }
      if (proj && wsPath) {
        const cleanWs = cleanFsPath(wsPath);
        for (const env of proj.environments.values()) {
          if (env.path === cleanWs || env.paths?.includes(cleanWs)) {
            envName = env.name;
            if (!branch) branch = env.name;
            break;
          }
        }
      }
      if (!branch && proj?.defaultBranch) {
        branch = proj.defaultBranch;
      }

      const repoCtx = await resolveRepoContext(cwd || (proj?.mainCwd ? proj.mainCwd : null));
      if (!branch && repoCtx.branch) {
        branch = repoCtx.branch;
      }
      const repoRoot = repoCtx.isGit ? repoCtx.repoRoot : (proj?.mainCwd || repoCtx.repoRoot || null);
      const repoName = repoCtx.isWorktree || repoCtx.isGit ? repoCtx.repoName : (proj?.mainCwd ? path.basename(proj.mainCwd) : repoCtx.repoName || null);
      const worktreeName = repoCtx.worktreeName || (envName && cleanFsPath(cwd) !== proj?.mainCwd ? envName : null);

      const projId = proj ? proj.id : (rowProjId || 'outside-of-project');
      const projName = proj ? proj.name : (rowProjId ? rowProjId.slice(0, 8) : null);
      const displayProject = projName || repoName || (cwd ? projectName(cwd) : 'Antigravity');

      const createdAt = toMs(row.last_user_input_time || row.last_modified_time, Date.now());
      let updatedAt = toMs(row.last_modified_time, Date.now());
      if (brain?.transcriptUpdatedAt && brain.transcriptUpdatedAt > updatedAt) {
        updatedAt = brain.transcriptUpdatedAt;
      }

      const isRunning = row.status === 'CASCADE_RUN_STATUS_RUNNING' || Boolean(row.not_fully_idle);
      const isKilled = Boolean(row.killed);

      const firstPrompt = brain?.firstPrompt || cleanPrompt(row.preview) || null;
      const lastPrompt = brain?.lastPrompt || firstPrompt;
      const lastMessage = brain?.lastMessage || null;

      const projectObs = buildAntigravityProjectObservation({
        scopeId: brainDir || agyRoot,
        proj,
        projId,
        projName: displayProject,
        cwd,
        host,
        updatedAt,
      });

      const brainObs = makeEntityObservation({
        provider: 'antigravity',
        scopeId: brainDir || agyRoot,
        kind: 'brain',
        nativeId: convId,
        name: displayProject,
        product: 'Antigravity',
        surface: 'ide',
        cwd,
        hostId: host.id || 'local',
        updatedAt,
      });

      sessions.push({
        id: sessionKey('antigravity', host, convId),
        nativeId: convId,
        agent: 'antigravity',
        surface: 'ide',
        entrypoint: 'antigravity',
        host,
        title,
        firstPrompt: clip(firstPrompt, 240) || null,
        lastPrompt: clip(lastPrompt, 240) || null,
        lastMessage: clip(firstLine(lastMessage), 200) || null,
        cwd,
        project: displayProject,
        branch,
        repoRoot,
        repoName,
        worktreeName,
        model: brain?.model || 'gemini',
        reasoningEffort: null,
        createdAt: Math.round(createdAt),
        updatedAt: Math.round(updatedAt),
        archived: isKilled,
        subagent: false,
        turns: Math.max(1, brain?.turns || row.step_count || 1),
        sourcePath: brain?.transcriptPath || (dbSig ? `${csDbPath}#${convId}` : null),
        sourceMetadata: {
          antigravityProject: projectObs,
          antigravityBrain: brainObs,
          artifacts: brain?.artifacts || [],
          planSteps: brain?.planSteps || null,
          lastStepType: brain?.lastStep?.type || null,
          lastStepStatus: brain?.lastStep?.status || null,
          lastToolCalls: Array.isArray(brain?.lastStep?.tool_calls) ? brain.lastStep.tool_calls : null,
          status: row.status,
          isRunning,
          isKilled,
          environment: branch,
          projectId: projId,
        },
      });
    }

    // 2. Fallback: inspect brain directory for any conversations not present in csDb
    if (brainDir && exists(brainDir)) {
      const convIds = await listSubdirs(brainDir);
      for (const convId of convIds) {
        if (convId.startsWith('.') || seenIds.has(convId)) continue;
        seenIds.add(convId);
        const brain = await readBrainData(convId);
        if (!brain || (!brain.firstPrompt && !brain.lastMessage && !brain.taskHeading)) continue;

        let annoTitle = null;
        if (hasAnnotationsDir) {
          annoTitle = await readAnnotationTitle(path.join(annotationsDir, `${convId}.pbtxt`));
        }
        const titleSource = annoTitle || brain.taskHeading || firstLine(brain.firstPrompt) || firstLine(brain.lastMessage) || convId;
        const proj = findAntigravityProjectForCwd(projectMap, brain.detectedCwd)
          || (projectMap.size === 1 ? Array.from(projectMap.values())[0] : null);
        const cwd = brain.detectedCwd || proj?.mainCwd || null;
        const repoCtx = await resolveRepoContext(cwd || (proj?.mainCwd ? proj.mainCwd : null));
        const repoRoot = repoCtx.isGit ? repoCtx.repoRoot : (proj?.mainCwd || repoCtx.repoRoot || null);
        const repoName = repoCtx.isWorktree || repoCtx.isGit ? repoCtx.repoName : (proj?.mainCwd ? path.basename(proj.mainCwd) : repoCtx.repoName || null);
        const worktreeName = repoCtx.worktreeName || null;
        const projId = proj ? proj.id : 'outside-of-project';
        const projName = proj ? proj.name : null;
        const displayProject = projName || repoName || projectName(cwd) || 'Antigravity';

        const projectObs = buildAntigravityProjectObservation({
          scopeId: brainDir,
          proj,
          projId,
          projName: displayProject,
          cwd,
          host,
          updatedAt: brain.transcriptUpdatedAt,
        });

        const brainObs = makeEntityObservation({
          provider: 'antigravity',
          scopeId: brainDir,
          kind: 'brain',
          nativeId: convId,
          name: displayProject,
          product: 'Antigravity',
          surface: 'ide',
          cwd,
          hostId: host.id || 'local',
          updatedAt: brain.transcriptUpdatedAt,
        });

        sessions.push({
          id: sessionKey('antigravity', host, convId),
          nativeId: convId,
          agent: 'antigravity',
          surface: 'ide',
          entrypoint: 'antigravity',
          host,
          title: clip(titleSource, 120),
          firstPrompt: clip(brain.firstPrompt, 240) || null,
          lastPrompt: clip(brain.lastPrompt, 240) || null,
          lastMessage: clip(firstLine(brain.lastMessage), 200) || null,
          cwd,
          project: displayProject,
          branch: repoCtx.branch || null,
          repoRoot,
          repoName,
          worktreeName,
          model: brain.model || 'gemini',
          reasoningEffort: null,
          createdAt: Math.round(brain.transcriptUpdatedAt || Date.now()),
          updatedAt: Math.round(brain.transcriptUpdatedAt || Date.now()),
          archived: false,
          subagent: false,
          turns: Math.max(1, brain.turns),
          sourcePath: brain.transcriptPath,
          sourceMetadata: {
            antigravityProject: projectObs,
            antigravityBrain: brainObs,
            artifacts: brain.artifacts,
            planSteps: brain.planSteps,
            lastStepType: brain.lastStep?.type || null,
            lastStepStatus: brain.lastStep?.status || null,
            lastToolCalls: Array.isArray(brain.lastStep?.tool_calls) ? brain.lastStep.tool_calls : null,
          },
        });
      }
    }
  }
  return { sessions, error: null };
}

// ============================================================================
// 2. Gemini CLI reader (agent: 'gemini')
// ============================================================================
async function collectGeminiSessionFiles(home) {
  const files = [];
  for (const sub of ['sessions', 'chats']) {
    const dir = path.join(home, sub);
    for (const e of await listDir(dir)) {
      if (e.isFile() && (e.name.endsWith('.json') || e.name.endsWith('.jsonl'))) {
        files.push({ file: path.join(dir, e.name), projectDir: null });
      }
    }
  }
  for (const bucket of ['tmp', 'history']) {
    const base = path.join(home, bucket);
    for (const proj of await listSubdirs(base)) {
      const projDir = path.join(base, proj);
      for (const e of await listDir(projDir)) {
        if (e.isFile() && (e.name.endsWith('.json') || e.name.endsWith('.jsonl')) && !e.name.startsWith('.')) {
          files.push({ file: path.join(projDir, e.name), projectDir: projDir });
        }
      }
      const chatsDir = path.join(projDir, 'chats');
      for (const e of await listDir(chatsDir)) {
        if (e.isFile() && (e.name.endsWith('.json') || e.name.endsWith('.jsonl'))) {
          files.push({ file: path.join(chatsDir, e.name), projectDir: projDir });
        }
      }
    }
  }
  return files;
}

function extractMessageText(msg) {
  if (!msg) return '';
  if (typeof msg === 'string') return msg;
  if (typeof msg.text === 'string') return msg.text;
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((c) => (typeof c === 'string' ? c : c?.text || c?.content || ''))
      .filter(Boolean)
      .join('\n');
  }
  if (Array.isArray(msg.parts)) {
    return msg.parts
      .map((p) => (typeof p === 'string' ? p : p?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function newGenericFoldState(defaultMeta) {
  return {
    header: {},
    firstPrompt: '',
    lastPrompt: '',
    lastMessage: '',
    cwd: defaultMeta.cwd || null,
    branch: null,
    model: defaultMeta.model || null,
    maxRecordTs: 0,
    turns: 0,
  };
}

function foldGenericRecord(state, r, isJsonlHeaderCandidate = false) {
  if (!r || typeof r !== 'object') return;
  if (isJsonlHeaderCandidate && (r.type === 'session_meta' || r.type === 'meta' || (!r.role && !r.type && (r.cwd || r.title || r.model)))) {
    const { messages: _m, history: _h, turns: _t, items: _i, ...meta } = r;
    state.header = { ...state.header, ...meta };
    if (meta.cwd || meta.workingDirectory) state.cwd = meta.cwd || meta.workingDirectory;
    if (meta.gitBranch || meta.branch) state.branch = meta.gitBranch || meta.branch;
    if (meta.model) state.model = meta.model;
  }
  if (r.cwd && typeof r.cwd === 'string') state.cwd = r.cwd;
  if (r.gitBranch && typeof r.gitBranch === 'string') state.branch = r.gitBranch;
  if (r.model && typeof r.model === 'string') state.model = r.model;
  const ts = toMs(r.timestamp || r.createdAt || r.created_at || r.time, 0);
  if (ts > state.maxRecordTs) state.maxRecordTs = ts;
  const role = String(r.role || r.author?.role || r.sender || r.type || '').toLowerCase();
  const text = extractMessageText(r.message || r);
  if (role === 'user' || role === 'human') {
    const clean = cleanPrompt(text);
    if (clean) {
      if (!state.firstPrompt) state.firstPrompt = clean;
      state.lastPrompt = clean;
      state.turns++;
    }
  } else if (role === 'assistant' || role === 'model' || role === 'agent' || role === 'bot' || role === 'gemini' || role === 'grok') {
    if (text.trim()) state.lastMessage = text.trim();
  }
}

function finalizeGenericSession(filePath, st, state) {
  const header = state.header || {};
  const createdAt = toMs(header.createdAt || header.created_at || header.startTime, st.birthtimeMs || st.mtimeMs);
  const headerUpdated = toMs(header.updatedAt || header.updated_at || header.lastUpdatedAt, st.mtimeMs);
  const updatedAt = Math.max(headerUpdated, state.maxRecordTs);
  const title = header.title || header.name || firstLine(state.firstPrompt) || firstLine(state.lastMessage);
  if (!title) return null;
  const nativeId = String(header.id || header.sessionId || header.conversationId || path.basename(filePath, path.extname(filePath)));
  return {
    nativeId,
    title: clip(title, 120),
    firstPrompt: clip(state.firstPrompt, 240) || null,
    lastPrompt: clip(state.lastPrompt, 240) || null,
    lastMessage: clip(firstLine(state.lastMessage), 200) || null,
    cwd: state.cwd,
    branch: state.branch,
    model: state.model,
    createdAt: Math.round(createdAt),
    updatedAt: Math.round(updatedAt),
    turns: Math.max(1, state.turns),
    archived: Boolean(header.archived),
    header: { workspace: header.workspace || null, surface: header.surface || null, bot: Boolean(header.bot) },
  };
}

async function parseGenericSessionFile(filePath, defaultMeta = {}) {
  const st = await stat(filePath);
  if (!st) {
    genericSessionCache.delete(filePath);
    return null;
  }
  const defaultCwd = defaultMeta.cwd || null;
  const defaultModel = defaultMeta.model || null;
  const hit = genericSessionCache.get(filePath);
  if (
    hit &&
    hit.ino === st.ino &&
    hit.mtimeMs === st.mtimeMs &&
    hit.size === st.size &&
    hit.defaultCwd === defaultCwd &&
    hit.defaultModel === defaultModel
  ) {
    return hit.parsed;
  }

  if (filePath.endsWith('.jsonl')) {
    let head = '';
    let grown = false;
    if (
      hit &&
      hit.state &&
      hit.ino === st.ino &&
      st.size > hit.size &&
      hit.offset > 0 &&
      hit.head !== undefined &&
      hit.defaultCwd === defaultCwd &&
      hit.defaultModel === defaultModel
    ) {
      head = await readText(filePath, Math.min(HEAD_CHECK_BYTES, st.size)).catch(() => '');
      grown = head.slice(0, hit.head.length) === hit.head;
    }
    const state = grown ? structuredClone(hit.state) : newGenericFoldState(defaultMeta);
    let offset = grown ? hit.offset : 0;
    if (st.size > offset) {
      for await (const { value, end } of readJsonLinesFrom(filePath, offset, grown ? null : (h) => { head = h; })) {
        foldGenericRecord(state, value, true);
        offset = end;
      }
    }
    const parsed = finalizeGenericSession(filePath, st, state);
    setBounded(genericSessionCache, filePath, {
      ino: st.ino,
      mtimeMs: st.mtimeMs,
      size: st.size,
      offset,
      head,
      defaultCwd,
      defaultModel,
      state,
      parsed,
    });
    return parsed;
  }

  const state = newGenericFoldState(defaultMeta);
  try {
    const data = await readJson(filePath);
    if (Array.isArray(data)) {
      for (const r of data) foldGenericRecord(state, r, false);
    } else if (data && typeof data === 'object') {
      const { messages, history, turns, items, ...headerMeta } = data;
      state.header = headerMeta;
      state.cwd = headerMeta.cwd || headerMeta.workingDirectory || state.cwd;
      state.branch = headerMeta.gitBranch || headerMeta.branch || null;
      state.model = headerMeta.model || state.model;
      const list = messages || history || turns || items || [];
      if (Array.isArray(list)) {
        for (const r of list) foldGenericRecord(state, r, false);
      }
    }
  } catch {
    return null;
  }
  const parsed = finalizeGenericSession(filePath, st, state);
  setBounded(genericSessionCache, filePath, {
    ino: st.ino,
    mtimeMs: st.mtimeMs,
    size: st.size,
    offset: st.size,
    defaultCwd,
    defaultModel,
    state: null,
    parsed,
  });
  return parsed;
}

async function readGeminiProjectRoot(projectDir) {
  if (!projectDir) return null;
  const rootFile = path.join(projectDir, '.project_root');
  const st = await stat(rootFile);
  if (!st) {
    geminiRootFileCache.delete(rootFile);
    return null;
  }
  const hit = geminiRootFileCache.get(rootFile);
  if (hit && hit.ino === st.ino && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.cwd;
  try {
    const rootText = (await readText(rootFile, 1024)).trim();
    const cwd = rootText.startsWith('/') ? rootText : null;
    setBounded(geminiRootFileCache, rootFile, { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, cwd }, 500);
    return cwd;
  } catch {
    return null;
  }
}

export async function listGeminiSessions(rawOpts = {}) {
  const opts = typeof rawOpts === 'string' ? { geminiHome: rawOpts } : rawOpts || {};
  const host = opts.host || LOCAL_HOST;
  const roots = resolveSourceDir(opts.geminiHome || opts.dir, 'CANBAN_GEMINI_HOME', [
    path.join(os.homedir(), '.gemini'),
  ]);
  const sessions = [];
  for (const home of roots) {
    if (!exists(home)) continue;
    const entries = await collectGeminiSessionFiles(home);
    const parsedEntries = await mapPool(entries, 8, async ({ file, projectDir }) => {
      const defaultCwd = await readGeminiProjectRoot(projectDir);
      const parsed = await parseGenericSessionFile(file, { cwd: defaultCwd, model: 'gemini-2.5-pro' });
      return { file, projectDir, parsed };
    });
    for (const { file, projectDir, parsed } of parsedEntries) {
      if (!parsed) continue;
      const projLabel = projectName(parsed.cwd) || (projectDir ? path.basename(projectDir) : null);
      sessions.push({
        id: sessionKey('gemini', host, parsed.nativeId),
        nativeId: parsed.nativeId,
        agent: 'gemini',
        surface: 'cli',
        entrypoint: 'gemini-cli',
        host,
        title: parsed.title,
        firstPrompt: parsed.firstPrompt,
        lastPrompt: parsed.lastPrompt,
        lastMessage: parsed.lastMessage,
        cwd: parsed.cwd,
        project: projLabel,
        branch: parsed.branch,
        model: parsed.model,
        reasoningEffort: null,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        archived: parsed.archived,
        subagent: false,
        turns: parsed.turns,
        sourcePath: file,
        sourceMetadata: {
          geminiProject: projLabel
            ? makeEntityObservation({
                provider: 'gemini',
                scopeId: home,
                kind: 'project',
                nativeId: parsed.cwd || projLabel,
                name: projLabel,
                product: 'Gemini CLI',
                surface: 'cli',
                cwd: parsed.cwd,
                hostId: host.id || 'local',
                updatedAt: parsed.updatedAt,
              })
            : null,
        },
      });
    }
  }
  return { sessions, error: null };
}

// ============================================================================
// 3. Cursor IDE & CLI reader (agent: 'cursor')
// ============================================================================

async function readCursorVscdbEntry(wsDir, dbPath) {
  const dbSig = await sqliteSig(dbPath);
  if (!dbSig) {
    cursorVscdbCache.delete(dbPath);
    return null;
  }
  const wsJsonPath = path.join(wsDir, 'workspace.json');
  const wsStat = await stat(wsJsonPath);
  const wsSig = wsStat ? `${wsStat.ino}:${wsStat.mtimeMs}:${wsStat.size}` : '-';
  const hit = cursorVscdbCache.get(dbPath);
  if (hit && hit.sig === dbSig && hit.wsSig === wsSig) return hit;

  let cwd = null;
  if (wsStat) {
    try {
      const wsMeta = await readJson(wsJsonPath);
      cwd = fileUriToPath(wsMeta?.folder || wsMeta?.workspace);
    } catch {}
  }
  let rows = [];
  try {
    rows = queryReadOnly(dbPath, (db) =>
      db
        .prepare("SELECT key, value FROM ItemTable WHERE key IN ('composer.composerData', 'aiService.prompts', 'aiService.generations')")
        .all()
    );
  } catch {
    return null;
  }
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (!byKey['composer.composerData']) {
    const emptyEntry = { sig: dbSig, wsSig, cwd, composers: [], prompts: [], generations: [] };
    setBounded(cursorVscdbCache, dbPath, emptyEntry, 256);
    return emptyEntry;
  }
  let composerData;
  try {
    composerData = JSON.parse(byKey['composer.composerData']);
  } catch {
    return null;
  }
  let prompts = [];
  let generations = [];
  try {
    if (byKey['aiService.prompts']) prompts = JSON.parse(byKey['aiService.prompts']) || [];
  } catch {}
  try {
    if (byKey['aiService.generations']) generations = JSON.parse(byKey['aiService.generations']) || [];
  } catch {}

  const composers = Array.isArray(composerData?.allComposers) ? composerData.allComposers : [];
  const entry = {
    sig: dbSig,
    wsSig,
    cwd,
    composers,
    prompts: prompts.length ? [prompts[0], prompts.at(-1)].filter(Boolean) : [],
    promptCount: prompts.length,
    generations: generations.length ? [generations[0]] : [],
  };
  setBounded(cursorVscdbCache, dbPath, entry, 256);
  return entry;
}

export async function listCursorSessions(rawOpts = {}, extraWsDir = null) {
  const opts = typeof rawOpts === 'string' ? { cursorHome: rawOpts, cursorWorkspaceDir: extraWsDir } : rawOpts || {};
  const host = opts.host || LOCAL_HOST;
  const cursorHomes = resolveSourceDir(opts.cursorHome, 'CANBAN_CURSOR_HOME', [
    path.join(os.homedir(), '.cursor'),
  ]);
  const wsDirs = resolveSourceDir(opts.cursorWorkspaceDir, 'CANBAN_CURSOR_WORKSPACE_DIR', [
    path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage'),
  ]);
  // If cursorHome has a workspaceStorage subfolder (e.g. in fixtures), scan it too
  for (const ch of cursorHomes) {
    const nestedWs = path.join(ch, 'workspaceStorage');
    if (exists(nestedWs) && !wsDirs.includes(nestedWs)) wsDirs.push(nestedWs);
  }

  const sessions = [];
  const seenIds = new Set();

  // (A) Cursor CLI / Background Agent transcripts under ~/.cursor
  for (const home of cursorHomes) {
    if (!exists(home)) continue;
    const transcriptFiles = [];
    for (const sub of ['chats', 'sessions']) {
      const d = path.join(home, sub);
      for (const e of await listDir(d)) {
        if (e.isFile() && (e.name.endsWith('.jsonl') || e.name.endsWith('.json'))) {
          transcriptFiles.push({ file: path.join(d, e.name), surface: 'cli', wsName: null });
        }
      }
    }
    const projectsDir = path.join(home, 'projects');
    for (const proj of await listSubdirs(projectsDir)) {
      if (proj.startsWith('.')) continue;
      const projPath = path.join(projectsDir, proj);
      for (const sub of ['agent-transcripts', 'chats', 'sessions']) {
        const subDir = path.join(projPath, sub);
        for (const e of await listDir(subDir)) {
          if (e.isFile() && (e.name.endsWith('.jsonl') || e.name.endsWith('.json'))) {
            transcriptFiles.push({ file: path.join(subDir, e.name), surface: sub === 'agent-transcripts' ? 'ide' : 'cli', wsName: proj });
          }
        }
      }
    }
    const parsedTranscripts = await mapPool(transcriptFiles, 8, async (item) => ({
      ...item,
      parsed: await parseGenericSessionFile(item.file, { model: 'cursor-agent' }),
    }));
    for (const { file, surface, wsName, parsed } of parsedTranscripts) {
      if (!parsed) continue;
      if (seenIds.has(parsed.nativeId)) continue;
      seenIds.add(parsed.nativeId);
      const projLabel = projectName(parsed.cwd) || wsName || 'Cursor';
      sessions.push({
        id: sessionKey('cursor', host, parsed.nativeId),
        nativeId: parsed.nativeId,
        agent: 'cursor',
        surface,
        entrypoint: surface === 'cli' ? 'cursor-cli' : 'cursor-ide',
        host,
        title: parsed.title,
        firstPrompt: parsed.firstPrompt,
        lastPrompt: parsed.lastPrompt,
        lastMessage: parsed.lastMessage,
        cwd: parsed.cwd,
        project: projLabel,
        branch: parsed.branch,
        model: parsed.model,
        reasoningEffort: null,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        archived: parsed.archived,
        subagent: false,
        turns: parsed.turns,
        sourcePath: file,
        sourceMetadata: {
          cursorWorkspace: projLabel
            ? makeEntityObservation({
                provider: 'cursor',
                scopeId: home,
                kind: 'workspace',
                nativeId: parsed.cwd || projLabel,
                name: projLabel,
                product: 'Cursor',
                surface,
                cwd: parsed.cwd,
                hostId: host.id || 'local',
                updatedAt: parsed.updatedAt,
              })
            : null,
        },
      });
    }
  }

  // (B) Cursor IDE workspaceStorage SQLite (state.vscdb)
  for (const wsRoot of wsDirs) {
    if (!exists(wsRoot)) continue;
    const hashes = await listSubdirs(wsRoot);
    for (const wsHash of hashes) {
      if (wsHash.startsWith('.')) continue;
      const wsDir = path.join(wsRoot, wsHash);
      const dbPath = path.join(wsDir, 'state.vscdb');
      const vscdbEntry = await readCursorVscdbEntry(wsDir, dbPath);
      if (!vscdbEntry || !vscdbEntry.composers.length) continue;
      const { cwd, composers, prompts, promptCount = 0, generations } = vscdbEntry;

      const wsLabel = projectName(cwd) || wsHash.slice(0, 8);
      for (const comp of composers) {
        if (!comp || !comp.composerId) continue;
        if (seenIds.has(comp.composerId)) continue;
        const rawTitle = (comp.name || '').trim();
        const subtitle = (comp.subtitle || '').trim();
        const fallbackPrompt = prompts[0]?.text ? firstLine(prompts[0].text) : generations[0]?.textDescription ? firstLine(generations[0].textDescription) : '';
        // Skip completely empty untitled draft composers
        if (!rawTitle && !subtitle && !comp.filesChangedCount && !comp.totalLinesAdded) continue;
        const title = clip(rawTitle || fallbackPrompt || subtitle || `Composer ${comp.composerId.slice(0, 8)}`, 120);
        seenIds.add(comp.composerId);
        const createdAt = toMs(comp.createdAt, Date.now());
        const updatedAt = toMs(comp.lastUpdatedAt || comp.createdAt, createdAt);

        sessions.push({
          id: sessionKey('cursor', host, comp.composerId),
          nativeId: comp.composerId,
          agent: 'cursor',
          surface: 'ide',
          entrypoint: 'cursor-ide',
          host,
          title,
          firstPrompt: clip(fallbackPrompt || rawTitle, 240) || null,
          lastPrompt: clip(prompts.at(-1)?.text || fallbackPrompt || rawTitle, 240) || null,
          lastMessage: clip(subtitle || rawTitle, 200) || null,
          cwd: cwd || null,
          project: wsLabel,
          branch: comp.gitBranch || null,
          model: comp.model || (comp.unifiedMode ? `cursor-${comp.unifiedMode}` : 'cursor-agent'),
          reasoningEffort: null,
          createdAt,
          updatedAt,
          archived: Boolean(comp.isArchived),
          subagent: false,
          turns: Math.max(1, promptCount || 1),
          sourcePath: `${dbPath}#composer:${comp.composerId}`,
          sourceMetadata: {
            cursorWorkspace: makeEntityObservation({
              provider: 'cursor',
              scopeId: wsRoot,
              kind: 'workspace',
              nativeId: cwd || wsHash,
              name: wsLabel,
              product: 'Cursor',
              surface: 'ide',
              cwd,
              hostId: host.id || 'local',
              updatedAt,
            }),
            cursorStats: {
              linesAdded: comp.totalLinesAdded || 0,
              linesRemoved: comp.totalLinesRemoved || 0,
              filesChangedCount: comp.filesChangedCount || 0,
              contextUsagePercent: typeof comp.contextUsagePercent === 'number' ? Math.round(comp.contextUsagePercent) : null,
              hasBlockingPendingActions: Boolean(comp.hasBlockingPendingActions),
              subtitle: subtitle || null,
            },
          },
        });
      }
    }
  }
  return { sessions, error: null };
}

// ============================================================================
// 4. ChatGPT Desktop reader (agent: 'chatgpt')
// ============================================================================
function parseChatGptConversationObject(conv, fallbackId, fallbackTime, projectMeta = null, { includeMessages = true } = {}) {
  if (!conv || typeof conv !== 'object') return null;
  const nativeId = String(conv.id || conv.conversation_id || fallbackId);
  let firstPrompt = '';
  let lastPrompt = '';
  let lastMessage = '';
  let model = conv.default_model_slug || conv.model || 'gpt-4o';
  let createdAt = toMs(conv.create_time || conv.createdAt || conv.created_at, fallbackTime);
  let updatedAt = toMs(conv.update_time || conv.updatedAt || conv.updated_at, createdAt);
  let turns = 0;
  const normalizedMessages = includeMessages ? [] : null;

  if (conv.mapping && typeof conv.mapping === 'object') {
    const nodes = Object.values(conv.mapping)
      .filter((n) => n && n.message && n.message.author)
      .sort((a, b) => (a.message.create_time || 0) - (b.message.create_time || 0));
    for (const node of nodes) {
      const m = node.message;
      const role = m.author?.role;
      if (role !== 'user' && role !== 'assistant') continue;
      if (m.metadata?.model_slug) model = m.metadata.model_slug;
      const text = extractMessageText(m.content).trim();
      if (!text) continue;
      const ts = toMs(m.create_time, updatedAt);
      if (ts > updatedAt) updatedAt = ts;
      if (normalizedMessages) normalizedMessages.push({ role, text, timestamp: ts });
      if (role === 'user') {
        const clean = cleanPrompt(text);
        if (!firstPrompt) firstPrompt = clean;
        lastPrompt = clean;
        turns++;
      } else {
        lastMessage = text;
      }
    }
  } else if (Array.isArray(conv.messages)) {
    for (const m of conv.messages) {
      if (!m || typeof m !== 'object') continue;
      const role = m.role === 'user' || m.role === 'human' ? 'user' : m.role === 'assistant' || m.role === 'model' ? 'assistant' : null;
      if (!role) continue;
      const text = extractMessageText(m).trim();
      if (!text) continue;
      const ts = toMs(m.timestamp || m.createdAt || m.create_time, updatedAt);
      if (ts > updatedAt) updatedAt = ts;
      if (normalizedMessages) normalizedMessages.push({ role, text, timestamp: ts });
      if (role === 'user') {
        if (!firstPrompt) firstPrompt = text;
        lastPrompt = text;
        turns++;
      } else {
        lastMessage = text;
      }
    }
  }

  const title = (conv.title || firstLine(firstPrompt) || firstLine(lastMessage) || '').trim();
  if (!title) return null;
  const projId = conv.project_id || conv.gizmo_id || conv.workspace_id || projectMeta?.id || null;
  const projName = conv.project_name || conv.project || projectMeta?.name || (projId ? `Project ${String(projId).slice(-6)}` : null);

  return {
    nativeId,
    title: clip(title, 120),
    firstPrompt: clip(firstPrompt, 240) || null,
    lastPrompt: clip(lastPrompt, 240) || null,
    lastMessage: clip(firstLine(lastMessage), 200) || null,
    cwd: conv.cwd || null,
    project: projName || 'ChatGPT',
    model,
    createdAt: Math.round(createdAt),
    updatedAt: Math.round(updatedAt),
    archived: Boolean(conv.is_archived || conv.archived),
    turns: Math.max(1, turns),
    chatgptProject: projId || projName ? { id: String(projId || projName), name: String(projName || projId) } : null,
    ...(normalizedMessages ? { messages: normalizedMessages } : {}),
  };
}

export async function listChatGptSessions(rawOpts = {}) {
  const opts = typeof rawOpts === 'string' ? { chatgptDir: rawOpts } : rawOpts || {};
  const host = opts.host || LOCAL_HOST;
  const roots = resolveSourceDir(opts.chatgptDir || opts.dir, 'CANBAN_CHATGPT_DIR', [
    path.join(os.homedir(), 'Library', 'Application Support', 'com.openai.chat'),
  ]);
  const sessions = [];
  const seen = new Set();

  for (const root of roots) {
    if (!exists(root)) continue;
    const candidateFiles = [];
    for (const e of await listDir(root)) {
      if (e.isFile() && (e.name.endsWith('.json') || e.name.endsWith('.jsonl'))) {
        candidateFiles.push({ file: path.join(root, e.name), proj: null });
      }
    }
    for (const sub of await listSubdirs(root)) {
      if (sub.startsWith('.')) continue;
      const subPath = path.join(root, sub);
      const isProjDir = sub.startsWith('project-') || sub === 'projects' || sub === 'conversations' || sub.startsWith('conversations-');
      if (!isProjDir) continue;
      const projMeta = sub.startsWith('project-') ? { id: sub, name: `ChatGPT ${sub.slice(0, 16)}` } : null;
      for (const e of await listDir(subPath)) {
        if (e.isFile() && (e.name.endsWith('.json') || e.name.endsWith('.jsonl') || e.name.endsWith('.data'))) {
          candidateFiles.push({ file: path.join(subPath, e.name), proj: projMeta });
        } else if (e.isDirectory()) {
          const nestedPath = path.join(subPath, e.name);
          const nestedProj = { id: e.name, name: e.name };
          for (const ne of await listDir(nestedPath)) {
            if (ne.isFile() && (ne.name.endsWith('.json') || ne.name.endsWith('.jsonl'))) {
              candidateFiles.push({ file: path.join(nestedPath, ne.name), proj: nestedProj });
            }
          }
        }
      }
    }

    for (const { file, proj } of candidateFiles) {
      const st = await stat(file);
      if (!st || st.size < 2) continue;
      try {
        if (file.endsWith('.jsonl')) {
          const parsed = await parseGenericSessionFile(file, { model: 'gpt-4o' });
          if (!parsed || seen.has(parsed.nativeId)) continue;
          seen.add(parsed.nativeId);
          sessions.push({
            id: sessionKey('chatgpt', host, parsed.nativeId),
            nativeId: parsed.nativeId,
            agent: 'chatgpt',
            surface: 'desktop',
            entrypoint: 'chatgpt-desktop',
            host,
            title: parsed.title,
            firstPrompt: parsed.firstPrompt,
            lastPrompt: parsed.lastPrompt,
            lastMessage: parsed.lastMessage,
            cwd: parsed.cwd,
            project: proj?.name || projectName(parsed.cwd) || 'ChatGPT',
            branch: parsed.branch,
            model: parsed.model || 'gpt-4o',
            reasoningEffort: null,
            createdAt: parsed.createdAt,
            updatedAt: parsed.updatedAt,
            archived: parsed.archived,
            subagent: false,
            turns: parsed.turns,
            sourcePath: file,
            sourceMetadata: {
              chatgptProject: proj
                ? makeEntityObservation({
                    provider: 'chatgpt',
                    scopeId: root,
                    kind: 'project',
                    nativeId: proj.id,
                    name: proj.name,
                    product: 'ChatGPT',
                    surface: 'desktop',
                    cwd: parsed.cwd,
                    hostId: host.id || 'local',
                    updatedAt: parsed.updatedAt,
                  })
                : null,
            },
          });
          continue;
        }
        const projKey = proj ? `${proj.id}:${proj.name}` : '';
        const hit = chatgptFileCache.get(file);
        let convList;
        if (hit && hit.ino === st.ino && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.projKey === projKey) {
          convList = hit.items;
        } else {
          // Only parse .data files if they start with JSON '{' or '[' (skip encrypted binary cache files)
          if (file.endsWith('.data')) {
            const head = (await readText(file, 16)).trimStart();
            if (!head.startsWith('{') && !head.startsWith('[')) {
              setBounded(chatgptFileCache, file, { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, projKey, items: [] }, 500);
              continue;
            }
          }
          const json = await readJson(file);
          const list = Array.isArray(json) ? json : Array.isArray(json?.conversations) ? json.conversations : [json];
          const fallbackId = path.basename(file, path.extname(file));
          convList = list
            .map((item) => parseChatGptConversationObject(item, fallbackId, st.mtimeMs, proj, { includeMessages: false }))
            .filter(Boolean);
          setBounded(chatgptFileCache, file, { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, projKey, items: convList }, 500);
        }
        for (const conv of convList) {
          if (seen.has(conv.nativeId)) continue;
          seen.add(conv.nativeId);
          sessions.push({
            id: sessionKey('chatgpt', host, conv.nativeId),
            nativeId: conv.nativeId,
            agent: 'chatgpt',
            surface: 'desktop',
            entrypoint: 'chatgpt-desktop',
            host,
            title: conv.title,
            firstPrompt: conv.firstPrompt,
            lastPrompt: conv.lastPrompt,
            lastMessage: conv.lastMessage,
            cwd: conv.cwd,
            project: conv.project,
            branch: null,
            model: conv.model,
            reasoningEffort: null,
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt,
            archived: conv.archived,
            subagent: false,
            turns: conv.turns,
            sourcePath: `${file}#chatgpt:${conv.nativeId}`,
            sourceMetadata: {
              chatgptProject: conv.chatgptProject
                ? makeEntityObservation({
                    provider: 'chatgpt',
                    scopeId: root,
                    kind: 'project',
                    nativeId: conv.chatgptProject.id,
                    name: conv.chatgptProject.name,
                    product: 'ChatGPT',
                    surface: 'desktop',
                    cwd: conv.cwd,
                    hostId: host.id || 'local',
                    updatedAt: conv.updatedAt,
                  })
                : null,
            },
          });
        }
      } catch {}
    }
  }
  return { sessions, error: null };
}

// ============================================================================
// 5. Grok CLI / Bot reader (agent: 'grok')
// ============================================================================
export async function listGrokSessions(rawOpts = {}) {
  const opts = typeof rawOpts === 'string' ? { grokHome: rawOpts } : rawOpts || {};
  const host = opts.host || LOCAL_HOST;
  const roots = resolveSourceDir(opts.grokHome || opts.dir, 'CANBAN_GROK_HOME', [
    path.join(os.homedir(), '.grok'),
    path.join(os.homedir(), '.config', 'grok'),
  ]);
  const sessions = [];
  const seen = new Set();

  for (const home of roots) {
    if (!exists(home)) continue;
    const files = [];
    for (const e of await listDir(home)) {
      if (e.isFile() && (e.name.endsWith('.json') || e.name.endsWith('.jsonl')) && !e.name.startsWith('.')) {
        files.push(path.join(home, e.name));
      }
    }
    for (const sub of ['sessions', 'chats', 'history']) {
      const subDir = path.join(home, sub);
      for (const e of await listDir(subDir)) {
        if (e.isFile() && (e.name.endsWith('.json') || e.name.endsWith('.jsonl'))) {
          files.push(path.join(subDir, e.name));
        }
      }
    }
    const parsedFiles = await mapPool(files, 8, async (file) => ({
      file,
      parsed: await parseGenericSessionFile(file, { model: 'grok-3' }),
    }));
    for (const { file, parsed } of parsedFiles) {
      if (!parsed || seen.has(parsed.nativeId)) continue;
      seen.add(parsed.nativeId);
      const wsLabel = projectName(parsed.cwd) || parsed.header?.workspace || 'Grok';
      const surface = parsed.header?.surface || (parsed.header?.bot ? 'cloud' : 'cli');
      sessions.push({
        id: sessionKey('grok', host, parsed.nativeId),
        nativeId: parsed.nativeId,
        agent: 'grok',
        surface,
        entrypoint: surface === 'cloud' ? 'grok-bot' : 'grok-cli',
        host,
        title: parsed.title,
        firstPrompt: parsed.firstPrompt,
        lastPrompt: parsed.lastPrompt,
        lastMessage: parsed.lastMessage,
        cwd: parsed.cwd,
        project: wsLabel,
        branch: parsed.branch,
        model: parsed.model,
        reasoningEffort: null,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        archived: parsed.archived,
        subagent: false,
        turns: parsed.turns,
        sourcePath: file,
        sourceMetadata: {
          grokWorkspace: wsLabel
            ? makeEntityObservation({
                provider: 'grok',
                scopeId: home,
                kind: 'workspace',
                nativeId: parsed.cwd || wsLabel,
                name: wsLabel,
                product: 'Grok',
                surface,
                cwd: parsed.cwd,
                hostId: host.id || 'local',
                updatedAt: parsed.updatedAt,
              })
            : null,
        },
      });
    }
  }
  return { sessions, error: null };
}

// ============================================================================
// Unified records & messages reader for all multi-agent sources
// ============================================================================
export async function readMultiAgentRecords(sourceOrSession) {
  const sourcePath = typeof sourceOrSession === 'string' ? sourceOrSession : sourceOrSession?.sourcePath;
  if (!sourcePath) return [];
  // Cursor SQLite virtual path: <dbPath>#composer:<composerId>
  const cursorMatch = /^(.*state\.vscdb)#composer:(.+)$/.exec(sourcePath);
  if (cursorMatch) {
    const [, dbPath, composerId] = cursorMatch;
    const dbSig = await sqliteSig(dbPath);
    if (!dbSig) {
      cursorRawCache.delete(dbPath);
      return [];
    }
    try {
      let cached = getShortRaw(cursorRawCache, dbPath);
      if (!cached || cached.sig !== dbSig) {
        const rows = queryReadOnly(dbPath, (db) =>
          db
            .prepare("SELECT key, value FROM ItemTable WHERE key IN ('composer.composerData', 'aiService.prompts', 'aiService.generations')")
            .all()
        );
        const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
        const compData = JSON.parse(byKey['composer.composerData'] || '{}');
        const compById = new Map((compData.allComposers || []).filter(Boolean).map((c) => [c.composerId, c]));
        const prompts = JSON.parse(byKey['aiService.prompts'] || '[]');
        const generations = JSON.parse(byKey['aiService.generations'] || '[]');
        cached = { sig: dbSig, at: Date.now(), compById, prompts, generations };
        setBounded(cursorRawCache, dbPath, cached, MAX_RAW_CACHE);
      }
      const comp = cached.compById.get(composerId);
      const { prompts, generations } = cached;
      const out = [];
      if (comp?.name) {
        out.push({ role: 'user', text: comp.name, timestamp: toMs(comp.createdAt, 0) });
      }
      for (const p of prompts.slice(0, 20)) {
        if (p?.text && p.text !== comp?.name) out.push({ role: 'user', text: p.text });
      }
      if (comp?.subtitle) {
        out.push({
          role: 'assistant',
          text: `${comp.subtitle}${comp.filesChangedCount ? `\n（変更ファイル: ${comp.filesChangedCount} 件, +${comp.totalLinesAdded || 0} / -${comp.totalLinesRemoved || 0}）` : ''}`,
          timestamp: toMs(comp.lastUpdatedAt, 0),
        });
      } else if (generations.length) {
        for (const g of generations.slice(0, 10)) {
          if (g?.textDescription) out.push({ role: 'assistant', text: g.textDescription, timestamp: toMs(g.unixMs, 0) });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  // ChatGPT virtual path: <filePath>#chatgpt:<convId>
  const chatgptMatch = /^(.*)#chatgpt:(.+)$/.exec(sourcePath);
  if (chatgptMatch) {
    const [, filePath, convId] = chatgptMatch;
    const st = await stat(filePath);
    if (!st) {
      chatgptRawCache.delete(filePath);
      return [];
    }
    try {
      let cached = getShortRaw(chatgptRawCache, filePath);
      if (!cached || cached.ino !== st.ino || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
        const json = await readJson(filePath);
        const list = Array.isArray(json) ? json : Array.isArray(json?.conversations) ? json.conversations : [json];
        cached = { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, at: Date.now(), list };
        setBounded(chatgptRawCache, filePath, cached, MAX_RAW_CACHE);
      }
      const { list } = cached;
      const item = list.find((c) => String(c?.id || c?.conversation_id) === convId) || list[0];
      const parsed = parseChatGptConversationObject(item, convId, 0, null, { includeMessages: true });
      return parsed?.messages || [];
    } catch {
      return [];
    }
  }

  if (!exists(sourcePath)) return [];
  if (sourcePath.endsWith('.jsonl')) {
    const out = [];
    for await (const rec of readJsonLines(sourcePath)) {
      if (rec && typeof rec === 'object') out.push(rec);
    }
    return out;
  }
  try {
    const data = await readJson(sourcePath);
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      return data.messages || data.history || data.turns || data.items || [];
    }
  } catch {}
  return [];
}

export async function multiAgentSessionMessages(sourceOrSession, limit = 80) {
  const records = await readMultiAgentRecords(sourceOrSession);
  const out = [];
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    // Antigravity transcript.jsonl format
    if (r.type === 'USER_INPUT' || r.source === 'USER_EXPLICIT') {
      const text = extractAntigravityUserText(r.content);
      if (text) out.push({ role: 'user', text });
      continue;
    }
    if (r.type === 'PLANNER_RESPONSE') {
      if (typeof r.content === 'string' && r.content.trim()) {
        out.push({ role: 'assistant', text: r.content.trim() });
      }
      continue;
    }
    const role = String(r.role || r.author?.role || r.sender || r.type || '').toLowerCase();
    const text = extractMessageText(r.message || r).trim();
    if (!text) continue;
    if (role === 'user' || role === 'human') {
      out.push({ role: 'user', text: cleanPrompt(text) });
    } else if (role === 'assistant' || role === 'model' || role === 'agent' || role === 'bot' || role === 'gemini' || role === 'grok') {
      out.push({ role: 'assistant', text });
    }
  }
  return out.slice(-limit);
}

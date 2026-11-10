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
  queryReadOnly,
} from './readonly.mjs';
import { projectName, clip, cleanPrompt, firstLine, LOCAL_HOST, sessionKey } from './util.mjs';

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

function makeEntityObservation({ provider, scopeId, kind, nativeId, name, product, surface, cwd, hostId = 'local', updatedAt }) {
  if (!nativeId || !name) return null;
  const ts = Math.round(updatedAt || Date.now());
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
    roots: cwd ? [String(cwd)] : [],
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

// ============================================================================
// 1. Antigravity IDE / Brain reader (agent: 'antigravity')
// ============================================================================
export async function listAntigravitySessions(rawOpts = {}) {
  const opts = typeof rawOpts === 'string' ? { antigravityDir: rawOpts } : rawOpts || {};
  const host = opts.host || LOCAL_HOST;
  const roots = resolveSourceDir(opts.antigravityDir || opts.dir, 'CANBAN_ANTIGRAVITY_DIR', [
    path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
  ]);
  const sessions = [];
  for (const root of roots) {
    const brainDir = exists(path.join(root, 'brain')) ? path.join(root, 'brain') : root;
    if (!exists(brainDir)) continue;
    const convIds = await listSubdirs(brainDir);
    for (const convId of convIds) {
      if (convId.startsWith('.')) continue;
      const convPath = path.join(brainDir, convId);
      const logDir = path.join(convPath, '.system_generated', 'logs');
      const transcriptPath = exists(path.join(logDir, 'transcript.jsonl'))
        ? path.join(logDir, 'transcript.jsonl')
        : exists(path.join(logDir, 'transcript_full.jsonl'))
          ? path.join(logDir, 'transcript_full.jsonl')
          : exists(path.join(convPath, 'transcript.jsonl'))
            ? path.join(convPath, 'transcript.jsonl')
            : null;
      if (!transcriptPath) continue;
      const st = await stat(transcriptPath);
      if (!st) continue;

      let firstPrompt = '';
      let lastPrompt = '';
      let lastMessage = '';
      let cwd = null;
      let createdAt = st.birthtimeMs || st.mtimeMs;
      let updatedAt = st.mtimeMs;
      let turns = 0;
      let lastStep = null;
      let model = 'gemini';

      for await (const step of readJsonLines(transcriptPath)) {
        if (!step || typeof step !== 'object') continue;
        lastStep = step;
        const ts = toMs(step.created_at, 0);
        if (ts) {
          if (!turns && step.step_index === 0) createdAt = ts;
          if (ts > updatedAt) updatedAt = ts;
        }
        if (step.model && typeof step.model === 'string') model = step.model;
        if (step.type === 'USER_INPUT' || step.source === 'USER_EXPLICIT') {
          const detectedCwd = extractAntigravityCwd(step.content);
          if (detectedCwd) cwd = detectedCwd;
          const clean = extractAntigravityUserText(step.content);
          if (clean) {
            if (!firstPrompt) firstPrompt = clean;
            lastPrompt = clean;
            turns++;
          }
        } else if (step.type === 'PLANNER_RESPONSE' || step.source === 'MODEL') {
          if (typeof step.content === 'string' && step.content.trim()) {
            lastMessage = step.content.trim();
          }
        }
      }

      // Inspect artifacts (task.md, implementation_plan.md, walkthrough.md) in the conversation brain directory
      const dirEntries = await listDir(convPath);
      const artifacts = dirEntries
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => e.name);
      let planSteps = null;
      let taskHeading = '';
      if (artifacts.includes('task.md')) {
        try {
          const taskText = await readText(path.join(convPath, 'task.md'), 32 * 1024);
          planSteps = parseMarkdownChecklist(taskText);
          const hMatch = /^#\s+(.+)$/m.exec(taskText);
          if (hMatch) taskHeading = hMatch[1].trim();
        } catch {}
      }

      if (!firstPrompt && !lastMessage && !taskHeading) continue;
      const titleSource = taskHeading || firstLine(firstPrompt) || firstLine(lastMessage) || convId;
      const brainName = projectName(cwd) || clip(titleSource, 40) || convId.slice(0, 8);

      sessions.push({
        id: sessionKey('antigravity', host, convId),
        nativeId: convId,
        agent: 'antigravity',
        surface: 'ide',
        entrypoint: 'antigravity',
        host,
        title: clip(titleSource, 120),
        firstPrompt: clip(firstPrompt, 240) || null,
        lastPrompt: clip(lastPrompt, 240) || null,
        lastMessage: clip(firstLine(lastMessage), 200) || null,
        cwd: cwd || null,
        project: projectName(cwd) || 'Antigravity Brain',
        branch: null,
        model,
        reasoningEffort: null,
        createdAt: Math.round(createdAt),
        updatedAt: Math.round(updatedAt),
        archived: false,
        subagent: false,
        turns: Math.max(1, turns),
        sourcePath: transcriptPath,
        sourceMetadata: {
          antigravityBrain: makeEntityObservation({
            provider: 'antigravity',
            scopeId: brainDir,
            kind: 'brain',
            nativeId: convId,
            name: brainName,
            product: 'Antigravity',
            surface: 'ide',
            cwd,
            hostId: host.id || 'local',
            updatedAt,
          }),
          artifacts,
          planSteps,
          lastStepType: lastStep?.type || null,
          lastStepStatus: lastStep?.status || null,
          lastToolCalls: Array.isArray(lastStep?.tool_calls) ? lastStep.tool_calls : null,
        },
      });
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

async function parseGenericSessionFile(filePath, defaultMeta = {}) {
  const st = await stat(filePath);
  if (!st) return null;
  const records = [];
  let header = {};
  if (filePath.endsWith('.jsonl')) {
    for await (const rec of readJsonLines(filePath)) {
      if (!rec || typeof rec !== 'object') continue;
      if (rec.type === 'session_meta' || rec.type === 'meta' || (!rec.role && !rec.type && (rec.cwd || rec.title || rec.model))) {
        header = { ...header, ...rec };
      }
      records.push(rec);
    }
  } else {
    try {
      const data = await readJson(filePath);
      if (Array.isArray(data)) {
        records.push(...data);
      } else if (data && typeof data === 'object') {
        header = data;
        const list = data.messages || data.history || data.turns || data.items || [];
        if (Array.isArray(list)) records.push(...list);
      }
    } catch {
      return null;
    }
  }

  let firstPrompt = '';
  let lastPrompt = '';
  let lastMessage = '';
  let cwd = header.cwd || header.workingDirectory || defaultMeta.cwd || null;
  let branch = header.gitBranch || header.branch || null;
  let model = header.model || defaultMeta.model || null;
  let createdAt = toMs(header.createdAt || header.created_at || header.startTime, st.birthtimeMs || st.mtimeMs);
  let updatedAt = toMs(header.updatedAt || header.updated_at || header.lastUpdatedAt, st.mtimeMs);
  let turns = 0;

  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    if (r.cwd && typeof r.cwd === 'string') cwd = r.cwd;
    if (r.gitBranch && typeof r.gitBranch === 'string') branch = r.gitBranch;
    if (r.model && typeof r.model === 'string') model = r.model;
    const ts = toMs(r.timestamp || r.createdAt || r.created_at || r.time, 0);
    if (ts > updatedAt) updatedAt = ts;
    const role = String(r.role || r.author?.role || r.sender || r.type || '').toLowerCase();
    const text = extractMessageText(r.message || r);
    if (role === 'user' || role === 'human') {
      const clean = cleanPrompt(text);
      if (clean) {
        if (!firstPrompt) firstPrompt = clean;
        lastPrompt = clean;
        turns++;
      }
    } else if (role === 'assistant' || role === 'model' || role === 'agent' || role === 'bot' || role === 'gemini' || role === 'grok') {
      if (text.trim()) lastMessage = text.trim();
    }
  }

  const title = header.title || header.name || firstLine(firstPrompt) || firstLine(lastMessage);
  if (!title) return null;
  const nativeId = String(header.id || header.sessionId || header.conversationId || path.basename(filePath, path.extname(filePath)));
  return {
    nativeId,
    title: clip(title, 120),
    firstPrompt: clip(firstPrompt, 240) || null,
    lastPrompt: clip(lastPrompt, 240) || null,
    lastMessage: clip(firstLine(lastMessage), 200) || null,
    cwd,
    branch,
    model,
    createdAt: Math.round(createdAt),
    updatedAt: Math.round(updatedAt),
    turns: Math.max(1, turns),
    archived: Boolean(header.archived),
    records,
    header,
  };
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
    for (const { file, projectDir } of entries) {
      let defaultCwd = null;
      if (projectDir && exists(path.join(projectDir, '.project_root'))) {
        try {
          const rootText = (await readText(path.join(projectDir, '.project_root'), 1024)).trim();
          if (rootText.startsWith('/')) defaultCwd = rootText;
        } catch {}
      }
      const parsed = await parseGenericSessionFile(file, { cwd: defaultCwd, model: 'gemini-2.5-pro' });
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
function fileUriToPath(uri) {
  if (!uri || typeof uri !== 'string') return null;
  if (uri.startsWith('/')) return uri;
  if (!uri.startsWith('file://')) return null;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return uri.replace(/^file:\/\//, '');
  }
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
    for (const { file, surface, wsName } of transcriptFiles) {
      const parsed = await parseGenericSessionFile(file, { model: 'cursor-agent' });
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
      if (!exists(dbPath)) continue;
      const wsJsonPath = path.join(wsDir, 'workspace.json');
      let cwd = null;
      if (exists(wsJsonPath)) {
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
        continue;
      }
      const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      if (!byKey['composer.composerData']) continue;
      let composerData;
      try {
        composerData = JSON.parse(byKey['composer.composerData']);
      } catch {
        continue;
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
          turns: Math.max(1, prompts.length || 1),
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
function parseChatGptConversationObject(conv, fallbackId, fallbackTime, projectMeta = null) {
  if (!conv || typeof conv !== 'object') return null;
  const nativeId = String(conv.id || conv.conversation_id || fallbackId);
  let firstPrompt = '';
  let lastPrompt = '';
  let lastMessage = '';
  let model = conv.default_model_slug || conv.model || 'gpt-4o';
  let createdAt = toMs(conv.create_time || conv.createdAt || conv.created_at, fallbackTime);
  let updatedAt = toMs(conv.update_time || conv.updatedAt || conv.updated_at, createdAt);
  let turns = 0;
  const normalizedMessages = [];

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
      normalizedMessages.push({ role, text, timestamp: ts });
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
      normalizedMessages.push({ role, text, timestamp: ts });
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
    messages: normalizedMessages,
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
      // Only parse .data files if they start with JSON '{' or '[' (skip encrypted binary cache files)
      if (file.endsWith('.data')) {
        try {
          const head = (await readText(file, 16)).trimStart();
          if (!head.startsWith('{') && !head.startsWith('[')) continue;
        } catch {
          continue;
        }
      }
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
        const json = await readJson(file);
        const list = Array.isArray(json) ? json : Array.isArray(json?.conversations) ? json.conversations : [json];
        for (const item of list) {
          const fallbackId = path.basename(file, path.extname(file));
          const conv = parseChatGptConversationObject(item, fallbackId, st.mtimeMs, proj);
          if (!conv || seen.has(conv.nativeId)) continue;
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
    for (const file of files) {
      const parsed = await parseGenericSessionFile(file, { model: 'grok-3' });
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
    if (!exists(dbPath)) return [];
    try {
      const rows = queryReadOnly(dbPath, (db) =>
        db
          .prepare("SELECT key, value FROM ItemTable WHERE key IN ('composer.composerData', 'aiService.prompts', 'aiService.generations')")
          .all()
      );
      const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      const compData = JSON.parse(byKey['composer.composerData'] || '{}');
      const comp = (compData.allComposers || []).find((c) => c.composerId === composerId);
      const prompts = JSON.parse(byKey['aiService.prompts'] || '[]');
      const generations = JSON.parse(byKey['aiService.generations'] || '[]');
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
    if (!exists(filePath)) return [];
    try {
      const json = await readJson(filePath);
      const list = Array.isArray(json) ? json : Array.isArray(json?.conversations) ? json.conversations : [json];
      const item = list.find((c) => String(c?.id || c?.conversation_id) === convId) || list[0];
      const parsed = parseChatGptConversationObject(item, convId, 0);
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

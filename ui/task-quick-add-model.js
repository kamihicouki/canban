// Pure defaults shared by every task creation entry point. No viewport/hover inference.
function sessionCreationDefaults(board, context) {
  const prefs = board.settings?.launch || {};
  const agent = ['codex', 'claude'].includes(context.agent) ? context.agent : context.account?.split(':')[0] === 'claude' ? 'claude' : 'codex';
  return { agent, route: prefs.route || 'desktop', terminal: prefs.terminal || 'terminal', target: prefs.target || 'new-window',
    hostId: context.host || 'local', cwd: '', prompt: '', account: context.account?.startsWith(`${agent}:`) ? context.account : null };
}

// Desktop routes start at what the app lists: a Claude「環境」, or a Codex「プロジェクト」
// with「実行場所」. '__folder' falls back to a typed folder; '__none' is Codex's
// 「プロジェクトなしで作業」. Defaults follow the app: its most recent environment /
// selected project, and the cloud environment named like the project.
function applySessionTargetDefaults(draft, targets) {
  if (!targets) return draft;
  const envs = targets.claude?.environments || [], projects = targets.codex?.projects || [], clouds = targets.codex?.cloudEnvironments || [];
  if (!draft.environmentId || (draft.environmentId !== '__folder' && !envs.some(e => e.id === draft.environmentId))) draft.environmentId = draft.cwd ? '__folder' : envs[0]?.id || '__folder';
  if (!draft.projectId || (!['__none', '__folder'].includes(draft.projectId) && !projects.some(p => p.id === draft.projectId))) draft.projectId = draft.cwd ? '__folder' : projects[0]?.id || '__none';
  draft.runOn ||= 'local';
  if (draft.runOn === 'cloud' && !clouds.some(e => e.id === draft.cloudEnvironment)) {
    const name = projects.find(p => p.id === draft.projectId)?.name?.toLowerCase();
    draft.cloudEnvironment = clouds.find(e => e.name.toLowerCase() === name)?.id || (clouds.length === 1 ? clouds[0].id : null);
  }
  return draft;
}

const sessionRunsInCloud = draft => draft.route === 'desktop' && draft.agent === 'codex' && draft.runOn === 'cloud';

function sessionUsesFolder(draft) {
  if (draft.route !== 'desktop') return true;
  // No list chosen yet (or none loaded): the typed folder, as before.
  return draft.agent === 'claude' ? (draft.environmentId || '__folder') === '__folder' : (draft.projectId || '__folder') === '__folder' && !sessionRunsInCloud(draft);
}

// The machine a desktop start lands on (a remote Codex project / SSH environment, or the typed host).
function sessionHostId(draft, targets) {
  if (draft.route !== 'desktop' || sessionUsesFolder(draft)) return draft.hostId;
  if (draft.agent === 'claude') {
    const env = targets?.claude?.environments?.find(e => e.id === draft.environmentId);
    return env?.kind === 'ssh' ? env.sshHost : 'local';
  }
  return targets?.codex?.projects?.find(p => p.id === draft.projectId)?.hostId || 'local';
}

function sessionStartRequest(draft) {
  const request = { agent: draft.agent, route: draft.route, terminal: draft.terminal, target: draft.target,
    hostId: draft.hostId, cwd: draft.cwd.trim(), prompt: draft.prompt.trim(), account: draft.account };
  if (draft.allowDesktopSwitch) request.allowDesktopSwitch = true;
  if (draft.attachments?.imageIds?.length) request.imageIds = [...draft.attachments.imageIds];
  if (draft.attachments?.skills?.length) request.skills = draft.attachments.skills.map(s => ({ ...s }));
  if (sessionUsesFolder(draft)) return request;
  delete request.hostId; request.cwd = '';
  if (draft.agent === 'claude') request.environmentId = draft.environmentId;
  else if (draft.projectId !== '__none' && draft.projectId !== '__folder') request.projectId = draft.projectId;
  if (sessionRunsInCloud(draft)) Object.assign(request, { runOn: 'cloud', cloudEnvironment: draft.cloudEnvironment });
  return request;
}

async function saveQuickSessionDraft(draft, { callTool, refresh, newRequestId }) {
  if (draft.submitting || !draft.prompt.trim()) return null;
  draft.startRequest ||= { ...sessionStartRequest(draft), clientRequestId: newRequestId() };
  draft.submitting = true;
  try {
    const result = await callTool('canban_start_session', { ...draft.startRequest });
    draft.startResult = result;
    let refreshError = null;
    try { await refresh(); } catch (error) { refreshError = error.message; }
    return { result, refreshError };
  } finally { draft.submitting = false; }
}

function taskCreationDefaults(board, filters, { listId, lane, soloLane } = {}, edits = {}) {
  const context = {};
  for (const key of ['project', 'folder', 'section', 'agent', 'host', 'account']) {
    const value = filters[key];
    if (value && !(key === 'agent' && value === 'all')) context[key] = value === '__none' ? null : value;
  }
  const draft = { listId: listId || board.defaultListId, directory: filters.directory || null,
    labels: filters.label && filters.label !== '__none' ? [filters.label] : [], context };
  for (const source of [soloLane?.creation, lane?.creation]) {
    if (!source) continue;
    if (Object.hasOwn(source, 'directory')) draft.directory = source.directory;
    Object.assign(context, source.context);
    if (source.labels) draft.labels = source.labels.length ? [...new Set([...source.labels, ...draft.labels])] : [];
  }
  return { ...draft, ...edits, context: { ...context, ...edits.context } };
}

function taskLaneCreation(card, mode, labelId = null) {
  if (mode === 'directory') return { directory: card.directory?.id || '__none' };
  if (mode === 'label') return { labels: labelId ? [labelId] : [] };
  const value = {
    project: card.project || null, section: card.codexSection?.id || null,
    agent: card.agent || null, host: card.host?.id || 'local', account: card.account || null,
  };
  if (mode === 'account' && !value.account && card.host) return { context: { account: null, host: card.host.id } };
  return Object.hasOwn(value, mode) ? { context: { [mode]: value[mode] } } : {};
}

function taskCreationResultMatches(args, result) {
  const stable = value => JSON.stringify(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));
  return args.title === result.title && args.description === (result.description || '') && args.list === result.listId &&
    (args.directory || null) === (result.directoryId || null) &&
    JSON.stringify(args.labels) === JSON.stringify(result.labels || []) && stable(args.context) === stable(result.context);
}

// Saving and refreshing are separate outcomes: a failed refresh must not invite a second creation.
async function saveQuickTaskDraft(draft, { callTool, refresh, newRequestId }) {
  if (draft.submitting) return null;
  const title = draft.title.trim();
  if (!title) return null;
  draft.clientRequestId ||= newRequestId();
  const args = { title, description: draft.description, list: draft.listId, directory: draft.directory,
    labels: [...draft.labels], context: { ...draft.context }, clientRequestId: draft.clientRequestId };
  if (draft.slackSource) args.slackSource = draft.slackSource;
  draft.submitting = true;
  try {
    const result = await callTool('canban_create_task', args);
    const matches = taskCreationResultMatches(args, result);
    draft.clientRequestId = null;
    if (matches) draft.title = '';
    let refreshError = null;
    try { await refresh(); } catch (error) { refreshError = error.message; }
    return { result, matches, refreshError };
  } finally {
    draft.submitting = false;
  }
}

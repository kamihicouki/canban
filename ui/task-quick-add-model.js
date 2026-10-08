// Pure defaults shared by every task creation entry point. No viewport/hover inference.
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

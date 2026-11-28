// Part of board.html: included into its script by server/ui.mjs and shares its scope.
// Loading
let loadSeq = 0;
async function load({ refresh = false, throwOnError = false } = {}) {
  const seq = ++loadSeq;
  const f = state.filters;
  const args = { agent: f.agent, q: f.q, days: Number(f.days), includeArchived: f.includeArchived, includeSubagents: f.includeSubagents, dotScope: f.dotScope, pinnedOnly: !!f.pinnedOnly, groupBranch: !!f.groupBranch, fulltext: !!f.fulltext, refresh };
  if (f.sourceFilters?.length) args.sourceFilters = f.sourceFilters;
  if (f.project) args.project = f.project;
  if (f.folder) args.folder = f.folder;
  if (f.workingFolder) args.workingFolder = f.workingFolder;
  args.cardKind = f.cardKind || 'all';
  if (f.section) args.section = f.section;
  if (f.directory) args.directory = f.directory;
  if (f.repo) args.repo = f.repo;
  if (f.worktree) args.worktree = f.worktree;
  if (f.dirName) args.dirName = f.dirName;
  if (f.label) args.label = f.label;
  if (f.host) args.host = f.host;
  if (f.account) args.account = f.account;
  if (f.status) args.status = f.status;
  try {
    const board = await bridge.callTool('canban_get_board', args);
    if (seq !== loadSeq) return false;
    state.board = decodeSourceBoard(board);
    state.boardError = null;
    render();
    reconcileCards(board);
    for (const p of panes) paintCardListControls(p);
    refreshShortcutHints();
    refreshViews();
    return true;
  } catch (e) {
    if (seq !== loadSeq) return false;
    state.boardError = e.message;
    const message = `読み込みに失敗しました: ${e.message}`;
    if (state.board) {
      if (typeof paintSyncStatus === 'function') paintSyncStatus();
      toast(message, true);
    } else {
      if (typeof paintSyncStatus === 'function') paintSyncStatus();
      $('#board').replaceChildren(h('div', { class: 'loading', text: message }));
    }
    if (throwOnError) throw e;
    return false;
  }
}

async function refreshBoard() {
  if (await load({ refresh: true })) toast('最新の状態に更新しました');
}

function saveFilters() { store.set('filters', state.filters); }

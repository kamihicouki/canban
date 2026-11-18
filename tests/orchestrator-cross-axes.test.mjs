import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { makeFixtures } from './helpers.mjs';
import { listAntigravitySessions } from '../server/sources/multi-agents.mjs';
import { normalizeClaudeSummary } from '../server/sources/claude.mjs';
import { sessionSourceView } from '../server/source-model.mjs';
import { resolveCategory } from '../server/category-bindings.mjs';
import { matchesSourceFilters } from '../server/source-filters.mjs';
import { resolveRepoContext } from '../server/git.mjs';
import { taskCrossContext, matchesTask, normalizeFilters } from '../server/board.mjs';

function createAntigravityCsDb(dbPath, rows) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id text PRIMARY KEY,
      title text NOT NULL DEFAULT "",
      preview text NOT NULL DEFAULT "",
      step_count integer NOT NULL DEFAULT 0,
      last_modified_time datetime NOT NULL,
      workspace_uris text NOT NULL,
      status text NOT NULL DEFAULT "",
      project_id text NOT NULL DEFAULT "",
      agent_name text NOT NULL DEFAULT "",
      killed numeric NOT NULL DEFAULT 0,
      not_fully_idle numeric NOT NULL DEFAULT 0,
      last_user_input_time datetime NOT NULL
    );
  `);
  const stmt = db.prepare(`
    INSERT INTO conversation_summaries (
      conversation_id, title, preview, step_count, last_modified_time,
      workspace_uris, status, project_id, agent_name, killed, not_fully_idle, last_user_input_time
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
  `);
  for (const r of rows) {
    stmt.run(r.id, r.title, r.preview || '', 4, '2026-11-18 01:00:00+00:00', JSON.stringify(r.uris || []), r.status || 'CASCADE_RUN_STATUS_IDLE', r.projectId, '', '2026-11-18 00:55:00+00:00');
  }
  db.close();
}

test('Antigravityの複数ルート・outside-of-project absent・重複relation解消を検証する', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-agy-multi-'));
  try {
    const configProjects = path.join(tmpRoot, 'config', 'projects');
    const agyDir = path.join(tmpRoot, 'antigravity');
    const brainDir = path.join(agyDir, 'brain');
    fs.mkdirSync(configProjects, { recursive: true });
    fs.mkdirSync(brainDir, { recursive: true });

    fs.writeFileSync(path.join(configProjects, 'proj-1.json'), JSON.stringify({
      id: 'proj-1',
      name: 'canban',
      projectResources: {
        resources: [
          { gitFolder: { folderUri: 'file:///Users/test/repo/canban', defaultBranch: 'main' } },
          { folderUri: 'file:///Users/test/repo/canban-docs' },
        ],
      },
    }));
    fs.writeFileSync(path.join(configProjects, 'proj-2.json'), JSON.stringify({
      id: 'proj-2',
      name: 'pair-match',
      projectResources: {
        resources: [{ gitFolder: { folderUri: 'file:///Users/test/repo/pair-match', defaultBranch: 'main' } }],
      },
    }));

    createAntigravityCsDb(path.join(agyDir, 'conversation_summaries.db'), [
      { id: 'c-in', title: 'Project Session', projectId: 'proj-1', uris: ['file:///Users/test/.gemini/antigravity/worktrees/canban/feat-multi'] },
      { id: 'c-out', title: 'No Project Session', projectId: 'outside-of-project', uris: [] },
    ]);

    const { sessions } = await listAntigravitySessions(agyDir);
    const sIn = sessions.find(s => s.nativeId === 'c-in');
    const sOut = sessions.find(s => s.nativeId === 'c-out');

    assert.ok(sIn);
    assert.deepEqual(sIn.sourceMetadata.antigravityProject.roots, ['/Users/test/repo/canban', '/Users/test/repo/canban-docs']);
    assert.equal(sIn.repoName, 'canban');
    assert.equal(sIn.worktreeName, 'feat-multi');

    const svIn = sessionSourceView(sIn);
    assert.equal(svIn.attributes.antigravityBrain.status, 'known');
    assert.deepEqual(svIn.relations.map(r => r.ref.kind).sort(), ['brain', 'project']);

    // 保存済み antigravity:brain 参照の category binding と sourceFilters が後方互換で一致する
    const brainRel = svIn.relations.find(r => r.ref.kind === 'brain');
    assert.equal(matchesSourceFilters(svIn.relations, [{ ref: brainRel.ref }]), true);
    const cat = resolveCategory({
      card: sIn,
      sourceView: svIn,
      bindings: [{ categoryId: 'cat-brain', ref: brainRel.ref, relation: 'memberOf' }],
    });
    assert.equal(cat.categoryId, 'cat-brain');

    // UI のカードピルは antigravityProject のみを表示し、「元アプリ 複数（2）」にならない
    const facetsUi = vm.runInNewContext(
      `${fs.readFileSync(new URL('../ui/source-facets.js', import.meta.url), 'utf8')}\n({ visibleCardSourceRelations })`,
      { state: { filters: { sourceFilters: [] } } },
    );
    const visibleRels = facetsUi.visibleCardSourceRelations({ ...sIn, sourceView: svIn });
    assert.equal(visibleRels.length, 1);
    assert.equal(visibleRels[0].ref.kind, 'project');

    assert.ok(sOut);
    assert.equal(sOut.sourceMetadata.antigravityProject.status, 'absent');
    const svOut = sessionSourceView(sOut);
    assert.equal(svOut.relations.some(r => r.ref.kind === 'project'), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('sourceFacetLabel は競合回避のため "概念名 (Agent)" の形式で表記する', () => {
  const code = fs.readFileSync(new URL('../ui/source-facets.js', import.meta.url), 'utf8');
  const ui = vm.runInNewContext(`${code}\n({ sourceFacetLabel, cardLocationText })`);
  const makeRef = (provider, kind) => ({ provider, identityDomain: 'local', scopeId: 's', kind, nativeId: 'id1' });

  assert.equal(ui.sourceFacetLabel({ ref: makeRef('codex', 'project'), name: 'canban' }), 'プロジェクト (Codex): canban');
  assert.equal(ui.sourceFacetLabel({ ref: makeRef('antigravity', 'project'), name: 'canban' }), 'プロジェクト (Antigravity): canban');
  assert.equal(ui.sourceFacetLabel({ ref: makeRef('claude', 'environment'), name: 'prod' }), '環境 (Claude): prod');
  assert.equal(ui.sourceFacetLabel({ ref: makeRef('claude', 'group'), name: 'UI' }), 'グループ (Claude): UI');
  assert.equal(ui.sourceFacetLabel({ ref: makeRef('codex', 'section'), name: 'Doing' }), 'セクション (Codex): Doing');
  assert.equal(ui.sourceFacetLabel({ ref: makeRef('gemini', 'project'), name: 'cli' }), 'プロジェクト (Gemini): cli');
  assert.equal(ui.sourceFacetLabel({ ref: makeRef('cursor', 'workspace'), name: 'ws' }), 'ワークスペース (Cursor): ws');
  assert.equal(ui.sourceFacetLabel({ ref: makeRef('chatgpt', 'project'), name: 'chat' }), 'プロジェクト (ChatGPT): chat');
  assert.equal(ui.sourceFacetLabel({ ref: makeRef('grok', 'workspace'), name: 'wk' }), 'ワークスペース (Grok): wk');
  assert.equal(ui.cardLocationText({ repoName: 'canban', worktreeName: 'feat-x' }), 'canban · ⎇ feat-x');
});

test('Claude gitAnchors復元・横断フィルタ(repo/worktree/dirName/cloud)・ボード集計・タスク絞り込みを検証する', () => {
  const fx = makeFixtures();
  try {
    // Claude Desktop メタデータ（既存 fixture の a/b/local_2.json）に削除済み一時ワークツリーと gitAnchors を仕込む
    const desktopOrgDir = path.join(fx.desktopDir, 'a', 'b');
    const claudeFile = path.join(fx.claudeHome, 'projects', '-r-web', 'c2.jsonl');
    const deletedWt = '/private/tmp/deleted-field-finder-wt';
    fs.writeFileSync(claudeFile, fs.readFileSync(claudeFile, 'utf8').replace('/r/web', deletedWt));
    fs.writeFileSync(path.join(desktopOrgDir, 'local_2.json'), JSON.stringify({
      sessionId: 'local_abc-123',
      cliSessionId: 'c2',
      title: 'README 修正',
      isArchived: false,
      cwd: deletedWt,
      lastActivityAt: Date.now(),
      gitAnchors: [
        { gitRoot: deletedWt, commonDir: '/Users/test/repo/field-finder/.git' },
        { gitRoot: '/Users/test/repo/field-finder', commonDir: '/Users/test/repo/field-finder/.git' },
      ],
    }));

    // Codex のクラウドセッション（dot cache）も追加
    fs.writeFileSync(path.join(fx.codexHome, '.codex-global-state.json'), JSON.stringify({
      'electron-persisted-atom-state': {
        'cloud-aeon-sidebar-cache-v1': {
          hostId: 'cloud-host-1',
          refreshStartedAtMs: Date.now(),
          threads: [{ id: 'cloud-1', name: 'Cloud Job', preview: 'run', createdAt: 1791499900, updatedAt: 1791500000, threadSource: 'aeon_child' }],
          profilesByThreadId: { 'cloud-1': { id: 'dot-1', aeon_kind: 'orbit', active_root_thread_id: 'root', display_name: 'Orbit' } },
          attachments: [{ thread_id: 'cloud-1', is_user_visible: true, parent_thread_id: 'root' }],
        },
      },
    }));

    // Antigravity も追加（field-finder の別 worktree）
    const agyDir = path.join(fx.root, 'agy');
    const agyConfigProjects = path.join(fx.root, 'config', 'projects');
    fs.mkdirSync(path.join(agyDir, 'brain'), { recursive: true });
    fs.mkdirSync(agyConfigProjects, { recursive: true });
    fs.writeFileSync(path.join(agyConfigProjects, 'ff.json'), JSON.stringify({
      id: 'ff',
      name: 'field-finder',
      projectResources: { resources: [{ gitFolder: { folderUri: 'file:///Users/test/repo/field-finder' } }] },
    }));
    createAntigravityCsDb(path.join(agyDir, 'conversation_summaries.db'), [
      { id: 'agy-ff', title: 'AGY Field Finder', projectId: 'ff', uris: ['file:///Users/test/.gemini/antigravity/worktrees/field-finder/agy-wt'] },
    ]);

    const res = JSON.parse(execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
      import { Store } from './server/store.mjs';
      import { buildBoard } from './server/board.mjs';
      const store = new Store(process.env.CANBAN_DATA_DIR);
      const task = await store.createTask({ title: 'Field Finder Task' });
      await store.linkSession({ taskId: task.cardId, sessionId: 'claude:c2' });
      const all = await buildBoard(store, { days: 0, includeArchived: true, dotScope: 'all' });
      const byRepo = await buildBoard(store, { days: 0, includeArchived: true, repo: 'field-finder' });
      const byWt = await buildBoard(store, { days: 0, includeArchived: true, worktree: 'field-finder/agy-wt' });
      const byDir = await buildBoard(store, { days: 0, includeArchived: true, dirName: 'deleted-field-finder-wt' });
      const byCloud = await buildBoard(store, { days: 0, includeArchived: true, dotScope: 'all', host: 'cloud' });
      console.log(JSON.stringify({ all, byRepo, byWt, byDir, byCloud, taskId: task.cardId }));
      await store.close();
      process.exit(0);
    `], {
      cwd: path.resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        CANBAN_DATA_DIR: path.join(fx.root, 'store'),
        CANBAN_CODEX_HOME: fx.codexHome,
        CANBAN_CLAUDE_HOME: fx.claudeHome,
        CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir,
        CANBAN_ANTIGRAVITY_DIR: agyDir,
        CANBAN_GEMINI_HOME: path.join(fx.root, 'gemini'),
        CANBAN_CURSOR_HOME: path.join(fx.root, 'cursor'),
        CANBAN_CURSOR_WORKSPACE_DIR: path.join(fx.root, 'cursor-workspaces'),
        CANBAN_CHATGPT_DIR: path.join(fx.root, 'chatgpt'),
        CANBAN_GROK_HOME: path.join(fx.root, 'grok'),
        CANBAN_BACKGROUND: '0',
        CANBAN_SEARCH_INDEX: '0',
        CANBAN_GH: path.resolve(import.meta.dirname, 'fake-gh.sh'),
        CANBAN_GLAB: path.resolve(import.meta.dirname, 'fake-glab.sh'),
        FAKE_GH_DATA: '/dev/null',
      },
    }));

    const cardsOf = (b) => b.lists.flatMap(l => l.cards);

    // 集計の確認
    assert.ok(res.all.repos.some(r => r.name === 'field-finder' && r.count >= 2));
    assert.ok(res.all.worktrees.some(w => w.key === 'field-finder/deleted-field-finder-wt'));
    assert.ok(res.all.worktrees.some(w => w.key === 'field-finder/agy-wt'));
    assert.ok(res.all.dirNames.some(d => d.name === 'deleted-field-finder-wt'));
    assert.equal(res.all.cloudCount, 1);

    // repo 絞り込み（タスクカード + Antigravity セッションが横断取得される）
    const repoIds = cardsOf(res.byRepo).map(c => c.id).sort();
    assert.deepEqual(repoIds, ['antigravity:agy-ff', res.taskId].sort());

    // worktree 絞り込み
    assert.deepEqual(cardsOf(res.byWt).map(c => c.id), ['antigravity:agy-ff']);

    // dirName 絞り込み（Claude セッションをリンクしたタスクカードが一致）
    assert.deepEqual(cardsOf(res.byDir).map(c => c.id), [res.taskId]);

    // cloud 環境絞り込み
    assert.deepEqual(cardsOf(res.byCloud).map(c => c.id), ['codex:cloud-1']);
  } finally {
    fx.cleanup();
  }
});

test('Antigravity 登録プロジェクトが1件のみのときでも explicit outside-of-project は absent になる', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-agy-single-'));
  try {
    const configProjects = path.join(tmpRoot, 'config', 'projects');
    const agyDir = path.join(tmpRoot, 'antigravity');
    const brainDir = path.join(agyDir, 'brain');
    fs.mkdirSync(configProjects, { recursive: true });
    fs.mkdirSync(brainDir, { recursive: true });

    fs.writeFileSync(path.join(configProjects, 'only-proj.json'), JSON.stringify({
      id: 'only-proj',
      name: 'OnlyProj',
      projectResources: {
        resources: [{ gitFolder: { folderUri: 'file:///Users/test/repo/only-proj', defaultBranch: 'main' } }],
      },
    }));

    createAntigravityCsDb(path.join(agyDir, 'conversation_summaries.db'), [
      { id: 'c-explicit-out', title: 'Explicit Outside', projectId: 'outside-of-project', uris: [] },
    ]);

    const { sessions } = await listAntigravitySessions(agyDir);
    const sOut = sessions.find(s => s.nativeId === 'c-explicit-out');
    assert.ok(sOut);
    assert.equal(sOut.sourceMetadata.antigravityProject.status, 'absent');
    assert.equal(sessionSourceView(sOut).relations.some(r => r.ref.kind === 'project'), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Claude gitAnchors は cwd に対応するアンカーのみを採用し通常サブディレクトリを worktree と誤認しない', () => {
  const dm = {
    gitAnchors: [
      { gitRoot: '/repo/alpha', commonDir: '/repo/alpha/.git' },
      { gitRoot: '/repo/alpha/worktrees/feat-wt', commonDir: '/repo/alpha/.git' },
    ],
  };

  // 無関係な /repo/beta はアンカーに一致しない
  const unrelated = normalizeClaudeSummary({ sessionId: 'c-beta', prompts: ['beta work'], turns: 1, cwd: '/repo/beta' }, dm);
  assert.equal(unrelated.anchorRepoRoot, undefined);
  assert.equal(unrelated.anchorRepoName, undefined);
  assert.equal(unrelated.anchorWorktreeName, undefined);

  // 通常リポジトリのサブディレクトリ /repo/alpha/src は worktree ではなく repo alpha のみ紐付く
  const subDir = normalizeClaudeSummary({ sessionId: 'c-src', prompts: ['src work'], turns: 1, cwd: '/repo/alpha/src' }, dm);
  assert.equal(subDir.anchorRepoRoot, '/repo/alpha');
  assert.equal(subDir.anchorRepoName, 'alpha');
  assert.equal(subDir.anchorWorktreeName, null);

  // worktree パス配下は最長一致で worktree 名を復元する
  const inWt = normalizeClaudeSummary({ sessionId: 'c-wt', prompts: ['wt work'], turns: 1, cwd: '/repo/alpha/worktrees/feat-wt/packages/app' }, dm);
  assert.equal(inWt.anchorRepoRoot, '/repo/alpha');
  assert.equal(inWt.anchorRepoName, 'alpha');
  assert.equal(inWt.anchorWorktreeName, 'feat-wt');
});

test('taskCrossContext は別リポジトリ同名 worktree を合成せず、matches / matchesTask はクラウドとローカルを重複させない', () => {
  // 別リポジトリ同名 worktree の合成防止
  const linksDiffRepoSameWt = [
    { repoName: 'alpha', repoRoot: '/repo/alpha', worktreeName: 'shared', cwd: '/repo/alpha/.wt/shared', host: { id: 'local', local: true } },
    { repoName: 'beta', repoRoot: '/repo/beta', worktreeName: 'shared', cwd: '/repo/beta/.wt/shared', host: { id: 'local', local: true } },
  ];
  const cross = taskCrossContext({}, linksDiffRepoSameWt);
  assert.equal(cross.repoName, null);
  assert.equal(cross.worktreeName, null);

  // target 未設定のタスクに cloud セッションのみをリンクした場合
  const cloudLink = [{ id: 'codex:c-cloud', agent: 'codex', surface: 'cloud', host: { id: 'local', local: true } }];
  const cloudTaskCross = taskCrossContext({}, cloudLink);
  assert.equal(cloudTaskCross.environmentKey, 'cloud');
  assert.equal(matchesTask({}, cloudLink, 'idle', normalizeFilters({ host: 'cloud' }), new Map(), null), true);
  assert.equal(matchesTask({}, cloudLink, 'idle', normalizeFilters({ host: 'local' }), new Map(), null), false);

  // セッション側の buildBoard / matches 検証（surface: 'cloud' かつ local host）
  const fx = makeFixtures();
  try {
    const res = JSON.parse(execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
      import { Store } from './server/store.mjs';
      import { buildBoard, onSessions } from './server/board.mjs';
      onSessions(sessions => {
        for (const s of sessions) {
          if (s.id === 'claude:c2') { s.surface = 'cloud'; s.host = { id: 'local', local: true }; }
        }
      });
      const store = new Store(process.env.CANBAN_DATA_DIR);
      const localBoard = await buildBoard(store, { days: 0, includeArchived: true, dotScope: 'all', host: 'local' });
      const cloudBoard = await buildBoard(store, { days: 0, includeArchived: true, dotScope: 'all', host: 'cloud' });
      console.log(JSON.stringify({
        localIds: localBoard.lists.flatMap(l => l.cards).map(c => c.id),
        cloudIds: cloudBoard.lists.flatMap(l => l.cards).map(c => c.id),
      }));
      await store.close();
      process.exit(0);
    `], {
      cwd: path.resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        CANBAN_DATA_DIR: path.join(fx.root, 'store-cloud-sep'),
        CANBAN_CODEX_HOME: fx.codexHome,
        CANBAN_CLAUDE_HOME: fx.claudeHome,
        CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir,
        CANBAN_ANTIGRAVITY_DIR: path.join(fx.root, 'agy-empty'),
        CANBAN_GEMINI_HOME: path.join(fx.root, 'gemini-empty'),
        CANBAN_CURSOR_HOME: path.join(fx.root, 'cursor-empty'),
        CANBAN_CURSOR_WORKSPACE_DIR: path.join(fx.root, 'cursor-ws-empty'),
        CANBAN_CHATGPT_DIR: path.join(fx.root, 'chatgpt-empty'),
        CANBAN_GROK_HOME: path.join(fx.root, 'grok-empty'),
        CANBAN_BACKGROUND: '0',
        CANBAN_SEARCH_INDEX: '0',
        CANBAN_GH: path.resolve(import.meta.dirname, 'fake-gh.sh'),
        CANBAN_GLAB: path.resolve(import.meta.dirname, 'fake-glab.sh'),
        FAKE_GH_DATA: '/dev/null',
      },
    }));
    assert.ok(res.cloudIds.includes('claude:c2'));
    assert.ok(!res.localIds.includes('claude:c2'));
  } finally {
    fx.cleanup();
  }
});

test('commandPalette は現在のレーン軸の絞り込み項目を除外し、スイムレーン切替で setLaneAxis を通す', async () => {
  const facetsCode = fs.readFileSync(new URL('../ui/source-facets.js', import.meta.url), 'utf8');
  const lanesCode = fs.readFileSync(new URL('../ui/lanes.js', import.meta.url), 'utf8');
  const sidebarCode = fs.readFileSync(new URL('../ui/sidebar.js', import.meta.url), 'utf8');
  const keyboardCode = fs.readFileSync(new URL('../ui/keyboard.js', import.meta.url), 'utf8');
  let capturedPicker = null;
  let loadCount = 0;
  const board = {
    directories: [{ id: 'd1', name: 'cat1', count: 1, color: 'blue' }],
    repos: [{ name: 'canban', count: 2 }],
    worktrees: [{ key: 'canban/wt1', name: 'canban / wt1', count: 1 }],
    dirNames: [{ name: 'canban', count: 1 }, { name: 'wt1', count: 1 }],
    labels: [{ id: 'l1', name: 'bug', color: 'red' }],
    sourceFacets: [],
    hosts: [],
    settings: { views: [] },
    lists: [],
  };
  const ctx = vm.createContext({
    T: { category: 'カテゴリ', taskCard: 'タスクカード', aiApps: 'AI Apps', automation: '自動化' },
    STATUS_LABELS: { idle: '待機中' },
    AGENT_META: {},
    PERIODS: [],
    LIFE_LABELS: {},
    LAYOUTS: [],
    LANE_HEIGHTS: { normal: ['標準', '420px'] },
    COLORS: ['blue'],
    COLOR_NAMES: { blue: '青' },
    PANE_MODES: [],
    DRAWER_PAGES: [],
    WORKSPACE_PAGES: [],
    store: { get: (_k, d) => d, set() {} },
    DEFAULT_FILTERS: { sourceFilters: [], cardKind: 'all', workingFolder: '', folder: '', section: '', agent: 'all', host: '', account: '', status: '', project: '', directory: '', repo: '', worktree: '', dirName: '', label: '', q: '', days: 30, includeArchived: false, includeSubagents: false, dotScope: 'exclude', groupBranch: false, fulltext: false, swimlane: '', laneHeight: 'normal' },
    state: {
      board,
      lanes: [],
      filters: { sourceFilters: [], cardKind: 'all', workingFolder: '', folder: '', section: '', agent: 'all', host: '', account: '', status: '', project: '', directory: '', repo: 'canban', worktree: '', dirName: '', label: '', q: '', days: 30, includeArchived: false, includeSubagents: false, dotScope: 'exclude', groupBranch: false, fulltext: false, swimlane: '', laneHeight: 'normal' },
      soloLane: null,
      auxiliaryMode: 'minimal',
      sideOpen: true,
    },
    workspace: { utilityPage: () => false, navigate() {}, current: () => 'home' },
    desktopAccounts: { view: { pendingLaunches: [] }, resumes: new Map(), refresh: async () => null },
    taskQuickAdd: { open() {}, targets: null, sessionDraft: null },
    slackUi: { visible: false, selected: null },
    paneLayer: { hidden: true },
    panes: [],
    exchangeTrail: null,
    navigator: { platform: 'MacIntel' },
    document: { addEventListener() {}, querySelector: () => null },
    $: () => ({ value: '', addEventListener() {} }),
    $$: () => [],
    h: () => ({}),
    picker: (_anchor, opts) => { capturedPicker = opts; return { classList: { add() {} }, refreshItems() {} }; },
    capturePaletteOrigin: () => null,
    selectedExchangeCard: () => null,
    focusedPane: () => null,
    selectedWorkSessionId: () => null,
    selectedRelatedCardId: () => null,
    auxiliaryCommands: () => [],
    inboxOn: () => false,
    openViewKind: () => null,
    panePromptInput: () => null,
    desktopPickerElement: () => null,
    accountName: x => x,
    paletteBoardCards: () => [],
    createPaletteSearchView: () => ({ items: () => [], attach() {} }),
    saveFilters() {},
    render() {},
    load() { loadCount++; },
    setBoardView() {},
    setLayout() {},
    setThemePref() {},
    toggleAuxiliaryUi() {},
    toggleView() {},
    toggleAnalytics() {},
    toggleSidebar() {},
    focusTaskLoop() {},
    refreshBoard() {},
    perfPanel() {},
    act: async () => {},
    refreshShortcutHints() {},
    workBundleUndoAvailable: () => false,
    keycap: () => [],
    workingFolderFacets: () => [],
    directoryItems: () => [],
    picon: () => '',
  });
  vm.runInContext([facetsCode, lanesCode, sidebarCode, keyboardCode].join('\n'), ctx);

  await vm.runInContext('commandPalette()', ctx);
  const switchRepo = capturedPicker.items().find(it => it.label === 'スイムレーン: リポジトリ');
  assert.ok(switchRepo);
  capturedPicker.onPick(switchRepo.value, switchRepo);
  assert.equal(ctx.state.filters.swimlane, 'repo');
  assert.equal(ctx.state.filters.repo, '');
  assert.equal(loadCount, 1);

  await vm.runInContext('commandPalette()', ctx);
  const itemsOnRepoLane = capturedPicker.items();
  assert.equal(itemsOnRepoLane.some(it => it.group === 'リポジトリ'), false);
  assert.equal(itemsOnRepoLane.some(it => it.group === 'ワークツリー'), true);
  assert.equal(itemsOnRepoLane.some(it => it.group === 'ディレクトリ名'), true);

  vm.runInContext('setLaneAxis("worktree")', ctx);
  await vm.runInContext('commandPalette()', ctx);
  const itemsOnWtLane = capturedPicker.items();
  assert.equal(itemsOnWtLane.some(it => it.group === 'ワークツリー'), false);
  assert.equal(itemsOnWtLane.some(it => it.group === 'リポジトリ'), true);
});

test('タスクの dirName 表示・絞り込み一致、未リンクタスク集計、削除済み .claude/worktrees 復元、作成時フィルタ引き継ぎを検証する', async () => {
  // 1. target.cwd とリンク先 cwd が異なるタスクの表示/絞り込み一致
  const mixedTask = { target: { cwd: '/repo/new' } };
  const mixedLinks = [{ cwd: '/repo/old', dirName: 'old', host: { id: 'local', local: true } }];
  assert.equal(taskCrossContext(mixedTask, mixedLinks).dirName, 'new');
  assert.equal(matchesTask(mixedTask, mixedLinks, 'idle', normalizeFilters({ dirName: 'new' }), new Map(), null), true);
  assert.equal(matchesTask(mixedTask, mixedLinks, 'idle', normalizeFilters({ dirName: 'old' }), new Map(), null), true);
  assert.equal(matchesTask(mixedTask, mixedLinks, 'idle', normalizeFilters({ dirName: '__none' }), new Map(), null), false);

  // 2. 実在リポ配下の削除済み .claude/worktrees/<name>/src の復元
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-cl-delwt-'));
  try {
    fs.mkdirSync(path.join(tmpRepo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const deletedSub = path.join(tmpRepo, '.claude', 'worktrees', 'deleted-wt', 'src');
    const res = await resolveRepoContext(deletedSub);
    assert.equal(res.isGit, true);
    assert.equal(res.isWorktree, true);
    assert.equal(res.repoName, path.basename(tmpRepo));
    assert.equal(res.worktreeName, 'deleted-wt');
    assert.equal(res.branch, null);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }

  // 3. 未リンクタスク target.cwd の worktree/repo 復元、および context.project 併用/明示 repo:null の整合
  const targetTask = { target: { cwd: '/tmp/canban/.claude/worktrees/feat/src' } };
  const targetCross = taskCrossContext(targetTask, []);
  assert.equal(targetCross.repoName, 'canban');
  assert.equal(targetCross.worktreeName, 'feat');
  assert.equal(targetCross.dirName, 'src');
  assert.equal(matchesTask(targetTask, [], 'idle', normalizeFilters({ repo: 'canban' }), new Map(), null), true);
  assert.equal(matchesTask(targetTask, [], 'idle', normalizeFilters({ worktree: 'canban/feat' }), new Map(), null), true);
  assert.equal(matchesTask(targetTask, [], 'idle', normalizeFilters({ dirName: 'src' }), new Map(), null), true);

  const mixedProjTargetTask = { context: { project: 'Named App Project' }, target: { cwd: '/tmp/canban/.claude/worktrees/feat/src' } };
  const mixedProjCross = taskCrossContext(mixedProjTargetTask, []);
  assert.equal(mixedProjCross.repoName, 'canban');
  assert.equal(mixedProjCross.worktreeName, 'feat');
  assert.equal(matchesTask(mixedProjTargetTask, [], 'idle', normalizeFilters({ repo: 'canban' }), new Map(), null), true);
  assert.equal(matchesTask(mixedProjTargetTask, [], 'idle', normalizeFilters({ worktree: 'canban/feat' }), new Map(), null), true);
  assert.equal(matchesTask(mixedProjTargetTask, [], 'idle', normalizeFilters({ project: 'Named App Project' }), new Map(), null), true);

  const explicitNoRepoTask = { context: { project: 'Named App Project', repo: null } };
  assert.equal(matchesTask(explicitNoRepoTask, [], 'idle', normalizeFilters({ repo: '__none' }), new Map(), null), true);
  assert.equal(matchesTask(explicitNoRepoTask, [], 'idle', normalizeFilters({ repo: 'Named App Project' }), new Map(), null), false);

  // 4 & 5. 未リンクタスクの repos/dirNames/worktrees 集計、および repo/dirName と旧 project/folder 併用時の作成引き継ぎ
  const model = new vm.Script(`${fs.readFileSync(new URL('../ui/task-quick-add-model.js', import.meta.url), 'utf8')}\n({ taskCreationDefaults })`).runInNewContext();
  const createdDefaults = JSON.parse(JSON.stringify(model.taskCreationDefaults({ defaultListId: 'inbox' }, { repo: 'my-repo', dirName: 'my-dir' })));
  assert.deepEqual(createdDefaults.context, { repo: 'my-repo', dirName: 'my-dir' });
  const mixedDefaults = JSON.parse(JSON.stringify(model.taskCreationDefaults(
    { defaultListId: 'inbox' },
    { repo: 'actual-repo', project: 'Named App Project', dirName: 'sub-dir', folder: 'legacy-folder' },
  )));
  assert.deepEqual(mixedDefaults.context, {
    project: 'Named App Project',
    folder: 'legacy-folder',
    repo: 'actual-repo',
    dirName: 'sub-dir',
  });

  const fx = makeFixtures();
  try {
    const out = JSON.parse(execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
      import { Store } from './server/store.mjs';
      import { buildBoard } from './server/board.mjs';
      const store = new Store(process.env.CANBAN_DATA_DIR);
      const solo = await store.createTask({ title: 'Solo Task', context: { project: 'solo-repo', folder: 'solo-dir' } });
      const created = await store.createTask({ title: 'Filtered Created', context: ${JSON.stringify(createdDefaults.context)} });
      const mixedCreated = await store.createTask({ title: 'Mixed Created', context: ${JSON.stringify(mixedDefaults.context)} });
      const targetOnly = await store.createTask({ title: 'Target Worktree Task' });
      await store.updateTask({ cardId: targetOnly.cardId, target: { agent: 'claude', host: 'local', cwd: '/tmp/wt-repo-base/.claude/worktrees/feat-target/src' } });
      const all = await buildBoard(store, { days: 0, includeArchived: true, dotScope: 'all' });
      const bySoloRepo = await buildBoard(store, { days: 0, includeArchived: true, repo: 'solo-repo' });
      const bySoloDir = await buildBoard(store, { days: 0, includeArchived: true, dirName: 'solo-dir' });
      const byCreated = await buildBoard(store, { days: 0, includeArchived: true, repo: 'my-repo', dirName: 'my-dir' });
      const byMixed = await buildBoard(store, {
        days: 0, includeArchived: true,
        repo: 'actual-repo', project: 'Named App Project', dirName: 'sub-dir', folder: 'legacy-folder',
      });
      const byTargetWt = await buildBoard(store, { days: 0, includeArchived: true, worktree: 'wt-repo-base/feat-target' });
      console.log(JSON.stringify({
        soloId: solo.cardId,
        createdId: created.cardId,
        mixedCreatedId: mixedCreated.cardId,
        targetOnlyId: targetOnly.cardId,
        repos: all.repos,
        worktrees: all.worktrees,
        dirNames: all.dirNames,
        soloRepoIds: bySoloRepo.lists.flatMap(l => l.cards).map(c => c.id),
        soloDirIds: bySoloDir.lists.flatMap(l => l.cards).map(c => c.id),
        createdIds: byCreated.lists.flatMap(l => l.cards).map(c => c.id),
        mixedIds: byMixed.lists.flatMap(l => l.cards).map(c => c.id),
        targetWtIds: byTargetWt.lists.flatMap(l => l.cards).map(c => c.id),
      }));
      await store.close();
      process.exit(0);
    `], {
      cwd: path.resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        CANBAN_DATA_DIR: path.join(fx.root, 'store-unlinked-task'),
        CANBAN_CODEX_HOME: fx.codexHome,
        CANBAN_CLAUDE_HOME: fx.claudeHome,
        CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir,
        CANBAN_ANTIGRAVITY_DIR: path.join(fx.root, 'agy-empty'),
        CANBAN_GEMINI_HOME: path.join(fx.root, 'gemini-empty'),
        CANBAN_CURSOR_HOME: path.join(fx.root, 'cursor-empty'),
        CANBAN_CURSOR_WORKSPACE_DIR: path.join(fx.root, 'cursor-ws-empty'),
        CANBAN_CHATGPT_DIR: path.join(fx.root, 'chatgpt-empty'),
        CANBAN_GROK_HOME: path.join(fx.root, 'grok-empty'),
        CANBAN_BACKGROUND: '0',
        CANBAN_SEARCH_INDEX: '0',
        CANBAN_GH: path.resolve(import.meta.dirname, 'fake-gh.sh'),
        CANBAN_GLAB: path.resolve(import.meta.dirname, 'fake-glab.sh'),
        FAKE_GH_DATA: '/dev/null',
      },
    }));

    assert.ok(out.repos.some(r => r.name === 'solo-repo' && r.count === 1));
    assert.ok(out.dirNames.some(d => d.name === 'solo-dir' && d.count === 1));
    assert.ok(out.repos.some(r => r.name === 'wt-repo-base' && r.count === 1));
    assert.ok(out.worktrees.some(w => w.key === 'wt-repo-base/feat-target' && w.count === 1));
    assert.ok(out.dirNames.some(d => d.name === 'src' && d.count === 1));
    assert.deepEqual(out.soloRepoIds, [out.soloId]);
    assert.deepEqual(out.soloDirIds, [out.soloId]);
    assert.deepEqual(out.createdIds, [out.createdId]);
    assert.deepEqual(out.mixedIds, [out.mixedCreatedId]);
    assert.deepEqual(out.targetWtIds, [out.targetOnlyId]);
  } finally {
    fx.cleanup();
  }
});

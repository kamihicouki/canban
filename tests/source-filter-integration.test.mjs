// Real UI selection / saved-view application -> stdio RPC -> server board filtering.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { makeFixtures } from './helpers.mjs';
import { sessionSourceView, compactSourceView, storageScope } from '../server/source-model.mjs';
import { matchesWorkingFolder, normalizeWorkingFolder } from '../server/source-filters.mjs';
import { normalizeFilters, matchesTask } from '../server/board.mjs';
import { rollbackSourceViews } from '../server/category-bindings.mjs';

const root = path.resolve(import.meta.dirname, '..'), fx = makeFixtures();
const dataDir = path.join(fx.root, 'store'), plain = value => JSON.parse(JSON.stringify(value));
const ref = { provider: 'codex', identityDomain: 'app-storage', scopeId: storageScope(fx.codexHome), kind: 'project', nativeId: 'p' };
let child, sequence = 0, taskId;
const waiting = new Map();
function rpc(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 15000);
    waiting.set(id, value => { clearTimeout(timer); resolve(value); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
async function call(name, args = {}) {
  const packet = await rpc('tools/call', { name, arguments: plain(args) });
  assert.equal(packet.error, undefined, JSON.stringify(packet.error));
  assert.ok(!packet.result.isError, packet.result.content?.[0]?.text);
  const data = packet.result.structuredContent;
  return data.result ?? data;
}
const cards = board => board.lists.flatMap(list => list.cards);
const ids = board => cards(board).map(card => card.id).sort();
function browser() {
  const values = new Map();
  const context = vm.createContext({ window: { innerWidth: 1280 }, localStorage: { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) },
    slackUi: { visible: false }, T: { category: 'カテゴリ', automation: '自動化', aiApps: 'AI Apps' }, STATUS_LABELS: {}, panes: [],
    workspace: { utilityPage: () => false, navigate() {} }, bridge: { callTool: async (name, args) => { context.lastArgs = plain(args); return call(name, args); } },
    render() {}, reconcileCards() {}, refreshShortcutHints() {}, refreshViews() {}, syncHeaderInputs() {}, picon: () => '', keycap: () => [],
  });
  const files = ['state.js', 'source-facets.js', 'sidebar-categories.js', 'sidebar.js', 'load.js'];
  vm.runInContext(files.map(file => fs.readFileSync(path.join(root, 'ui', file), 'utf8')).join('\n'), context);
  // Only DOM painting is replaced. The picker, filters, applyView, load, wire and server are real.
  vm.runInContext(`toast=()=>{}; syncHeaderInputs=()=>{}; h=(tag,attrs={},...children)=>({tag,attrs,children:children.flat(Infinity)});`, context);
  context.picker = (_anchor, options) => { context.pickerOptions = options; };
  context.accountName = value => value;
  context.directoryItems = () => [];
  context.matchMedia = () => ({matches:true});
  vm.runInContext('const trackedLoad=load; load=(...args)=>{globalThis.loading=true;return trackedLoad(...args).finally(()=>globalThis.loading=false)};', context);
  return {
    context,
    async run(code) { return vm.runInContext(code, context); },
    async initial() { await vm.runInContext("Object.assign(state.filters,{days:0,dotScope:'all'});load({throwOnError:true})", context); },
    get board() { return vm.runInContext('state.board', context); },
    async settled() { for (let i = 0; i < 100; i++) { if (context.loading === false) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('UI load did not settle'); },
    async pick(folder, via = 'picker') {
      if (via === 'picker') {
        await vm.runInContext('scopePicker(null)', context);
        const item = context.pickerOptions.items.find(item => item.group === '作業フォルダ' && item.label === folder);
        assert.ok(item, `advertised folder ${folder}`);
        context.pickerOptions.onPick(item.value);
      } else {
        const rows = vm.runInContext('filterSection(state.board)', context);
        const all = []; const walk = node => { if (!node || typeof node !== 'object') return; all.push(node); for (const child of node.children || []) walk(child); }; walk(rows);
        const row = all.find(node => node.tag === 'button' && node.children.some(child => child?.attrs?.text?.startsWith(folder+' ·')));
        assert.ok(row, `sidebar folder ${folder}`); row.attrs.onclick();
      }
      await this.settled();
    },
  };
}

before(async () => {
  const db = new DatabaseSync(path.join(fx.codexHome, 'state_5.sqlite'));
  db.exec("UPDATE threads SET cwd='/r/web' WHERE id='t1'"); db.close();
  fs.writeFileSync(path.join(fx.codexHome, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { p: { name: 'Native', rootPaths: ['/r/web'] } }, 'thread-project-assignments': { t1: { projectId: 'p' } } }));
  // Existing onSessions hook supplies a fictional additional location; no adapter/real-data mutation.
  const script = `import {onSessions} from './server/board.mjs'; onSessions(sessions=>{for(const s of sessions)if(['codex:t1','claude:c2'].includes(s.id))s.workingLocations=[{folder:'/r/web',primary:true},{folder:'/r/shared'}];});await import('./server/index.mjs');`;
  child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env,
    CANBAN_DATA_DIR: dataDir, CANBAN_CODEX_HOME: fx.codexHome, CANBAN_CLAUDE_HOME: fx.claudeHome, CANBAN_CLAUDE_DESKTOP_DIR: fx.desktopDir,
    CANBAN_LAUNCH_DRYRUN: '1', CANBAN_BACKGROUND: '0', CANBAN_SEARCH_INDEX: '0', CANBAN_GH: path.join(root, 'tests/fake-gh.sh'), CANBAN_GLAB: path.join(root, 'tests/fake-glab.sh'), FAKE_GH_DATA: '/dev/null' } });
  readline.createInterface({ input: child.stdout }).on('line', line => { const packet = JSON.parse(line); waiting.get(packet.id)?.(packet); waiting.delete(packet.id); });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'filter-fixture', version: '1' } });
  taskId = (await call('canban_create_task', { title: '旧名と観測集合', context: { folder: 'web' } })).cardId;
  await call('canban_link_session', { taskId, sessionId: 'codex:t1' });
});
after(async () => { if(child)await new Promise(resolve=>{child.once('exit',resolve);child.kill();});fx.cleanup(); });

for (const [folder, via] of [['/r/web', 'picker'], ['/r/shared', 'sidebar']]) test(`I1 advertised ${folder} retains counted tasks and sessions after ${via} -> RPC`, async () => {
    const ui = browser(); await ui.initial();
    const facet = plain(await ui.run(`workingFolderFacets(state.board)`)).find(f => f.cwd === folder);
    assert.equal(facet.count, 2);
    await ui.pick(folder, via);
    assert.deepEqual(ids(ui.board), ['claude:c2', taskId].sort(), `${folder} must keep the 2 advertised cards`);
    assert.equal(ui.context.lastArgs.workingFolder, folder);
    assert.equal(ui.context.lastArgs.folder, undefined, 'new picker must not broaden the old predicate');
});

test('I1 old folder states/path and saved views keep precedence while the new working condition ANDs native sources', async () => {
  for (const [context, old, expected] of [[{}, '/r/web', true], [{folder:null}, '/r/web', false], [{folder:'web'}, '/r/web', false], [{folder:'web'}, 'web', true], [{folder:'/r/web'}, '/r/web', true], [{folder:'/elsewhere'}, '/r/web', false], [null, '/r/web', true]]) {
    await call('canban_update_task', { cardId: taskId, context: null });
    if (context !== null) await call('canban_update_task', { cardId: taskId, context });
    const view = await call('canban_save_view', { name: `旧folder${sequence}`, filters: { folder: old, days: 0, dotScope: 'all' } });
    const ui = browser(); ui.context.view = view;
    await ui.run('applyView(view)'); await ui.settled();
    assert.equal(ids(ui.board).includes(taskId), expected, JSON.stringify(context));
    assert.equal(ui.context.lastArgs.folder, old);
    assert.equal(ui.context.lastArgs.workingFolder, undefined);
  }
  await call('canban_update_task', {cardId:taskId,context:{folder:'web'}});
  const ui = browser(); await ui.initial(); await ui.pick('/r/shared');
  await ui.run(`Object.assign(state.filters,{sourceFilters:[{ref:${JSON.stringify(ref)}}]});load({throwOnError:true})`);
  assert.deepEqual(ids(ui.board), [taskId]);
  await ui.run(`Object.assign(state.filters,{sourceFilters:[{ref:${JSON.stringify({...ref,nativeId:'missing'})}}]});load({throwOnError:true})`);
  assert.deepEqual(ids(ui.board), []);
});

test('I2 saved task/session views survive applyView -> load -> RPC and compare, chips and reset distinguish kind', async () => {
  for (const kind of ['task', 'session']) {
    const view = await call('canban_save_view', { name: kind, filters: { cardKind: kind, days: 0, dotScope: 'all' } });
    const ui = browser(); ui.context.view = view;
    await ui.run('applyView(view)'); await ui.settled();
    assert.equal(ui.context.lastArgs.cardKind, kind);
    assert.ok(cards(ui.board).length > 0); assert.ok(cards(ui.board).every(card => (card.kind || 'session') === kind));
    assert.equal(await ui.run("sameFilters({cardKind:'task'},{cardKind:'session'})"), false);
    assert.equal(await ui.run('activeView(state.board)?.id'), view.id);
    const chip = plain(await ui.run('filterChips(state.board)')).find(chip => chip.patch.cardKind === 'all');
    assert.ok(chip, 'kind is visible and removable'); ui.context.patch = chip.patch;
    await ui.run('setScope(patch)'); await ui.run('load({throwOnError:true})');
    assert.ok(cards(ui.board).some(card => card.kind === 'task')); assert.ok(cards(ui.board).some(card => card.kind !== 'task'));
    await ui.run("Object.assign(state.filters,{cardKind:'task',workingFolder:'/r/shared'});clearFilters();load({throwOnError:true})");
    assert.equal(ui.context.lastArgs.cardKind, 'all'); assert.equal(ui.context.lastArgs.workingFolder, undefined);
  }
});

test('I1 working folder saves, compares, removes and rolls back without dropping unsupported conditions', async () => {
  const view = await call('canban_save_view', { name: '作業場所', filters: { workingFolder: '/r/shared', days: 0, dotScope: 'all' } });
  assert.equal(view.filters.workingFolder, '/r/shared');
  const ui = browser(); ui.context.view = view;
  await ui.run('applyView(view)'); await ui.settled();
  assert.deepEqual(ids(ui.board), ['claude:c2', taskId].sort());
  assert.equal(await ui.run("sameFilters({workingFolder:'/r/web'},{workingFolder:'/r/shared'})"), false);
  const chip = plain(await ui.run('filterChips(state.board)')).find(chip => Object.hasOwn(chip.patch, 'workingFolder'));
  assert.ok(chip); ui.context.patch = chip.patch;
  await ui.run('setScope(patch)'); await ui.run('load({throwOnError:true})');
  assert.equal(ui.context.lastArgs.workingFolder, undefined);
  const input = {settings:{views:[view,{id:'legacy',name:'旧',filters:{folder:'web'}}]}};
  const result = rollbackSourceViews(input);
  assert.deepEqual(result.state.settings.views.map(v=>v.id), ['legacy']);
  assert.equal(result.report.heldViews[0].filters.workingFolder, '/r/shared');
  assert.equal(input.settings.views.length, 2);
});

test('M2 all four native axes preserve relevant confirmed absence; unknown and missing links stay unknown', () => {
  const ui=browser();
  const lane=(card,axis)=>{ui.context.card=card;ui.context.axis=axis;return vm.runInContext('sourceLane(card,axis).id',ui.context);};
  for(const axis of ['codexProject','codexSection','claudeEnvironment','claudeGroup']){
    const provider=axis.startsWith('codex')?'codex':'claude';
    const nativeRef={provider,identityDomain:'app-storage',scopeId:'/scope',kind:{codexProject:'project',codexSection:'section',claudeEnvironment:'environment',claudeGroup:'group'}[axis],nativeId:'native'};
    const session=(id,status)=>({id,agent:provider,sourceView:compactSourceView({...sessionSourceView({id,agent:provider}),attributes:{[axis]:{status,value:null,source:'fixture'}}})});
    const absent=session('a','absent'), unknown=session('u','unknown'), unrelated={id:'other',agent:provider==='codex'?'claude':'codex'};
    const task=links=>({kind:'task',links});
    for(const [card,want] of [[absent,'__absent'],[task([absent]),'__absent'],[task([absent,{...absent,id:'b'}]),'__absent'],[task([absent,unrelated]),'__absent'],[task([absent,unknown]),'__unknown'],[task([absent,session('s','stale')]),'__unknown'],[task([absent,session('x','unavailable')]),'__unknown'],[task([]),'__unknown'],[task([unrelated]),'__unknown'],[{...task([absent]),missingLinks:1},'__unknown']])assert.equal(lane(card,axis),want,`${axis} ${JSON.stringify(card)}`);
    assert.equal(lane({...task([absent]),sourceContext:[{ref:nativeRef}]},axis),JSON.stringify([1,...['provider','identityDomain','scopeId','kind','nativeId'].map(k=>nativeRef[k])]));
  }
});

test('M2 working-folder lanes show only confirmed empty sets as absent and retain plans and unknowns', () => {
  const ui=browser(); const lane=card=>{ui.context.card=card;return vm.runInContext("sourceLane(card,'workingFolder').id",ui.context);};
  const session=(id,locations)=>({id,agent:'codex',sourceView:compactSourceView(sessionSourceView({id,agent:'codex',...(locations===undefined?{}:{workingLocations:locations})}))});
  const empty=session('e',[]),unknown=session('u'),task=links=>({kind:'task',links});
  for(const [card,want] of [[empty,'__absent'],[task([empty]),'__absent'],[task([empty,{...empty,id:'e2'}]),'__absent'],[task([empty,unknown]),'__unknown'],[task([]),'__unknown'],[{...task([empty]),missingLinks:1},'__unknown'],[{...task([empty]),context:{folder:'/r/plan'}},'/r/plan'],[{...task([empty]),context:{folder:'unresolved'}},'legacy:unresolved'],[task([session('x',[{folder:'/r/web'}])]),'/r/web']])assert.equal(lane(card),want,JSON.stringify(card));
});

test('working-folder path-set predicate agrees with UI facets for legacy states, plans and locations', async () => {
  const ui = browser();
  const observed = {id:'s',agent:'codex',workingLocations:[{folder:'/r/web/'},{folder:'/r/shared'}]};
  observed.sourceView = compactSourceView(sessionSourceView(observed));
  for (const context of [undefined,null,{}, {folder:null},{folder:'web'},{folder:'/r/plan/'},{folder:'shared'},{folder:'unresolved'}]) {
    const task={kind:'task',context,links:[observed]}; ui.context.card=task;
    const paths=plain(await ui.run('sourceFolders(card)'));
    for(const path of ['/r/web','/r/shared','/r/plan','/r/missing']) assert.equal(matchesWorkingFolder(task,task.links,path),paths.includes(path),JSON.stringify(context));
  }
  const planned={kind:'task',context:{folder:'/r/plan'},links:[]};
  assert.equal(matchesWorkingFolder(planned,[], '/r/plan'),true);
  assert.equal(matchesWorkingFolder({context:{folder:'plan'}},[], '/r/plan'),false);
  assert.equal(matchesTask(planned,[], 'idle',normalizeFilters({workingFolder:'/r/plan',folder:'other'}),new Map(),null),false);
  assert.equal(normalizeWorkingFolder('/'),'/');assert.equal(normalizeWorkingFolder('/r/web/'),'/r/web');
  for(const bad of ['web',1,{},'\0'])assert.throws(()=>normalizeFilters({workingFolder:bad}),/絶対パス/);
});

test('workingFolder and cardKind survive shared UI-state save/read and reject a malformed path', async () => {
  const current=await call('canban_get_ui_state');
  const filters={workingFolder:'/r/shared',cardKind:'task',folder:'web',sourceFilters:[{ref}]};
  await call('canban_save_ui_state',{expectedRevision:current.revision,state:{...current.state,filters}});
  const saved=await call('canban_get_ui_state');assert.deepEqual(saved.state.filters,filters);
  const ui=browser();ui.context.persisted=saved.state.filters;
  await ui.run('Object.assign(state.filters,persisted,{days:0,dotScope:"all"});load({throwOnError:true})');
  assert.deepEqual(ids(ui.board),[taskId]);assert.equal(ui.context.lastArgs.cardKind,'task');assert.equal(ui.context.lastArgs.workingFolder,'/r/shared');
  for(const name of ['canban_get_board','canban_save_view','canban_save_ui_state']){
    const args=name==='canban_get_board'?{workingFolder:'relative'}:name==='canban_save_view'?{name:'invalid',filters:{workingFolder:'relative'}}:{expectedRevision:saved.revision,state:{...saved.state,filters:{workingFolder:'relative'}}};
    const packet=await rpc('tools/call',{name,arguments:args});assert.ok(packet.error || packet.result.isError,name);
  }
});

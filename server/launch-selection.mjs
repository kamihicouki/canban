// Pure launch guard. Catalogs must be fetched afresh by the caller immediately before launch.
import { sourceKey } from './source-model.mjs';
export function launchEvidence(selection, requestId) {
  return {
    selection: { ...selection, requestId },
    receipt: { version: 1, requestId, sessionId: null, status: 'unresolved', selectedRefs: selection.selectedRefs, appliedRefs: [], observedAt: null, reason: '元アプリの適用確認は未取得です' },
  };
}
export async function prepareLaunchSelection(request, targets = {}) {
  const { agent, route = 'desktop', environmentId, projectId, sourceRef, cwd = '', runOn = 'local', cloudEnvironment } = request;
  const selectedRefs = [];
  let hostId = request.hostId || 'local', folder = cwd;
  if (sourceRef !== undefined && (!sourceKey(sourceRef) || agent !== 'codex' || sourceRef.provider !== 'codex' || sourceRef.kind !== 'project' || !projectId || sourceRef.nativeId !== projectId)) throw new Error('出典sourceRefは一致するCodexプロジェクトのprojectIdと一緒に指定してください。環境・section・groupやフォルダ開始への縮約には対応していません');
  if (environmentId) throw new Error('Claudeの環境を完全適用できる公式経路は未確認です。元アプリで環境を選んで開始するか、「フォルダを指定して開始」を明示的に選んでください');
  if ((projectId || runOn === 'cloud') && targets.codex?.sourceObservation?.status !== 'known') throw new Error('開始設定の最新のscopeを確認できません。元アプリで設定を確認して選び直してください');
  if (projectId && runOn === 'cloud') throw new Error('クラウドではCodexプロジェクトの設定を適用できません。クラウド環境だけを明示的に選んでください');
  if (projectId) {
    if (agent !== 'codex') throw new Error('プロジェクトを選べるのはCodexだけです');
    const project = targets.codex?.projects?.find(p => p.id === projectId);
    if (!project?.sourceRef || !sourceKey(project.sourceRef)) throw new Error('プロジェクトのscopeは未取得です。元アプリで確認してください');
    if (sourceRef && sourceKey(sourceRef) !== sourceKey(project.sourceRef)) throw new Error('開始設定のscopeが変わりました。プロジェクトを選び直してください');
    if (route !== 'desktop' || project.hostId !== 'local') throw new Error('この経路ではプロジェクト設定の完全適用を確認できません。元アプリで開始するか、フォルダ指定を選んでください');
    selectedRefs.push(project.sourceRef); folder = project.root; hostId = project.hostId;
  }
  if (runOn === 'cloud' && !targets.codex?.cloudEnvironments?.some(e => e.id === cloudEnvironment)) throw new Error('Codex Cloudの環境を選び直してください');
  return { version: 1, mode: projectId ? 'preset' : folder ? 'folder' : 'projectless', agent, route: runOn === 'cloud' ? 'cloud' : route, selectedRefs, account: request.account || null, hostId, cwd: folder, ...(runOn === 'cloud' ? { cloudEnvironment } : {}) };
}

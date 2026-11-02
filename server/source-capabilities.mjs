// Advisory snapshot only: execution still runs the owner's existing guards afresh.
import { sessionActions } from './session-actions.mjs';
import { staticProblem, timingProblem } from './dispatch.mjs';
import { permissionFor } from './permissions.mjs';
import { launchInfo } from './agents.mjs';
import { isCloudSession } from './sources/codex-dots.mjs';

const operations = ['open', 'start', 'sendPrompt', 'archive', 'restore', 'delete', 'fork', 'interrupt', 'pin'];
function defaults(targetId) {
  const out = Object.fromEntries(operations.map(operation => [operation, { operation, status: 'unknown', reason: '操作条件は未取得です', targetId }]));
  out.sendPrompt.reason = '最新の状態・権限・送信設定は未取得です';
  for (const op of ['fork', 'interrupt', 'pin']) out[op] = { operation: op, status: 'unsupported', reason: 'Canbanからの操作には対応していません。元アプリで操作してください', targetId };
  return out;
}

export function capabilitiesFor({ session = null, target = null, account = null, observation = null } = {}) {
  const targetId = session?.id || target?.id || null;
  const capability = (operation, status, reason = null) => ({ operation, status, reason, targetId });
  const result = defaults(targetId);
  // A preset's existence proves neither an executable route nor full application.
  if (!session) return result;
  const launch = launchInfo(session);
  const ownershipUnknown = account?.id && !session.account;
  const mismatch = account?.id && session.account && account.id !== session.account;
  const terminal = launch.terminal?.command ? { status: 'available', reason: null } : { status: 'unsupported', reason: 'CLIの再開経路はありません' };
  const desktop = !launch.desktop?.exact ? { status: 'unsupported', reason: 'このセッションを正確に開くDesktop経路はありません' }
    : mismatch ? { status: 'blocked', reason: 'Desktopは現在ログイン中のアカウントで開きます。選択アカウントと所有アカウントが異なります' }
    : ownershipUnknown || session.agent === 'claude' && !account?.id ? { status: 'unknown', reason: 'Desktopの現在のログインと所有アカウントの一致は未確認です' }
    : { status: 'available', reason: null };
  const openStatus = terminal.status === 'available' || desktop.status === 'available' ? 'available' : desktop.status;
  result.open = capability('open', openStatus, desktop.status === 'blocked' || desktop.status === 'unknown' ? `${desktop.reason}${terminal.status === 'available' ? '。明示的なCLI再開は利用できます' : ''}` : openStatus === 'available' ? null : desktop.reason);
  if (session.agent === 'claude' || account?.id) result.open.routes = { desktop, terminal };
  const lifecycle = sessionActions(session);
  const stale = observation && ['stale', 'unavailable', 'unknown'].includes(observation.status);
  for (const op of ['archive', 'restore', 'delete']) {
    result[op] = mismatch ? capability(op, 'blocked', '選択中のアカウントとセッションのアカウントが異なります')
      : !lifecycle.available ? capability(op, session.agent !== 'codex' || session.host?.local === false || isCloudSession(session) ? 'unsupported' : 'blocked', lifecycle.reason)
      : ownershipUnknown ? capability(op, 'unknown', 'セッションの所有アカウントは未取得です')
      : stale || session.statusKnown === false ? capability(op, 'unknown', '最新のセッション状態を確認できません')
      : !session.nativeId ? capability(op, 'unknown', '元アプリのセッションIDは未取得です') : capability(op, 'available');
  }
  const blocked = reason => capability('sendPrompt', 'blocked', reason);
  if (mismatch) result.sendPrompt = blocked('選択中のアカウントとセッションのアカウントが異なります');
  else if (ownershipUnknown) result.sendPrompt = capability('sendPrompt', 'unknown', 'セッションの所有アカウントは未取得です');
  else if (isCloudSession(session)) result.sendPrompt = capability('sendPrompt', 'unsupported', 'このクラウドセッションへの追加依頼には対応していません');
  else if (['running', 'waiting'].includes(session.status)) result.sendPrompt = blocked('実行中・入力待ちには元アプリで答えてください');
  else if (!observation || observation.status !== 'known' || !observation.mtimeMs || !Array.isArray(observation.records) || !observation.dispatch || session.statusKnown === false) result.sendPrompt = capability('sendPrompt', 'unknown', '最新の状態・権限・送信設定は未取得です');
  else {
    const cfg = observation.dispatch;
    const problem = !cfg.enabled ? '指示の送信は設定でオフになっています'
      : observation.origin === 'model' && !cfg.allowModel ? 'モデルからの送信は設定でオフになっています'
      : staticProblem(session) || timingProblem(session, observation, observation.now ?? Date.now());
    const permission = permissionFor(session, observation.records);
    const elevated = permission.elevated && (observation.origin === 'model' ? !cfg.allowModelElevated : !observation.allowElevated);
    result.sendPrompt = problem ? blocked(problem) : elevated ? blocked('制限なしの権限には既存の送信確認が必要です') : capability('sendPrompt', 'available');
  }
  return result;
}

// Pure wire codecs: defaults are versioned here and use no session/catalog lookup.
export function compactCapabilities(full) {
  const targetId = full.open.targetId, base = defaults(targetId);
  return { version: 1, compact: true, targetId, operations: Object.fromEntries(operations.filter(op => JSON.stringify(full[op]) !== JSON.stringify(base[op])).map(op => {
    const { operation, targetId: id, ...value } = full[op];
    return [op, { ...value, ...(id !== targetId ? { targetId: id } : {}) }];
  })) };
}

export function expandCapabilities(wire) {
  if (!wire?.compact) return wire;
  const full = defaults(wire.targetId);
  for (const [op, value] of Object.entries(wire.operations || {})) if (operations.includes(op)) full[op] = { ...full[op], ...value };
  return full;
}

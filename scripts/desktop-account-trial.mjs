#!/usr/bin/env node
// Explicit, reviewable stopped-profile trial. plan/verify only read metadata.
// apply/rollback require both --apply and the saved --plan. Never quits an app.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { dataDir as configuredDataDir } from '../server/store.mjs';
import { configureDesktopStorage } from '../server/accounts.mjs';
import { guestPaths } from '../server/claude-desktop-guests.mjs';
import { desktopAccountPaths, readDesktopIdentity, readDesktopRegistry } from '../server/claude-desktop-roots.mjs';
import { desktopBuilds } from '../server/desktop-capabilities.mjs';
import { inspectDesktopRuntime } from '../server/claude-desktop-runtime.mjs';
import { managedDesktopAccounts } from '../server/claude-desktop-profile.mjs';

export async function planDesktopTrial({ dataDir, appDir, step = 'enroll-current', account }) {
  if (!['enroll-current','begin-login','finish-login','cancel','switch'].includes(step)) throw new Error('試行段階が不正です');
  const paths = await desktopAccountPaths({ dataDir, appDir });
  const current = await readDesktopIdentity(paths.appDir), registry = await readDesktopRegistry(paths);
  return { version: 1, dataDir: paths.dataDir, appDir: paths.appDir, builds: await desktopBuilds(), originalAccount: registry.profiles.find(p => p.active)?.account || current, expectedCurrent: current, step, account: account || current, requestId: randomUUID(),
    backupParent: path.join(paths.dataDir, 'desktop-backups'),
    operations: step === 'enroll-current' ? ['現在のDesktopアカウントIDと標準保存先をCanbanの対応表へ登録する。Desktopのデータは移動しない'] : ['ユーザーがDesktopを保存して終了する。処理中・未確認なら待機する', '停止状態で元のプロフィールを700の保存先へコピーし、復元先を記録する', 'CLIの認証・プロセス・キューとKeychainは変更せず、Desktopの保存先だけを台帳付きで移動する'],
    acceptance: ['初回接続後A→B→Aを3往復','ログアウト0回・再ログイン0回','CLIとDesktop双方の会話・作業先・保存済み下書きを確認','Dock起動とCLI継続を確認','送信しない。失敗時は元のアカウントへ戻す'] };
}
async function main() {
  const args = process.argv.slice(2), command = args[0] || 'plan';
  const option = key => { const n = args.indexOf(`--${key}`); return n < 0 ? undefined : args[n+1]; };
  const store = { dir: configuredDataDir() }; configureDesktopStorage(store.dir);
  const appDir = path.dirname(guestPaths().sessions), service = managedDesktopAccounts(store.dir);
  if (command === 'plan') return planDesktopTrial({ dataDir: store.dir, appDir, step: option('step'), account: option('account') });
  if (command === 'verify') return { state: 'unverified', ...await service.view(), runtime: await inspectDesktopRuntime({ defaultDir: appDir }), note: 'アカウントIDの一致は認証保持の証明ではありません。計画の受け入れ条件を実アプリで確認してください。' };
  if (!['apply','rollback'].includes(command) || !args.includes('--apply') || !option('plan')) throw new Error('保存した計画の --plan と明示した --apply が必要です');
  const plan = JSON.parse(await fs.readFile(option('plan'), 'utf8'));
  const paths = await desktopAccountPaths({ dataDir: store.dir, appDir });
  if (plan.version !== 1 || plan.dataDir !== paths.dataDir || plan.appDir !== paths.appDir || JSON.stringify(plan.builds) !== JSON.stringify(await desktopBuilds())) throw new Error('計画のアプリ・保存先が変わりました。計画を作り直してください');
  const runtime = await inspectDesktopRuntime({ defaultDir: appDir });
  if (runtime.running !== false) return { state: 'waiting-for-quit', reason: 'Desktopを保存して終了してください。強制終了はしません' };
  if (command === 'rollback') {
    await service.command({ type: 'recover' });
    const view = await service.view();
    if (view.pending?.active) return service.command({ type: 'cancel', requestId: randomUUID() });
    return service.withAccount(plan.originalAccount, { requestId: randomUUID(), allowSwitch: true }, () => ({ state: 'prepared', account: plan.originalAccount }));
  }
  if (await readDesktopIdentity(appDir) !== plan.expectedCurrent) throw new Error('計画時のアカウントと一致しません');
  if (plan.step === 'switch') return service.withAccount(plan.account, { requestId: plan.requestId, allowSwitch: true }, () => ({ state: 'prepared', account: plan.account }));
  return service.command({ type: plan.step, account: plan.account, requestId: plan.requestId });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => process.stdout.write(JSON.stringify(result,null,2)+'\n'), () => { process.stderr.write('試行を中止しました。保存先・計画・停止状態を確認してください。復元記録を確認してください。\n'); process.exitCode = 1; });
}

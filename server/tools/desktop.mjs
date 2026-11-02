// Claude / Codex Desktop accounts and pending Desktop starts (server/desktop-launch.mjs).
import { appAndModel, appTool } from './shared.mjs';

export function desktopTools({ requireLoopUi, desktopSetup, desktopLaunches }) {
  return [
  appTool('canban_desktop_accounts', 'Desktop の接続状態', {}, [], async () => ({ ...await desktopSetup.view(), pendingLaunches: await desktopLaunches.pending() })),
  appTool('canban_desktop_account_command', 'Desktop の接続を変更', { type: { type: 'string', enum: ['enroll-current','begin-login','finish-login','cancel','recover','cancel-wait','trial-start','trial-switch','trial-observe','trial-complete','trial-cancel'] }, account: { type: 'string' }, requestId: { type: 'string' }, confirmations: { type: 'object', additionalProperties: { type: 'boolean' } }, uiToken: { type: 'string' } }, ['type','uiToken'], async a => {
    const args = requireLoopUi(a);
    return desktopSetup.command(args);
  }),
  {
    name: 'canban_get_start_session', title: '開始状況を確認', description: '同じ開始要求の待機・起動結果を読み取る。',
    inputSchema: { type: 'object', properties: { clientRequestId: { type: 'string' } }, required: ['clientRequestId'], additionalProperties: false },
    annotations: { readOnlyHint: true }, _meta: appAndModel,
    handler: async a => ({ text: '開始状況', structured: { result: await desktopLaunches.status(a.clientRequestId) } }),
  },
  appTool('canban_cancel_start_session', 'Desktop の開始待機を取り消す', { clientRequestId: { type: 'string' }, uiToken: { type: 'string' } }, ['clientRequestId', 'uiToken'], a => {
    const args = requireLoopUi(a); return desktopLaunches.cancel(args.clientRequestId, { uiAuthorized: true });
  }),
  appTool('canban_acknowledge_desktop_launch', '結果不明の起動をアプリで確認した', { clientRequestId: { type: 'string' }, uiToken: { type: 'string' } }, ['clientRequestId','uiToken'], a => {
    const args = requireLoopUi(a); return desktopLaunches.acknowledge(args.clientRequestId, { uiAuthorized: true });
  }),
  appTool('canban_get_desktop_launch_draft', '保存したDesktop開始依頼をUIへ復元する', { clientRequestId: { type: 'string' }, uiToken: { type: 'string' } }, ['clientRequestId','uiToken'], a => {
    const args = requireLoopUi(a); return desktopLaunches.draft(args.clientRequestId, { uiAuthorized: true });
  }),
  ];
}

// A session's working folder: its changes and the card's terminal (server/terminal.mjs).
import { findSession } from '../board.mjs';
import { isCloudSession, CLOUD_OPERATION_REASON } from '../sources/codex-dots.mjs';
import { listChanges, fileDiff } from '../changes.mjs';
import { projectRoot } from '../terminal.mjs';
import { appTool } from './shared.mjs';

export function workspaceTools({ store, requireLoopUi, terminals }) {
  return [
  appTool('canban_get_changes', '作業フォルダの変更を取得', { cardId: { type: 'string' }, path: { type: 'string' } }, ['cardId'], async ({ cardId, path: file }) => {
    const { session, host } = await findSession(store, cardId);
    if (isCloudSession(session)) return { available: false, reason: CLOUD_OPERATION_REASON };
    if (host) return { available: false, reason: 'リモートのセッションの変更はまだ表示できません' };
    if (file) return { available: true, diff: await fileDiff(session.cwd, file) };
    return listChanges(session.cwd);
  }),
  // The card's terminal (server/terminal.mjs). Only the board UI holds the token, so a model cannot type into it.
  appTool('canban_terminal_open', 'カードのターミナルを開く', { cardId: { type: 'string' }, cols: { type: 'number' }, rows: { type: 'number' }, uiToken: { type: 'string' } }, ['cardId', 'uiToken'], async (a) => {
    const { cardId, cols, rows } = requireLoopUi(a);
    const { session, host } = await findSession(store, cardId);
    if (isCloudSession(session)) throw new Error(CLOUD_OPERATION_REASON);
    if (host) throw new Error('リモートのセッションではまだターミナルを開けません');
    const cwd = await projectRoot(session.cwd);
    if (!cwd) throw new Error('このセッションの作業フォルダが見つかりません');
    return terminals.open({ key: cardId, cwd, cols, rows });
  }),
  appTool('canban_terminal_read', 'カードのターミナルの出力を待つ', { id: { type: 'string' }, since: { type: 'number' }, timeoutMs: { type: 'number' }, uiToken: { type: 'string' } }, ['id', 'uiToken'], (a) => terminals.read(requireLoopUi(a))),
  appTool('canban_terminal_write', 'カードのターミナルに入力する', { id: { type: 'string' }, data: { type: 'string' }, uiToken: { type: 'string' } }, ['id', 'data', 'uiToken'], (a) => terminals.write(requireLoopUi(a))),
  appTool('canban_terminal_resize', 'カードのターミナルの大きさを変える', { id: { type: 'string' }, cols: { type: 'number' }, rows: { type: 'number' }, uiToken: { type: 'string' } }, ['id', 'cols', 'rows', 'uiToken'], (a) => terminals.resize(requireLoopUi(a))),
  appTool('canban_terminal_close', 'カードのターミナルを閉じる', { id: { type: 'string' }, uiToken: { type: 'string' } }, ['id', 'uiToken'], (a) => terminals.close(requireLoopUi(a))),
  ];
}

// Improvement loop tools (server/loop.mjs). Confirmation and sending need the board UI token.
import { findSession } from '../board.mjs';
import { dispatcherFor } from '../dispatch.mjs';
import { loopArtifact } from '../loop-artifact.mjs';
import { appOnly, appAndModel, requestView } from './shared.mjs';

const loopCommandProps = { taskId: { type: 'string' }, expectedRevision: { type: 'integer', minimum: 0 }, commandId: { type: 'string' }, command: { type: 'object' } };
async function loopCommand(store, args, source) {
  const prior = await store.getLoop({ taskId: args.taskId });
  if (args.command.type === 'start') {
    const task = (await store.load()).cards[args.taskId];
    const taskHost = task.context?.host || task.target?.host || 'local';
    let cwd = taskHost === 'local' ? task.context?.cwd || task.target?.cwd : null;
    if (!cwd && task.links?.length) {
      try { const r = await findSession(store, task.links[0]); if (r.session.host?.local !== false) cwd = r.session.cwd; } catch {}
    }
    const artifactRef = await loopArtifact(cwd);
    args.command = { ...args.command, artifactFolder: artifactRef ? cwd : null, startedArtifactRef: artifactRef };
  }
  if (['record', 'confirm'].includes(args.command.type)) {
    const c = prior.cycles.find(c => c.id === args.command.cycleId);
    const round = c?.rounds.at(-1);
    if (round?.artifactFolder) {
      const ref = await loopArtifact(round.artifactFolder);
      if (!ref || args.command.artifactRef !== ref) throw new Error('成果物が変わったか、版を確認できません。最新の版を読み直して検証してください');
    }
  }
  const result = await store.loopCommand({ ...args, source });
  if (result.saved && args.command.type === 'pause') {
    const requests = await dispatcherFor(store).requests.list();
    for (const r of requests.filter(r => r.state === 'queued' && r.loopContext?.taskId === args.taskId && r.loopContext?.cycleId === args.command.cycleId)) await dispatcherFor(store).requests.cancel(r.id);
  }
  return { text: result.conflict ? '別の画面で更新されています。最新の状態を確認してください' : 'ループを保存しました', structured: result };
}


export function loopTools({ store, requireLoopUi }) {
  return [
  {
    name: 'canban_get_loop', title: '改善ループを取得', description: '目標、版付きの条件、大小2段のループと追記した周回・検証根拠を返す。CLIの正常終了は合格と扱わない。',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false },
    annotations: { readOnlyHint: true }, _meta: appAndModel,
    handler: async a => {
      const record = await store.getLoop(a);
      const refs = new Map();
      for (const c of record.cycles) {
        const last = c.rounds.at(-1);
        if (last?.artifactFolder) {
          if (!refs.has(last.artifactFolder)) refs.set(last.artifactFolder, await loopArtifact(last.artifactFolder));
          c.currentArtifactRef = refs.get(last.artifactFolder);
          c.stale = !!last.results && c.currentArtifactRef !== last.artifactRef;
        }
      }
      return { text: '改善ループ', structured: record };
    },
  },
  {
    name: 'canban_loop_command', title: '改善ループを進める',
    description: 'expectedRevisionと一意なcommandIdを指定。command: configure(goal, criteria文字列配列, principles, maxRounds, 任意cycleId/parentId)、start(cycleId,nextAction)、record(cycleId,roundId,version,artifactRef,results:[criterionId,pass:true/false/null,summary,ref],learning)、pause/resume(cycleId)。エージェントの検証結果は報告として保存され、人の確認まで完了にはしない。送信はUIで人が行う。',
    inputSchema: { type: 'object', properties: loopCommandProps, required: Object.keys(loopCommandProps), additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false }, _meta: appAndModel,
    handler: async a => loopCommand(store, a, 'reported'),
  },
  {
    name: 'canban_review_loop', title: '改善ループを確認（UI）',
    inputSchema: { type: 'object', properties: { ...loopCommandProps, uiToken: { type: 'string' } }, required: [...Object.keys(loopCommandProps), 'uiToken'], additionalProperties: false },
    _meta: appOnly, handler: async a => loopCommand(store, requireLoopUi(a), 'human'),
  },
  {
    name: 'canban_send_loop', title: 'この周回の指示を送る（UI）',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, cycleId: { type: 'string' }, roundId: { type: 'string' }, expectedRevision: { type: 'integer' }, cardId: { type: 'string' }, prompt: { type: 'string' }, uiToken: { type: 'string' } }, required: ['taskId','cycleId','roundId','expectedRevision','cardId','prompt','uiToken'], additionalProperties: false },
    _meta: appOnly,
    handler: async a => {
      const { taskId, cycleId, roundId, expectedRevision, cardId, prompt } = requireLoopUi(a);
      const r = await dispatcherFor(store).submit({ cardId, prompt, when: 'queue', origin: 'ui', loopContext: { taskId, cycleId, roundId, expectedRevision } });
      return { text: `この周回の依頼（${r.id}）`, structured: requestView(r) };
    },
  },
  ];
}

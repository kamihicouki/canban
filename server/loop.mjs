// A loop is work with explicit criteria and an append-only observation history.
// CLI execution status is deliberately separate from verification status.
import crypto from 'node:crypto';

const text = (v, name, max = 4000) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error(`${name}を入力してください（${max}文字以内）`);
  return v.trim();
};
export function loopRecord(task, taskId) {
  if (task?.kind !== 'task') throw new Error('タスクカードが見つかりません');
  return { taskId, revision: task.loop?.revision || 0, cycles: structuredClone(task.loop?.cycles || []) };
}
export function loopProgress(cycle) {
  if (cycle.dependenciesChanged) return null;
  const last = cycle.rounds.filter(r => r.version === cycle.version && r.results).at(-1);
  if (!last || (!last.verified && !cycle.confirmations?.some(c => c.roundId === last.id)) || cycle.rounds.at(-1)?.id !== last.id) return null;
  return last.results.filter(r => r.pass).length / last.results.length;
}
export function loopPrompt(taskId, cycle) {
  const last = cycle.rounds.at(-1);
  const observed = cycle.rounds.filter(r => r.version === cycle.version && r.results).at(-1);
  return [`目標: ${cycle.goal}`, `守る原則（全文はタスクのループ参照）:\n${cycle.principles?.slice(0, 1600) || '既存のプロジェクトの指示と権限を守る'}`,
    `完了の条件（基準 v${cycle.version}）:\n${cycle.criteria.map(c => `${c.id}: ${c.text}`).join('\n')}`,
    `今回の調整（全文はタスクのループ参照）: ${cycle.nextAction?.slice(0, 2000) || '条件を満たすための最小の変更を実施し、検証する'}`,
    observed?.results ? `直近の観測:\n${observed.results.map(r => `${r.criterionId}: ${r.pass === null ? '未観測' : r.pass ? '合格' : '未達'} — ${r.summary.slice(0, 80)} (${r.ref.slice(0, 60) || '根拠なし'})`).join('\n')}` : '',
    `検証後は canban_loop_command で record を実行してください。taskId=${taskId}, cycleId=${cycle.id}, version=${cycle.version}。先に canban_get_loop で最新revisionと実行中のroundIdを確認してください。各条件のcriterionId/pass（true/false/null）/summary/ref、検証したartifactRef（コミットや成果物の版）、学びlearningを記録します。未実行の検証を合格にせず、通常終了だけを完了としないでください。`].filter(Boolean).join('\n\n');
}
export function applyLoopCommand(task, taskId, { expectedRevision, commandId, command, source = 'reported' }, now = Date.now()) {
  const current = loopRecord(task, taskId);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('リビジョンが正しくありません');
  text(commandId, '操作ID', 100);
  if (!command || typeof command !== 'object') throw new Error('操作が正しくありません');
  const hash = crypto.createHash('sha256').update(JSON.stringify(command)).digest('hex');
  const receipt = task.loop?.commands?.find(c => c.id === commandId);
  if (receipt) {
    if (receipt.hash !== hash) throw new Error('同じ操作IDを別の操作には使えません');
    return { ...current, saved: true, duplicate: true };
  }
  if (current.revision !== expectedRevision) return { ...current, saved: false, conflict: true };
  const cycles = current.cycles;
  let cycle = cycles.find(c => c.id === command.cycleId);
  if (command.type === 'configure') {
    const goal = text(command.goal, '目標', 500);
    const criteria = command.criteria;
    if (!Array.isArray(criteria) || !criteria.length || criteria.length > 20) throw new Error('完了の条件は1〜20件で指定してください');
    const maxRounds = command.maxRounds ?? 5;
    if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 20) throw new Error('周回の上限は1〜20です');
    if (cycle?.status === 'active') throw new Error('基準を変更する前にループを一時停止してください');
    if ((cycle?.definitions?.length || 0) >= 100) throw new Error('基準の版は100件までです。新しいタスクで続けてください');
    if (!cycle) {
      if (cycles.length >= 20) throw new Error('1タスクのループは20件までです');
      const parent = command.parentId && cycles.find(c => c.id === command.parentId);
      if (command.parentId && (!parent || parent.parentId)) throw new Error('小さなループの親は、このタスクの大きなループを選んでください');
      if (parent?.status === 'completed') throw new Error('完了した親ループは、先に基準を見直してください');
      cycle = { id: `loop-${crypto.randomUUID()}`, parentId: parent?.id || null, rounds: [], version: 0, createdAt: now };
      cycles.push(cycle);
    }
    const running = cycle.rounds.find(r => !r.results && !r.closedAt);
    if (running) { running.closedAt = now; running.superseded = true; }
    Object.assign(cycle, { goal, criteria: criteria.map((c, i) => ({ id: `c${i + 1}`, text: text(c, '完了の条件', 500) })),
      principles: typeof command.principles === 'string' ? command.principles.slice(0, 4000).trim() : '', maxRounds,
      version: cycle.version + 1, status: 'ready', phase: 'plan', reason: '', nextAction: '', updatedAt: now });
    cycle.definitions = [...(cycle.definitions || []), { version: cycle.version, goal, criteria: structuredClone(cycle.criteria), principles: cycle.principles, at: now }];
    cycle.confirmedRoundId = null;
  } else {
    if (!cycle) throw new Error('ループが見つかりません');
    const rounds = cycle.rounds.filter(r => r.version === cycle.version);
    const pending = rounds.find(r => !r.results && !r.closedAt);
    if (command.type === 'start') {
      if (!['ready', 'review'].includes(cycle.status) || pending) throw new Error('実行中・停止中・完了したループは開始できません');
      if (rounds.length >= cycle.maxRounds) throw new Error('周回の上限です。基準と進め方を見直してください');
      if (cycle.rounds.length >= 500) throw new Error('履歴の上限です。新しいタスクで続けてください');
      cycle.nextAction = text(command.nextAction || cycle.goal, '次の調整');
      cycle.rounds.push({ id: `round-${crypto.randomUUID()}`, version: cycle.version, number: rounds.length + 1, startedAt: now,
        artifactFolder: command.artifactFolder || null, startedArtifactRef: command.startedArtifactRef || null,
        goal: cycle.goal, criteria: structuredClone(cycle.criteria), principles: cycle.principles, action: cycle.nextAction });
      cycle.status = 'active'; cycle.phase = 'act'; cycle.reason = '';
    } else if (command.type === 'record') {
      if (cycle.status !== 'active' || !pending || command.roundId !== pending.id || command.version !== cycle.version) throw new Error('この検証は現在の周回・基準に対応していません');
      const artifactRef = text(command.artifactRef, '検証した成果物の版', 500);
      if (!Array.isArray(command.results) || command.results.length !== cycle.criteria.length) throw new Error('すべての条件の観測を記録してください');
      const results = cycle.criteria.map(c => {
        const matches = command.results.filter(r => r.criterionId === c.id);
        if (matches.length !== 1) throw new Error('条件IDが重複、または不足しています');
        const r = matches[0];
        if (![true, false, null].includes(r.pass)) throw new Error('観測は合格・未達・未観測で指定してください');
        return { criterionId: c.id, pass: r.pass, summary: text(r.summary, '観測の説明'), ref: r.pass === null ? '' : text(r.ref, '検証の根拠', 1000) };
      });
      Object.assign(pending, { artifactRef, results, closedAt: now, verified: source === 'human', source, learning: String(command.learning || '').slice(0, 4000) });
      cycle.dependenciesChanged = cycles.some(c => c.parentId === cycle.id && c.status !== 'completed');
      const complete = source === 'human' && results.every(r => r.pass === true) && cycles.filter(c => c.parentId === cycle.id).every(c => c.status === 'completed');
      const signature = r => JSON.stringify(r.results?.map(x => [x.criterionId, x.pass, x.summary]));
      const repeated = rounds.length > 1 && signature(rounds.at(-2)) === signature(pending) && !results.every(r => r.pass === true);
      cycle.status = complete ? 'completed' : repeated || rounds.length >= cycle.maxRounds ? 'paused' : 'review';
      cycle.phase = complete ? 'done' : 'adjust';
      cycle.reason = complete ? '' : repeated ? '同じ観測が2周続きました。進め方を見直してください' : rounds.length >= cycle.maxRounds ? '周回の上限に達しました' : source !== 'human' ? 'エージェントの報告です。根拠と成果物の版を人が確認してください' : results.every(r => r.pass === true) ? '小さなループの完了を待っています。親も再検証してください' : '根拠を見て、次の調整を決めてください';
    } else if (command.type === 'confirm') {
      const last = rounds.at(-1);
      if (source !== 'human' || !last?.results || command.roundId !== last.id || command.artifactRef !== last.artifactRef || cycle.status === 'active') throw new Error('現在の成果物と最新の報告を確認してください');
      cycle.confirmedRoundId = last.id;
      cycle.confirmedAt = now;
      if (!cycle.confirmations?.some(c => c.roundId === last.id)) cycle.confirmations = [...(cycle.confirmations || []), { roundId: last.id, at: now, artifactRef: last.artifactRef }];
      const complete = !cycle.dependenciesChanged && last.results.every(r => r.pass === true) && cycles.filter(c => c.parentId === cycle.id).every(c => c.status === 'completed');
      const paused = cycle.status === 'paused';
      cycle.status = complete ? 'completed' : paused || rounds.length >= cycle.maxRounds ? 'paused' : 'review';
      cycle.phase = complete ? 'done' : 'adjust';
      cycle.reason = complete ? '' : paused ? cycle.reason : cycle.dependenciesChanged ? '小さなループが変わりました。親の条件を再検証してください' : '確認済みの根拠から、次の調整を決めてください';
    } else if (command.type === 'pause') {
      if (cycle.status === 'completed') throw new Error('完了したループは停止できません');
      cycle.status = 'paused'; cycle.reason = '次の送信を停止中（実行中のCLIは依頼一覧から停止）';
    } else if (command.type === 'reopen') {
      if (cycle.status !== 'completed') throw new Error('完了したループだけ再検証できます');
      cycle.status = 'review'; cycle.phase = 'adjust'; cycle.reason = '成果物を再検証してください'; cycle.dependenciesChanged = true;
    } else if (command.type === 'resume') {
      if (cycle.status !== 'paused' || !pending) throw new Error('未検証の周回だけ再開できます。検証済みなら基準を見直してください');
      cycle.status = 'active'; cycle.reason = '';
    } else throw new Error('ループの操作が正しくありません');
    cycle.updatedAt = now;
  }
  if (cycle.parentId && ['configure', 'start', 'record', 'confirm', 'reopen'].includes(command.type)) {
    const parent = cycles.find(c => c.id === cycle.parentId);
    parent.dependenciesChanged = true;
    if (parent.status === 'completed') { parent.status = 'review'; parent.phase = 'adjust'; parent.reason = '小さなループが変わりました。親の条件を再検証してください'; }
  }
  task.loop = { revision: current.revision + 1, cycles, commands: [...(task.loop?.commands || []), { id: commandId, hash }].slice(-100) };
  task.updatedAt = now;
  return { ...loopRecord(task, taskId), cycleId: cycle.id, saved: true, conflict: false, nextPrompt: cycle.status === 'active' ? loopPrompt(taskId, cycle) : null };
}

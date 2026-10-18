// First connection is separate from the verified normal switching capability.
// Only the trusted board can start a trial or attest what the user saw in Desktop.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { desktopAccountPaths, desktopError, inspectProfileDirectory, readDesktopIdentity, readDesktopJson } from './claude-desktop-roots.mjs';
import { desktopProfileLock } from './claude-desktop-lock.mjs';
import { desktopBuilds, readDesktopCapabilities } from './desktop-capabilities.mjs';

async function locations(dataDir, appDir) {
  const paths = await desktopAccountPaths({ dataDir, appDir });
  for (const dir of [path.dirname(paths.state), paths.state]) {
    await fs.mkdir(dir, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    await inspectProfileDirectory(dir, { device: paths.device });
  }
  return paths;
}
async function write(file, value) {
  await readDesktopJson(file);
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  try {
    await fs.rename(temp, file);
    const dir = await fs.open(path.dirname(file), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await fs.rm(temp, { force: true }); }
}

export async function rememberDesktopAccount({ dataDir, appDir, account }) {
  const paths = await locations(dataDir, appDir);
  await write(path.join(paths.state, 'selection.json'), { account });
}

const initial = new Set(['enroll-current', 'begin-login', 'finish-login', 'cancel', 'recover']);
const trialCommands = new Set(['trial-start', 'trial-switch', 'trial-observe', 'trial-complete', 'trial-cancel']);
const observationKeys = ['authenticated','noLogin','draftsPreserved'];
const acceptanceKeys = ['cliPreserved','desktopPreserved','draftsPreserved','historyPreserved','writebackPreserved','dockPreserved','messagesSentByUser'];
const requireConfirmed = (input, keys) => {
  if (!keys.every(k => input.confirmations?.[k] === true)) throw desktopError('Desktop で確認した項目をすべて選んでください');
};
export function createDesktopAccountSetup({ dataDir, appDir, accounts, runtime, open, builds = desktopBuilds, platform = process.platform }) {
  async function view() {
    const paths = await locations(dataDir, appDir), v = await accounts.view();
    const capabilities = await readDesktopCapabilities(dataDir, { builds: await builds(), platform });
    const setup = await readDesktopJson(path.join(paths.state, 'setup.json')) || {};
    if (setup.trial && setup.trial.builds?.claude !== capabilities.builds?.claude) setup.trial = { ...setup.trial, state: 'needs-review' };
    const selection = await readDesktopJson(path.join(paths.state, 'selection.json'));
    const activeAccount = await readDesktopIdentity(appDir);
    return { ...v, ...capabilities, activeAccount, lastAccount: v.profiles.some(p => p.account === selection?.account) ? selection.account : null,
      profiles: v.profiles.map(p => ({ ...p, status: capabilities.accountSwitch ? 'available' : ['ready','awaiting-observation'].includes(setup.trial?.state) ? 'checking' : 'needs-verification' })), setup };
  }
  async function command(input) {
    if (!input || ![...initial, ...trialCommands, 'cancel-wait'].includes(input.type)) throw desktopError('Desktop の接続操作を確認してください');
    if (Object.keys(input).some(k => !['type','account','requestId','confirmations'].includes(k))) throw desktopError('Desktop の接続要求が不正です');
    if (input.confirmations && (typeof input.confirmations !== 'object' || Array.isArray(input.confirmations) || Object.entries(input.confirmations).some(([k,v]) => ![...observationKeys,...acceptanceKeys].includes(k) || typeof v !== 'boolean'))) throw desktopError('Desktop の確認項目が不正です');
    const paths = await locations(dataDir, appDir), file = path.join(paths.state, 'setup.json');
    const lock = await desktopProfileLock(path.join(paths.state, 'setup.lock'));
    try {
      const state = await readDesktopJson(file) || {};
      const save = async result => { await lock.assertHeld(); await write(file, state); return result; };
      if (input.type === 'cancel-wait') { delete state.pendingCommand; return save({ state: 'cancelled', reason: '終了待ちを取り消しました' }); }
      if (state.pendingCommand && JSON.stringify(state.pendingCommand) !== JSON.stringify(input) && !['cancel','recover','trial-cancel'].includes(input.type)) throw desktopError('Desktop の終了待ちを取り消してから操作してください');
      if (initial.has(input.type)) {
        const result = await accounts.command(input);
        if (result.state === 'waiting-for-quit') state.pendingCommand = input; else delete state.pendingCommand;
        return save(result);
      }
      const currentBuilds = await builds();
      if (input.type === 'trial-start') {
        if (platform !== 'darwin' || !currentBuilds.claude) throw desktopError('この Desktop のビルドを確認できません');
        if (state.trial && !['cancelled','complete','needs-review'].includes(state.trial.state)) throw desktopError('保持確認を中止してからやり直してください');
        const v = await accounts.view(), origin = v.profiles.find(p => p.active), target = v.profiles.find(p => p.account === input.account && !p.active);
        if (!origin || !target || v.pending?.active || await readDesktopIdentity(appDir) !== origin.account) throw desktopError('2つの Desktop アカウントを接続してから確認してください');
        state.trial = { id: randomUUID(), state: 'ready', builds: currentBuilds, origin: origin.account, other: target.account, profiles: [origin.id, target.id], observations: [], startedAt: Date.now() };
        return save(state.trial);
      }
      const trial = state.trial;
      if (!trial || ['cancelled','complete','needs-review'].includes(trial.state)) throw desktopError('保持確認を開始してください');
      if (input.type === 'trial-cancel') { trial.state = 'cancelled'; delete state.pendingCommand; return save(trial); }
      if (currentBuilds.claude !== trial.builds.claude) { trial.state = 'needs-review'; delete state.pendingCommand; await save(trial); throw desktopError('Desktop が更新されました。保持確認をやり直してください'); }
      if (trial.intent) { trial.state = 'needs-review'; delete state.pendingCommand; return save({ state: 'uncertain', reason: '前回の起動結果を Desktop で確認し、保持確認をやり直してください' }); }
      const v = await accounts.view();
      if (!trial.profiles.every(id => v.profiles.some(p => p.id === id))) throw desktopError('接続プロフィールが変更されました');
      if (input.type === 'trial-switch') {
        if (trial.state === 'awaiting-observation') return { ...trial, state: 'awaiting-observation' };
        if (trial.observations.length >= 6) throw desktopError('3往復の確認が終わりました。結果を記録してください');
        const account = trial.observations.length % 2 === 0 ? trial.other : trial.origin;
        state.pendingCommand = input; await save({ state: 'prepared' });
        const result = await accounts.withAccount(account, { allowSwitch: true, requestId: input.requestId }, async () => {
          trial.intent = 'open'; trial.account = account; await save({ state: 'opening' });
          await open();
          delete trial.intent; trial.state = 'awaiting-observation';
          return { state: trial.state, account };
        });
        if (result.state !== 'waiting-for-quit') delete state.pendingCommand;
        return save(result);
      }
      if (input.type === 'trial-observe') {
        requireConfirmed(input, observationKeys);
        const status = await runtime({ defaultDir: appDir });
        if (trial.state !== 'awaiting-observation' || !status.running || status.profileDir !== appDir || await readDesktopIdentity(appDir) !== trial.account) throw desktopError('選択した Desktop の起動とアカウントを確認できません');
        trial.observations.push({ account: trial.account, at: Date.now(), ...input.confirmations }); trial.state = 'ready';
        return save(trial);
      }
      requireConfirmed(input, acceptanceKeys);
      if (trial.observations.length !== 6 || trial.state !== 'ready' || await readDesktopIdentity(appDir) !== trial.origin) throw desktopError('同じビルドで3往復を確認してください');
      const previous = await readDesktopJson(path.join(dataDir, 'desktop-capabilities.json'));
      await lock.assertHeld();
      await write(path.join(dataDir, 'desktop-capabilities.json'), { ...previous, version: 1, builds: { ...previous?.builds, claude: currentBuilds.claude }, accountSwitch: { verified: true, trialId: trial.id, roundTrips: 3, relogins: 0, logouts: 0, ...input.confirmations, verifiedAt: Date.now() } });
      trial.state = 'complete'; return save(trial);
    } finally { await lock.release(); }
  }
  async function recover() {
    const paths = await locations(dataDir, appDir), state = await readDesktopJson(path.join(paths.state, 'setup.json'));
    if (state?.pendingCommand) return command(state.pendingCommand);
  }
  return { view, command, recover };
}

// Live updates, performance, machines, and launch settings.
import { hostsWithState } from '../board.mjs';
import { openExternal } from '../launcher.mjs';
import { perf } from '../perf.mjs';
import { appOnly, appAndModel, appTool } from './shared.mjs';

// leader is created after the tools and client is set by initialize: read both when called.
export function systemTools({ store, watch, live, getLeader, getClient }) {
  return [
  {
    name: 'canban_watch',
    title: '変更を待つ',
    description: 'ボードや開いているセッションに変化があるまで待ち、差分を返す（カンバン UI 用のロングポーリング）。',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: ['number', 'null'], description: '前回の seq。null で現在の seq だけ返す' },
        cardId: { type: ['string', 'null'], description: '詳細を開いているセッション（1 件のとき）' },
        offset: { type: ['number', 'null'], description: 'そのセッションのログの読み取り位置' },
        size: { type: ['number', 'null'], description: '前回見たログのサイズ' },
        codexItems: { type: 'boolean' },
        feeds: {
          type: 'array', maxItems: 8, description: '詳細を開いているセッションが複数あるとき。cardId / offset / size / codexItems の組',
          items: { type: 'object', properties: { cardId: { type: 'string' }, offset: { type: ['number', 'null'] }, size: { type: ['number', 'null'] }, codexItems: { type: 'boolean' } }, required: ['cardId'], additionalProperties: false },
        },
        timeoutMs: { type: 'number' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    _meta: appOnly,
    handler: async (args) => {
      if (!watch) return { text: 'live off', structured: { off: true } };
      const r = await watch(args);
      return { text: `seq ${r.seq}${r.reload ? ' reload' : ''} ${r.patches.length} patches${Object.keys(r.feeds || {}).length ? ` ${Object.values(r.feeds).reduce((n, f) => n + f.items.length, 0)} items` : ''}`, structured: r };
    },
  },
  {
    name: 'canban_get_perf',
    title: '動作の重さ',
    description: 'Canban 自身の処理時間（p50 / p95 / 予算）、イベントループ遅延、メモリ、背景処理のリーダーかどうかを返す（カンバン UI 用）',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    _meta: appOnly,
    handler: async () => {
      const leader = getLeader(), client = getClient();
      const p = perf.summary({ leader: leader.isLeader, leaderPid: await leader.owner(), client, live: live ? { active: live.active, seq: live.seq, ...live.counters } : null });
      return { text: `rss ${p.rssMB}MB, loop p99 ${p.loop?.p99 ?? '-'}ms, slow ${p.slow.length}`, structured: p };
    },
  },
  {
    name: 'canban_list_hosts',
    title: 'マシン一覧',
    description: 'このマシンと、Codex アプリに登録済みのリモート接続（SSH）の一覧と読み取り状態を返す。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    _meta: appAndModel,
    handler: async () => {
      const hosts = await hostsWithState((await store.load()));
      return {
        text: hosts.map((h) => `${h.id} ${h.label} ${h.enabled ? 'on' : 'off'} ${h.status.state}${h.status.error ? ` (${h.status.error})` : ''}`).join('\n') || 'リモート接続は登録されていません',
        structured: { hosts: hosts.map(({ sshArgs, ...h }) => h) },
      };
    },
  },
  appTool('canban_set_remote_host', 'リモート接続の読み取りを切り替え', { hostId: { type: 'string' }, enabled: { type: 'boolean' } }, ['hostId', 'enabled'], async (a) => {
    const hosts = await hostsWithState((await store.load()));
    if (!hosts.some((h) => h.id === a.hostId)) throw new Error('Codex に登録されていない接続です');
    return store.setRemoteHost(a);
  }),
  ];
}

export function settingsTools({ store }) {
  return [
  appTool('canban_update_settings', '再開方法の既定を変更', {
    route: { type: 'string', enum: ['desktop', 'terminal'] },
    terminal: { type: 'string', enum: ['ghostty', 'terminal', 'iterm'] },
    target: { type: 'string', enum: ['new-window', 'new-tab', 'split', 'current'] },
    linkBrowser: { type: 'string', enum: ['', 'chrome', 'safari'] },
    linkProfile: { type: 'string', maxLength: 40 },
  }, [], (a) => store.updateLaunchSettings(a)),
  appTool('canban_open_external', '設定したブラウザで URL を開く', { url: { type: 'string', maxLength: 2000 } }, ['url'],
    async ({ url }) => { await openExternal(url, (await store.load()).settings.launch); return { opened: true }; }),
  ];
}

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { executionContext } from './sqlite-client.mjs';
import { SlackStore } from './slack-store.mjs';
import { SLACK_CACHE_MS, slackKey, slackMessage, safeSlackUrl } from './slack-model.mjs';

const METHODS = new Set(['auth.test', 'conversations.list', 'conversations.history', 'conversations.replies', 'apps.connections.open']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export class SlackApi {
  constructor({ fetcher = fetch, now = Date.now } = {}) { this.fetcher = fetcher; this.now = now; this.cooldowns = new Map(); this.queue = Promise.resolve(); this.pending = 0; }
  async call(token, method, params = {}) {
    if (!METHODS.has(method)) throw new Error('Slackは読み取り専用です');
    if (this.pending >= 32) throw new Error('Slackの取得処理が混み合っています');
    this.pending++;
    const scope = crypto.createHash('sha256').update(token).digest('hex').slice(0,16) + ':' + method;
    const run = async () => {
      const until = this.cooldowns.get(scope) || 0;
      if (until > this.now()) throw new Error(`Slackの取得制限です。${Math.ceil((until-this.now())/1000)}秒後に再試行してください`);
      const response = await this.fetcher(`https://slack.com/api/${method}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
      if (response.status === 429) { this.cooldowns.set(scope, this.now() + Math.max(60, Number(response.headers.get('retry-after')) || 60)*1000); throw new Error('Slackの取得制限です。時間をおいて再試行してください'); }
      if (!response.ok) throw new Error(`Slackへの接続に失敗しました（HTTP ${response.status}）`);
      const result = await response.json();
      if (!result.ok) throw new Error(`Slack: ${String(result.error || '取得失敗').replace(/[^a-z_0-9]/gi, '').slice(0,80)}`);
      return result;
    };
    // All requests share a bounded serial lane; no bursts per channel or message.
    const result = this.queue.then(run);
    this.queue = result.catch(() => {}).then(() => delay(300));
    try { return await result; } finally { this.pending--; }
  }
}

export class SlackService {
  constructor(store, { api = new SlackApi(), Socket = globalThis.WebSocket } = {}) {
    this.board = store; this.db = new SlackStore(store.dir); this.api = api; this.Socket = Socket;
    this.sockets = new Map(); this.socketTeams = new Map(); this.attempts = new Map(); this.loading = new Map(); this.stopped = false; this.generation = 0; this.eventQueue = Promise.resolve(); this.pendingEvents = 0;
    this.credentialsFile = path.join(store.dir, 'slack', 'credentials.json');
  }
  async credentials() { try { return JSON.parse(await fs.readFile(this.credentialsFile, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw new Error('Slack認証情報を読み込めません'); } }
  async saveCredentials(team, value) {
    const dir = path.dirname(this.credentialsFile); await fs.mkdir(dir, { recursive: true, mode: 0o700 }); await fs.chmod(dir,0o700);
    const lock = path.join(dir, 'credentials.lock'); let handle;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { handle = await fs.open(lock, 'wx', 0o600); break; } catch (e) { if (e.code !== 'EEXIST') throw e;
        try { const stat = await fs.stat(lock); if (Date.now() - stat.mtimeMs > 30000) {
          const pid = Number(await fs.readFile(lock,'utf8')); let alive = false;
          if (pid > 0) { try { process.kill(pid,0); alive = true; } catch (error) { alive = error.code !== 'ESRCH'; } }
          if (!alive) await fs.rm(lock,{force:true});
        } } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await delay(100); }
    }
    if (!handle) throw new Error('Slack認証情報の保存処理が実行中です');
    const temp = `${this.credentialsFile}.${crypto.randomUUID()}.tmp`;
    try { await handle.writeFile(String(process.pid)); const values = await this.credentials(); if (value) values[team] = value; else delete values[team]; await fs.writeFile(temp, JSON.stringify(values), { mode: 0o600 }); await fs.rename(temp, this.credentialsFile); }
    finally { await handle.close(); await fs.rm(lock, { force: true }); await fs.rm(temp, { force: true }); }
  }
  async connect({ userToken, appToken }) {
    if (!/^(xoxp-|xoxe\.xoxp-)[\w.-]+$/.test(userToken || '') || !/^xapp-[\w.-]+$/.test(appToken || '')) throw new Error('ユーザートークンとSocket Mode用のAppトークンを確認してください');
    const auth = await this.api.call(userToken, 'auth.test');
    if (auth.bot_id || !/^[A-Z0-9]+$/.test(auth.team_id || '') || !auth.user_id) throw new Error('本人のユーザートークンを指定してください');
    // Validate the app token without exposing its short-lived WebSocket URL to the board.
    await this.api.call(appToken, 'apps.connections.open');
    await this.saveCredentials(auth.team_id, { userToken, appToken });
    await this.db.saveWorkspace({ id: auth.team_id, name: String(auth.team || auth.team_id).slice(0,200), userId: auth.user_id, url: safeSlackUrl(auth.url) });
    await this.db.status(auth.team_id, { state: '待機', at: Date.now(), incomplete: true });
    await this.tick(); return this.db.view();
  }
  async disconnect({ workspaceId }) { await this.saveCredentials(workspaceId, null); this.config = await this.db.removeWorkspace(workspaceId); this.closeSockets(); this.attempts.clear(); await this.tick(); return this.db.view(); }
  async listChannels({ workspaceId, cursor = '' }) {
    const credential = (await this.credentials())[workspaceId]; if (!credential) throw new Error('Slack接続が見つかりません');
    const result = await this.api.call(credential.userToken, 'conversations.list', { types: 'public_channel,private_channel,im,mpim', exclude_archived: 'true', limit: '100', cursor });
    return { channels: (result.channels || []).map(c => ({ id: c.id, name: c.name || (c.is_im ? `DM · ${c.user}` : c.id) })), cursor: result.response_metadata?.next_cursor || '' };
  }
  async selectChannels(args) { this.config = await this.db.selectChannels(args); await this.tick(); return this.db.view(); }
  async history({ workspaceId, channelId, more = false, threadTs = null, cursor = '' }) {
    const tag = `${workspaceId}:${channelId}:${threadTs || ''}:${more}:${cursor}`;
    if (this.loading.has(tag)) return this.loading.get(tag);
    const operation = this.historyInner({ workspaceId, channelId, more, threadTs, cursor });
    this.loading.set(tag, operation); try { return await operation; } finally { this.loading.delete(tag); }
  }
  async historyInner({ workspaceId, channelId, more, threadTs, cursor }) {
    const { workspaces } = await this.db.getConfig(), workspace = workspaces.find(w => w.id === workspaceId), channel = workspace?.channels.find(c => c.id === channelId);
    if (!channel) throw new Error('読む会話を接続設定から選択してください');
    const credential = (await this.credentials())[workspaceId]; if (!credential) throw new Error('Slack認証情報を確認してください');
    const previous = await this.db.cachedMeta(workspaceId, channelId);
    if (more && !threadTs && !previous?.cursor) return this.db.view();
    const result = await this.api.call(credential.userToken, threadTs ? 'conversations.replies' : 'conversations.history', { channel: channelId, limit: '100', ...(threadTs ? { ts: threadTs } : {}), ...((threadTs ? cursor : more && previous?.cursor) ? { cursor: threadTs ? cursor : previous.cursor } : {}) });
    const latest = await this.db.getConfig();
    if (!latest.workspaces.find(w => w.id === workspaceId)?.channels.some(c => c.id === channelId) || (await this.credentials())[workspaceId]?.userToken !== credential.userToken) throw new Error('Slack接続設定が変わりました。再取得してください');
    const messages = (result.messages || []).filter(m => m.ts).map(m => slackMessage(workspace, channel, m));
    await this.db.cache({ team: workspaceId, channel: channelId, messages, cursor: threadTs ? previous?.cursor || '' : result.response_metadata?.next_cursor || '', append: more || !!threadTs, thread: !!threadTs });
    const cached = threadTs ? await this.db.cached(workspaceId, channelId) : null;
    const refs = threadTs ? await this.db.refs(messages.map(m => m.key)) : null;
    return threadTs ? { messages: messages.map(m => ({ ...(cached?.messages.find(c => c.key === m.key) || m), refs: refs[m.key] || [] })), cursor: result.response_metadata?.next_cursor || '' } : this.db.view({workspaceId,channelId});
  }
  async start(leader) {
    this.leader = leader;
    this.tick().catch(() => {});
    // One lightweight configuration check, no network polling; idle installations do no Slack I/O.
    this.timer = setInterval(() => this.tick().catch(() => {}), 30000); this.timer.unref();
  }
  async tick() {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      if (!this.leader?.isLeader) { this.closeSockets(); return; }
      await this.leader.run(async () => {
        const value = await this.db.getConfig(); this.config = value; if (!value.workspaces.length) return;
        const credentials = await this.credentials();
        const teamsBySocket = new Map();
        for (const workspace of value.workspaces) { const credential = credentials[workspace.id]; if (!credential) continue;
          const id = crypto.createHash('sha256').update(credential.appToken).digest('hex');
          if (!teamsBySocket.has(id)) teamsBySocket.set(id, []); teamsBySocket.get(id).push(workspace.id);
        }
        this.socketTeams = teamsBySocket;
        const active = new Set();
        let initialFetches = 0;
        for (const workspace of value.workspaces) {
          const credential = credentials[workspace.id]; if (!credential) continue;
          const id = crypto.createHash('sha256').update(credential.appToken).digest('hex'); active.add(id);
          if (this.sockets.get(id)?.readyState === 1 && (await this.db.connectionStatus(workspace.id))?.state !== '接続中') await this.db.status(workspace.id, { state: '接続中', at: Date.now(), incomplete: true });
          if (!this.sockets.has(id) && (this.attempts.get(id) || 0) <= Date.now()) {
            this.attempts.set(id, Date.now() + 60000);
            try { await this.openSocket(id, credential.appToken); }
            catch { await this.db.status(workspace.id, { state: '接続待ち', at: Date.now(), incomplete: true }); }
          }
          // At most two missing/expired caches per tick. Refresh only every six hours.
          for (const channel of workspace.channels) {
            if (initialFetches >= 2) break;
            const cache = await this.db.cachedMeta(workspace.id, channel.id);
            if (cache?.at > Date.now() - SLACK_CACHE_MS) continue;
            initialFetches++;
            try { await this.history({ workspaceId: workspace.id, channelId: channel.id }); }
            catch { break; }
          }
        }
        for (const [id, socket] of this.sockets) if (!active.has(id)) { socket.close(); this.sockets.delete(id); }
      });
    } finally { this.ticking = false; }
  }
  async openSocket(id, token) {
    const generation = this.generation, fence = this.leader.token;
    const result = await this.api.call(token, 'apps.connections.open');
    if (this.stopped || !this.leader.isLeader || generation !== this.generation) return;
    const url = new URL(result.url); if (url.protocol !== 'wss:' || !url.hostname.endsWith('.slack.com')) throw new Error('Slack接続先が不正です');
    const teams = Object.entries(await this.credentials()).filter(([, c]) => c.appToken === token).map(([team]) => team);
    const socket = new this.Socket(url.href); this.sockets.set(id, socket);
    const current = () => !this.stopped && this.leader.isLeader && generation === this.generation && this.sockets.get(id) === socket;
    const status = state => executionContext.run(fence, async () => {
      if (!current()) return;
      for (const team of this.socketTeams.get(id) || teams) await this.db.status(team, { state, at: Date.now(), incomplete: true });
    }).catch(() => {});
    socket.addEventListener('open', () => status('接続中'));
    const disconnected = (retryMs = 60000) => {
      if (!current()) return;
      status('接続待ち');
      this.sockets.delete(id); this.attempts.set(id, Date.now() + retryMs); socket.close();
    };
    socket.addEventListener('message', event => {
      if (!current()) return;
      let envelope; try { envelope = JSON.parse(event.data); } catch { return; }
      if (envelope.type === 'disconnect') { disconnected(5000); return; }
      if (envelope.type !== 'events_api') { if (envelope.envelope_id) socket.send(JSON.stringify({ envelope_id: envelope.envelope_id })); return; }
      // Bounded serial persistence; ACK only after success so failed writes can be retried.
      if (this.pendingEvents >= 128) { disconnected(); return; }
      this.pendingEvents++;
      const operation = this.eventQueue.then(() => executionContext.run(fence, async () => {
        if (!current()) return;
        if ((this.socketTeams.get(id) || teams).includes(envelope.payload?.team_id)) await this.receive(envelope.payload);
        if (current() && envelope.envelope_id) socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      }));
      this.eventQueue = operation.catch(() => disconnected()).finally(() => { this.pendingEvents--; });
    });
    socket.addEventListener('close', () => disconnected());
    socket.addEventListener('error', () => disconnected());
  }
  async receive(payload) {
    const event = payload?.event; if (event?.type !== 'message' || !event.channel) return;
    const value = this.config || await this.db.getConfig(), workspace = value.workspaces.find(w => w.id === payload.team_id); if (!workspace) return;
    let channel = workspace.channels.find(c => c.id === event.channel);
    if (!channel) {
      const ts = event.deleted_ts || event.message?.ts || event.ts;
      if (!ts) return;
      const existing = await this.db.tracked(slackKey(workspace.id, event.channel, ts));
      if (existing) channel = { id: existing.channel, name: existing.channelName };
    }
    if (!channel) return;
    let message;
    if (event.subtype === 'message_deleted') {
      const key = slackKey(workspace.id, event.channel, event.deleted_ts);
      message = { key, team: workspace.id, channel: event.channel, ts: event.deleted_ts, deleted: true };
    } else if (event.subtype === 'message_changed') message = slackMessage(workspace, channel, event.message);
    else if (!event.subtype || ['bot_message', 'file_share', 'thread_broadcast'].includes(event.subtype)) message = slackMessage(workspace, channel, event);
    if (message) await this.db.observe({ message, reason: message.deleted ? '削除' : event.subtype === 'message_changed' ? '編集' : '受信', eventAt: event.event_ts || null });
  }
  closeSockets() { this.generation++; for (const socket of this.sockets.values()) socket.close(); this.sockets.clear(); }
  stop() { this.stopped = true; clearInterval(this.timer); this.closeSockets(); }
}

export function slackTools({ service, store, appTool, validateCard }) {
  const text = { type: 'string' };
  return [
    appTool('canban_slack_view', 'Slackタイムラインを取得', { workspaceId: text, channelId: text }, [], a => service.db.view(a)),
    appTool('canban_slack_connect', '個人用Slackを接続', { userToken: text, appToken: text }, ['userToken', 'appToken'], a => service.connect(a)),
    appTool('canban_slack_disconnect', 'Slack接続を解除', { workspaceId: text }, ['workspaceId'], a => service.disconnect(a)),
    appTool('canban_slack_channels', 'Slackの会話を取得', { workspaceId: text, cursor: text }, ['workspaceId'], a => service.listChannels(a)),
    appTool('canban_slack_select', '読むSlackの会話を保存', { workspaceId: text, channels: { type: 'array', maxItems: 100, items: { type: 'object', properties: { id: text, name: text, directory: text }, required: ['id', 'name'], additionalProperties: false } } }, ['workspaceId', 'channels'], a => service.selectChannels(a)),
    appTool('canban_slack_history', 'Slackの本文・返信を取得', { workspaceId: text, channelId: text, more: { type: 'boolean' }, threadTs: text, cursor: text }, ['workspaceId', 'channelId'], a => service.history(a)),
    appTool('canban_slack_sources', 'カードのSlack資料を取得', { cardId: text }, ['cardId'], async a => ({ sources: await service.db.sources(a.cardId) })),
    appTool('canban_slack_revisions', 'Slack資料の履歴を取得', { key: text, before: { type: 'integer', minimum: 1 } }, ['key'], a => service.db.revisions(a)),
    appTool('canban_slack_link', 'Slackメッセージをカードに追加', { cardId: text, key: text }, ['cardId', 'key'], async a => { const sourceTitle = await validateCard(a.cardId); return store.linkSlack({ ...a, sourceTitle }); }),
    appTool('canban_slack_unlink', 'カードのSlack資料を外す', { cardId: text, key: text }, ['cardId', 'key'], a => store.unlinkSlack(a)),
    appTool('canban_slack_retained', '保存したSlack履歴を取得', {}, [], async () => ({ sources: await service.db.retained() })),
    appTool('canban_slack_forget', '紐づけのないSlack履歴を削除', { key: text }, ['key'], a => service.db.forget(a.key)),
  ];
}

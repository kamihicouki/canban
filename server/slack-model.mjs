import crypto from 'node:crypto';

export const SLACK_CACHE_MS = 6 * 60 * 60 * 1000;
export const slackKey = (team, channel, ts) => {
  if (!/^[A-Z0-9]{1,64}$/.test(team || '') || !/^[A-Z0-9]{1,64}$/.test(channel || '') || !/^\d{10,16}\.\d{1,6}$/.test(ts || '')) throw new Error('Slackメッセージの識別情報が不正です');
  return `${team}:${channel}:${ts}`;
};
export const safeSlackUrl = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && (url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com')) ? url.href : null; } catch { return null; }
};
export function slackMessage(workspace, channel, message) {
  const key = slackKey(workspace.id, channel.id, message.ts);
  const text = String(message.text || '').slice(0, 40000).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const files = (message.files || []).slice(0, 20).map(file => ({ name: String(file.title || file.name || '添付ファイル').slice(0, 300), url: safeSlackUrl(file.permalink) })).filter(f => f.url);
  const base = safeSlackUrl(workspace.url) || 'https://app.slack.com/';
  return { key, team: workspace.id, workspace: workspace.name, channel: channel.id, channelName: channel.name,
    broadcast: message.subtype === 'thread_broadcast', ts: message.ts, threadTs: message.thread_ts || message.ts, replies: Math.max(0, Number(message.reply_count) || 0),
    author: String(message.user || message.username || message.bot_id || 'Slack').slice(0, 200), text, files,
    url: new URL(`archives/${channel.id}/p${message.ts.replace('.', '')}`, base).href,
    editedAt: message.edited?.ts || null, deleted: false, observedAt: Date.now() };
}
// Token shapes and Slack error codes in words a person can act on. The board mirrors the shape check while typing.
export function slackTokenProblem(kind, value) {
  const v = String(value || '').trim();
  if (!v) return kind === 'user' ? 'ユーザートークン（xoxp-）を貼ってください' : 'Appトークン（xapp-）を貼ってください';
  if (kind === 'user') {
    if (/^xoxb-/.test(v)) return 'これはBotトークン（xoxb-）です。「OAuth & Permissions」の「User OAuth Token」（xoxp-）を貼ってください';
    if (/^xapp-/.test(v)) return 'これはAppトークンです。下の「Appトークン」欄に貼ってください';
    if (!/^(xoxp-|xoxe\.xoxp-)[\w.-]+$/.test(v)) return 'ユーザートークンは xoxp- で始まります。「OAuth & Permissions」の「User OAuth Token」をコピーしてください';
  } else {
    if (/^(xoxp-|xoxe\.xoxp-|xoxb-)/.test(v)) return 'これはOAuthトークンです。「Basic Information」の「App-Level Tokens」で作る xapp- の値を貼ってください';
    if (!/^xapp-[\w.-]+$/.test(v)) return 'Appトークンは xapp- で始まります。「Basic Information」→「App-Level Tokens」で作成してください';
  }
  return null;
}
const SLACK_ERROR_HINTS = {
  invalid_auth: 'トークンが正しくありません。コピーし直してください',
  not_authed: 'トークンが空です',
  token_revoked: 'トークンが無効化されています。Slackで作り直してください',
  token_expired: 'トークンの期限が切れています。Slackで作り直してください',
  account_inactive: 'このアカウントまたはアプリは無効になっています',
  missing_scope: '権限が足りません。アプリの設定を確認して、ワークスペースへ再インストールしてください',
  not_allowed_token_type: 'トークンの種類が違います',
  invalid_token: 'トークンが正しくありません。コピーし直してください',
  ratelimited: 'Slackの取得制限です。時間をおいて再試行してください',
  team_access_not_granted: 'このワークスペースへのアクセスが許可されていません',
};
export const slackErrorText = code => {
  const safe = String(code || '').replace(/[^a-z_0-9]/gi, '').slice(0, 80);
  return SLACK_ERROR_HINTS[safe] ? `${SLACK_ERROR_HINTS[safe]}（${safe}）` : safe || '取得失敗';
};
export const slackDigest = message => crypto.createHash('sha256').update(JSON.stringify([message.text, message.files, message.deleted])).digest('hex');

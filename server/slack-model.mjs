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
export const slackDigest = message => crypto.createHash('sha256').update(JSON.stringify([message.text, message.files, message.deleted])).digest('hex');

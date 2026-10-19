import path from 'node:path';

export function projectName(cwd) {
  if (!cwd) return null;
  const clean = String(cwd).replace(/^file:\/\//, '').replace(/\/+$/, '');
  // Worktrees such as ~/.codex/worktrees/<id>/<repo> or .claude/worktrees/<name> -> repo name
  const wt = /\/\.(?:codex|claude)\/worktrees\/[^/]+\/([^/]+)/.exec(clean);
  if (wt) return wt[1];
  const cwt = /^(.*)\/\.claude\/worktrees\/[^/]+$/.exec(clean);
  if (cwt) return path.basename(cwt[1]);
  return path.basename(clean) || clean;
}

export function clip(s, n) {
  if (!s) return '';
  s = String(s);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function questionReplyText(t) {
  // Desktop question replies arrive as a user message, wrapped for transport.
  // Decode only a complete, recognized envelope; never drop an unknown answer.
  const reply = /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/.exec(t);
  if (!reply) return null;
  try {
    const entries = JSON.parse(reply[1]);
    if (Array.isArray(entries) && entries.length && entries.every(e => e &&
      typeof e.question === 'string' && e.question.trim() && typeof e.answer === 'string')) {
      return entries.map(e => `質問: ${e.question}\n\n回答: ${e.answer}`).join('\n\n');
    }
  } catch { /* Preserve malformed transport as the original text. */ }
  return t;
}

function stripPromptContext(t) {
  t = t.replace(/<(system-reminder|recommended_plugins|app-context|environment_context|user_instructions|command-message|local-command-stdout|local-command-caveat)[^>]*>[\s\S]*?<\/\1>/g, '');
  t = t.replace(/<command-name>([\s\S]*?)<\/command-name>/g, '$1');
  t = t.replace(/<command-args>([\s\S]*?)<\/command-args>/g, ' $1');
  return t;
}

// Strip injected context blocks (system reminders, command wrappers) from a user prompt.
export function cleanPrompt(s) {
  if (!s) return '';
  const t = String(s).trim();
  const envelope = /<send_user_message_question_reply>[\s\S]*<\/send_user_message_question_reply>/.exec(t);
  // Strip only outside the envelope: tags in question/answer strings are literal text.
  if (envelope && !stripPromptContext(t.slice(0, envelope.index)).trim() &&
    !stripPromptContext(t.slice(envelope.index + envelope[0].length)).trim()) {
    return questionReplyText(envelope[0]);
  }
  return stripPromptContext(t).trim();
}

export function firstLine(s) {
  if (!s) return '';
  return String(s).split('\n').map((l) => l.trim()).find(Boolean) || '';
}

// Where a session lives. Local sessions keep the v0.1 card ids (`codex:<id>`) so
// existing boards stay valid; remote ones are namespaced by SSH alias.
export const LOCAL_HOST = Object.freeze({ id: 'local', alias: null, label: 'このマシン', local: true });

export function sessionKey(agent, host, nativeId) {
  return host?.local === false ? `${agent}@${host.alias}:${nativeId}` : `${agent}:${nativeId}`;
}

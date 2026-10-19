// Shared pieces of the MCP tool definitions: visibility metadata, board filters, and small helpers.
import { accountFilterProp } from '../accounts-mcp.mjs';
import { sourceSelectionSchema } from '../category-bindings.mjs';

export const appOnly = { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true, 'openai/visibility': 'private' };
export const appAndModel = { ui: { visibility: ['model', 'app'] }, 'openai/widgetAccessible': true };

export const filterProps = {
  workingFolder: { type: 'string', description: '作業フォルダの絶対パス。追加のWorkingLocationとTaskの明示絶対パス予定も検索。旧folderは文脈優先条件を維持' },
  sourceFilters: sourceSelectionSchema,
  cardKind: { type: 'string', enum: ['all', 'task', 'session'] },
  agent: { type: 'string', enum: ['all', 'codex', 'claude'], description: 'AI App（codex / claude）で絞り込み' },
  host: { type: 'string', description: "マシンで絞り込み（'local' またはリモート接続の hostId）" },
  account: accountFilterProp,
  project: { type: 'string', description: 'プロジェクトで絞り込み（Codex のプロジェクト名。Codex のプロジェクトに入っていないセッションは作業フォルダ名）' },
  folder: { type: 'string', description: '作業フォルダ名（cwd の末尾）で絞り込み' },
  section: { type: 'string', description: "Codex のセクション ID で絞り込み。'__none' でセクションなし" },
  directory: { type: 'string', description: "Canban のカテゴリ（ユーザーが作る、1 枚に 1 つのまとまり。API 上の名前は directory）の ID で絞り込み。'__none' でカテゴリなし" },
  label: { type: 'string', description: "ラベル IDで絞り込み。'__none' でラベルなし" },
  status: { type: 'string', enum: ['running', 'waiting', 'completed', 'aborted', 'idle'], description: '実行状態で絞り込み' },
  q: { type: 'string', description: 'タイトル・最初の依頼・メモ・ラベルの部分一致検索' },
  includeArchived: { type: 'boolean' },
  includeSubagents: { type: 'boolean' },
  dotScope: { type: 'string', enum: ['exclude', 'all', 'only'], description: 'dotのセッション: 除く（既定）／含める／dotだけ' },
  pinnedOnly: { type: 'boolean', description: 'Codex アプリでピン留めしたスレッドだけ' },
  groupBranch: { type: 'boolean', description: '同じリポジトリ＋ブランチのセッションをまとめる' },
  fulltext: { type: 'boolean', description: 'q を会話の本文でも検索する（3 文字以上）' },
  days: { type: 'number', description: '未配置セッションの表示期間（日）。0 で無制限。既定 30' },
};


// Requests as returned to the UI / model (the prompt is kept; log paths only locally).
export function requestView(r) {
  if (!r) return null;
  const { owner, ownerUuid, leaseGeneration, argv, ...rest } = r;
  return { ...rest, logPath: r.hostId === 'local' ? r.logPath ?? null : null };
}

export function appTool(name, title, properties, required, fn) {
  return {
    name,
    title,
    description: `${title}（カンバン UI 用）`,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    _meta: appOnly,
    handler: async (args) => ({ text: `${title}: OK`, structured: { result: await fn(args) } }),
  };
}

export function resolveList(lists, key) {
  if (!key) return null;
  const k = String(key).trim();
  return lists.find((l) => l.id === k) || lists.find((l) => l.title === k) || lists.find((l) => l.title.toLowerCase() === k.toLowerCase()) || null;
}

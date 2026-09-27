// Shared fixtures: a fake ~/.codex, ~/.claude and Claude desktop metadata tree.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const line = (o) => `${JSON.stringify(o)}\n`;
const item = (ts, it) => line({ timestamp: ts, type: 'event_msg', payload: { type: 'item_completed', item: it } });

export function makeFixtures() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canban-fx-'));
  const codexHome = path.join(root, 'codex');
  const claudeHome = path.join(root, 'claude');
  const desktopDir = path.join(root, 'desktop');

  // Codex: state DB + one rollout file
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
  const rollout = path.join(codexHome, 'sessions', 'rollout-a.jsonl');
  fs.writeFileSync(
    rollout,
    line({ timestamp: '2026-09-20T00:00:00Z', type: 'session_meta', payload: { id: 't1' } }) +
      item('2026-09-20T00:00:01Z', { type: 'UserMessage', content: [{ type: 'text', text: 'ログインを直して' }] }) +
      item('2026-09-20T00:00:02Z', { type: 'AgentMessage', phase: 'commentary', content: [{ type: 'Text', text: '調べます' }] }) +
      item('2026-09-20T00:00:03Z', { type: 'AgentMessage', phase: 'final', content: [{ type: 'Text', text: '直しました' }] }),
  );
  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, updated_at_ms INTEGER,
    source TEXT, thread_source TEXT, cwd TEXT, title TEXT, name TEXT, archived INTEGER, git_branch TEXT, model TEXT,
    first_user_message TEXT, preview TEXT, agent_role TEXT, is_pinned INTEGER)`);
  const ins = db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  ins.run('t1', rollout, 1790000000, 1790000100, 1790000100123, 'vscode', 'user', '/Users/x/.codex/worktrees/0346/demo-app', 'ログインを直して', 'ログイン修正', 0, 'fix/login', 'gpt-6-sol', 'ログインを直して', '', null, 1);
  ins.run('t2', '', 1790000000, 1790000000, null, '{"subagent":{"other":"guardian"}}', 'subagent', '/r/app', 'review', null, 0, null, null, '', '', 'guardian', 0);
  ins.run('t3', '', 1790000000, 1790000000, null, 'cli', null, '/r/app', '<system-reminder>x</system-reminder>\n調査', null, 1, null, null, '', '', null, 0);
  db.close();

  // Codex app state: t1 is pinned in the Codex app
  fs.writeFileSync(path.join(codexHome, '.codex-global-state.json'), JSON.stringify({ 'pinned-thread-ids': ['t1'] }));

  // Claude Code: two transcripts
  const proj = path.join(claudeHome, 'projects', '-r-web');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, 'c1.jsonl'),
    line({ type: 'user', cwd: '/r/web', gitBranch: 'main', entrypoint: 'claude-desktop', timestamp: '2026-09-21T00:00:00Z', message: { role: 'user', content: 'トップページを速くして' } }) +
      line({ type: 'assistant', timestamp: '2026-09-21T00:00:05.250Z', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }, content: [{ type: 'text', text: '計測します' }] } }) +
      line({ type: 'user', timestamp: '2026-09-21T00:00:06Z', message: { content: [{ type: 'tool_result', content: 'x' }] } }) +
      line({ type: 'custom-title', customTitle: 'トップページ高速化', sessionId: 'c1' }) +
      line({ type: 'pr-link', prUrl: 'https://github.com/o/r/pull/1', sessionId: 'c1' }),
  );
  fs.writeFileSync(
    path.join(proj, 'c2.jsonl'),
    line({ type: 'user', cwd: '/r/web', timestamp: '2026-09-22T00:00:00Z', message: { content: [{ type: 'text', text: '<system-reminder>ctx</system-reminder>' }] } }) +
      line({ type: 'user', timestamp: '2026-09-22T00:00:01Z', message: { content: 'README を直して' } }),
  );

  // Claude desktop metadata: c1 archived (no desktop id), c2 live with a desktop id
  fs.mkdirSync(path.join(desktopDir, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(desktopDir, 'a', 'b', 'local_1.json'), JSON.stringify({ cliSessionId: 'c1', title: 'desk', isArchived: true, lastActivityAt: '1790500000000' }));
  fs.writeFileSync(path.join(desktopDir, 'a', 'b', 'local_2.json'), JSON.stringify({ sessionId: 'local_abc-123', cliSessionId: 'c2', title: 'README 修正', isArchived: false, lastActivityAt: '1790600000000' }));

  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const chmodTree = (dir, fileMode, dirMode) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) chmodTree(p, fileMode, dirMode);
      else fs.chmodSync(p, fileMode);
    }
    fs.chmodSync(dir, dirMode);
  };
  return {
    root,
    codexHome,
    claudeHome,
    desktopDir,
    rollout,
    snapshot: () => Object.fromEntries(walk(root).map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')])),
    lock: () => chmodTree(root, 0o444, 0o555),
    cleanup: () => {
      chmodTree(root, 0o644, 0o755);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function dotFixture(now = Date.now()) {
  const profile = { id: 'dot-demo~account-demo', display_name: '制作係', aeon_kind: 'orbit', active_root_thread_id: 'dot-root' };
  const rows = [
    ['dot-root', 'aeon', true], ['dot-created', 'aeon_child', true], ['dot-related', 'user', true],
    ['dot-hidden', 'aeon_child', false], ['dot-dream', 'dreaming', true], ['dot-sub', 'subagent', true],
  ];
  return { 'electron-persisted-atom-state': { 'cloud-aeon-sidebar-cache-v1': {
    accountId: 'demo-account', hostId: 'durable', refreshStartedAtMs: now,
    profilesByThreadId: Object.fromEntries(rows.map(([id]) => [id, profile])),
    attachments: rows.map(([id, , visible]) => ({ thread_id: id, parent_thread_id: id === 'dot-root' ? null : 'dot-root', is_user_visible: visible })),
    threads: rows.map(([id, threadSource]) => ({ id, name: { 'dot-created': 'dotが調べた予約ページ', 'dot-related': 'dotと関連する資料確認', 'dot-sub': 'dotの子エージェント' }[id] || id,
      threadSource, createdAt: Math.floor(now / 1000) - 100, updatedAt: Math.floor(now / 1000), status: { type: 'notLoaded' },
      cwd: '/cloud/never-local', path: '/cloud/never-read', preview: '保存済みの要約です', model: 'gpt-6-sol', turns: [] })),
  } } };
}

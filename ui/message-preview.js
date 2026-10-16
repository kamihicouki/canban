// Part of board.html: included into its script by server/ui.mjs and shares its scope.
// What the person wrote, without what the app attached to it. テキスト shows the message as sent;
// プレビュー and 要点 show the words, and each attached block (window hints, editor selection…)
// as a small chip that opens to its raw text.
const promptPreviewModel = (() => {
  const LABELS = {
    cu_window_hints: '指した画面', ide_selection: 'エディタの選択', ide_opened_file: '開いていたファイル', ide_diagnostics: 'エディタの診断',
    'system-reminder': 'システムの補足', environment_context: '環境', user_instructions: '指示ファイル', 'app-context': 'アプリの状態',
    'local-command-stdout': 'コマンドの出力', 'local-command-caveat': 'コマンドの注意', 'command-message': 'コマンド', recommended_plugins: 'おすすめのプラグイン',
  };
  // Only machine-looking names (snake_case or kebab-case) count; <b> or <div> typed by a person stay text.
  const BLOCK = /<([a-z][a-z0-9]*(?:[_-][a-z0-9]+)+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  function detail(tag, body) {
    const window = tag === 'cu_window_hints' && /window\s+"([^"]+)"/.exec(body);
    return window ? window[1] : '';
  }
  function parse(text) {
    const blocks = [];
    const body = String(text || '').replace(BLOCK, (all, tag, inner) => {
      // Slash commands read as the command itself.
      if (tag === 'command-name') return inner.trim();
      if (tag === 'command-args') return ` ${inner.trim()}`;
      blocks.push({ tag, label: LABELS[tag] || tag.replace(/[_-]+/g, ' '), detail: detail(tag, inner), text: inner.trim() });
      return '';
    }).replace(/\n{3,}/g, '\n\n').trim();
    return { body, blocks };
  }
  return { parse };
})();

function userMessageView(text) {
  const { body, blocks } = promptPreviewModel.parse(text);
  return h('div', { class: 'md' },
    body ? h('div', { class: 'md-body', html: mdHtml(body) }) : null,
    blocks.length ? h('div', { class: 'msg-context' }, ...blocks.map(b => h('details', { class: 'msg-ctx' },
      h('summary', { title: `<${b.tag}>` }, h('span', { html: picon(b.tag === 'cu_window_hints' ? 'panel' : 'at', 12) }), h('span', { text: b.detail ? `${b.label}: ${b.detail}` : b.label })),
      h('pre', { text: b.text })))) : null);
}

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

// The options an agent ends its turn with (「A（推奨）: … / B: … どちらにしますか」), as answers to put in the input.
// Only the last list counts, and only when a question follows it, so step lists and summaries are left alone.
const choiceModel = (() => {
  const ITEM = /^\s*(?:[-*]|(\d{1,2})[.)])\s+(.*)$/;
  // **A（推奨）**: … / A) … / (A) … / 案A: … — a letter label first, then its text.
  const LETTER = /^(?:\*\*)?\s*(?:案\s*)?[(（]?([A-H])[)）]?(?=[\s（(*:：.)）]|$)\s*([（(][^）)]*[）)])?\s*(?:\*\*)?\s*[:：.)]?\s*(.*)$/;
  const ASKS = /[？?]|どちら|どれ|どの|選んで|選択|教えて/;
  const YES_NO = /(よい|いい|良い|しますか|進めますか|かまいませんか|構いませんか|okですか)[^。？?]*[？?]\s*$/i;
  const OPEN = /どちら|どれ|どの|何|なに|どこ|いつ|どう|誰|なぜ/;
  const plain = (s) => s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim();
  const short = (s, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  function parse(text) {
    const lines = String(text || '').replace(/```[\s\S]*?```/g, '').split('\n');
    let block = null, tail = [];
    for (const line of lines) {
      const m = ITEM.exec(line);
      if (m) {
        if (!block || tail.some((l) => l.trim())) { block = []; tail = []; }
        block.push({ n: m[1], body: m[2] });
      } else if (block && /^\s{2,}\S/.test(line) && !tail.some((l) => l.trim())) block.at(-1).body += ` ${line.trim()}`; // a wrapped item
      else tail.push(line);
    }
    const after = tail.join('\n').trim();
    if (block && block.length >= 2 && block.length <= 8 && ASKS.test(after)) {
      const letters = block.map((it) => LETTER.exec(it.body));
      if (letters.every(Boolean) && new Set(letters.map((m) => m[1])).size === block.length) {
        return letters.map((m) => {
          const note = m[2] || '', rest = plain(m[3] || '');
          return { key: m[1], title: short(rest.split(/[。:：]/)[0] || rest), recommended: /推奨|おすすめ|recommend/i.test(note + rest), reply: `${m[1]}でお願いします。` };
        });
      }
      if (block.every((it) => it.n)) {
        return block.map((it) => {
          const title = short(plain(it.body).split(/[。:：]/)[0]);
          return { key: it.n, title, recommended: /推奨|おすすめ|recommend/i.test(it.body), reply: `${it.n}（${title}）でお願いします。` };
        });
      }
    }
    // A plain yes / no question at the very end.
    const last = String(text || '').trim().split('\n').filter((l) => l.trim()).at(-1) || '';
    if (YES_NO.test(last) && !OPEN.test(last)) {
      return [{ key: '1', title: 'はい', recommended: false, reply: 'はい。' },
        { key: '2', title: 'いいえ', recommended: false, reply: 'いいえ。' }];
    }
    return [];
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

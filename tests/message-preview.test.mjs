import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const { promptPreviewModel, choiceModel } = vm.runInNewContext(fs.readFileSync(new URL('../ui/message-preview.js', import.meta.url), 'utf8') + '\n({ promptPreviewModel, choiceModel })');
const plain = (v) => JSON.parse(JSON.stringify(v));

test('lettered options before a question become answers, the recommended one marked', () => {
  const said = [
    '手順 1 には規約への同意が含まれます。2 つの進め方があります。', '',
    '- **A（推奨）**：あなたに、規約への同意と「Messaging API を利用する」ボタンの押下をお願いします。押したら教えてください。',
    '- **B**：「同意して進めてよい」と明示してください。その場合は、私が同意して押します。', '',
    'どちらにしますか。',
  ].join('\n');
  const choices = plain(choiceModel.parse(said));
  assert.deepEqual(choices.map((c) => [c.key, c.recommended, c.reply]), [['A', true, 'Aでお願いします。'], ['B', false, 'Bでお願いします。']]);
  assert.equal(choices[0].title, 'あなたに、規約への同意と「Messaging API を利用する」ボタンの押下をお願いします');
});

test('numbered options count only when a question follows; steps and summaries do not', () => {
  const ask = '進め方を選んでください。\n\n1. Codex で直す\n2. Claude で直す\n3. 今は直さない\n\nどれにしますか？';
  assert.deepEqual(plain(choiceModel.parse(ask)).map((c) => c.reply), ['1（Codex で直す）でお願いします。', '2（Claude で直す）でお願いします。', '3（今は直さない）でお願いします。']);
  assert.deepEqual(plain(choiceModel.parse('次の手順で進めます。\n\n1. ログイン\n2. 設定を開く\n\n終わったら報告します。')), []);
  assert.deepEqual(plain(choiceModel.parse('- A: 一つだけ\n\nどちらにしますか？')), [], 'one option is not a choice');
  assert.deepEqual(plain(choiceModel.parse('- A: 前\n- B: 後\n\n説明は以上です。\n\n- 補足\n- もう一つ\n\n完了しました。')), [], 'only the last list counts');
});

test('a closing yes / no question offers yes and no; open questions offer nothing', () => {
  assert.deepEqual(plain(choiceModel.parse('設定は確認しました。\nこのまま本番に反映してよいですか？')).map((c) => c.title), ['はい、進めてください', 'いいえ、やめてください']);
  assert.deepEqual(plain(choiceModel.parse('どちらの環境に反映してよいですか？')), []);
  assert.deepEqual(plain(choiceModel.parse('今どこまで進んでいるか教えてください。')), []);
});

test('preview keeps what the person wrote and folds app-attached blocks into labelled chips', () => {
  const sent = 'https://developers.line.biz/console/ でこないだ作った。確認できる？ @LINE Developers\n\n<cu_window_hints>The user is pointing at: window "LINE Developers" (already open)</cu_window_hints>';
  const { body, blocks } = promptPreviewModel.parse(sent);
  assert.equal(body, 'https://developers.line.biz/console/ でこないだ作った。確認できる？ @LINE Developers');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].label, '指した画面'); assert.equal(blocks[0].detail, 'LINE Developers');
  assert.match(blocks[0].text, /^The user is pointing at/);
});

test('unknown machine tags get a readable label, typed HTML and slash commands stay words', () => {
  const { body, blocks } = promptPreviewModel.parse('<b>太字</b> を残す <command-name>/review</command-name><some_new_context a="1">x</some_new_context>');
  assert.equal(body, '<b>太字</b> を残す /review');
  assert.deepEqual(JSON.parse(JSON.stringify(blocks)), [{ tag: 'some_new_context', label: 'some new context', detail: '', text: 'x' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(promptPreviewModel.parse('ふつうの依頼'))), { body: 'ふつうの依頼', blocks: [] });
});

test('changing an answer keeps the text typed before the first selection', () => {
  const source = fs.readFileSync(new URL('../ui/requests.js', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('function fillChoice('), source.indexOf('function renderDispatch('));
  const input = { value: '先に書いた下書き', dataset: {}, dispatchEvent() {}, focus() {}, setSelectionRange() {}, closest: () => null };
  const fill = vm.runInNewContext(fn + '\nfillChoice', { Event: class {} });
  const pane = { el: { querySelector: () => input } };
  fill(pane, { reply: 'Aでお願いします。' });
  assert.equal(input.value, '先に書いた下書き\nAでお願いします。');
  fill(pane, { reply: 'Bでお願いします。' });
  assert.equal(input.value, '先に書いた下書き\nBでお願いします。');
  input.value += '\n追加の手入力';
  fill(pane, { reply: 'Cでお願いします。' });
  assert.equal(input.value, '先に書いた下書き\nBでお願いします。\n追加の手入力\nCでお願いします。');
  input.value = '';
  fill(pane, { reply: 'Aでお願いします。' });
  fill(pane, { reply: 'Bでお願いします。' });
  assert.equal(input.value, 'Bでお願いします。');
});

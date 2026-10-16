import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const { promptPreviewModel } = vm.runInNewContext(fs.readFileSync(new URL('../ui/message-preview.js', import.meta.url), 'utf8') + '\n({ promptPreviewModel })');

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

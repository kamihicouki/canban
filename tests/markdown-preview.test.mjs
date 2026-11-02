import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../ui/card-overlay-layer.js', import.meta.url), 'utf8');
const markdown = source.slice(source.indexOf('const escH ='), source.indexOf('// ---- the layer that holds the cards ----'));
const mdHtml = vm.runInNewContext(markdown + '\nmdHtml');

test('preview keeps the starting number of a continued procedure', () => {
  assert.equal(mdHtml('3. 確認する\n4. 反映する'), '<ol start="3"><li>確認する</li><li>反映する</li></ol>');
  assert.equal(mdHtml('0) 準備\n1) 確認'), '<ol start="0"><li>準備</li><li>確認</li></ol>');
  assert.equal(mdHtml('12. 確認する\n\n13. 反映する'), '<ol start="12"><li>確認する</li><li>反映する</li></ol>');
});

test('separate lists keep their own start while ordinary Markdown stays the same', () => {
  assert.equal(mdHtml('1. 確認\n1. 反映'), '<ol><li>確認</li><li>反映</li></ol>');
  assert.equal(mdHtml('3. 前半\n\n説明\n\n7. 後半'), '<ol start="3"><li>前半</li></ol><p>説明</p><ol start="7"><li>後半</li></ol>');
  assert.equal(mdHtml('- 確認\n- 反映'), '<ul><li>確認</li><li>反映</li></ul>');
  assert.equal(mdHtml('```\n3. code\n```'), '<pre><code>3. code</code></pre>');
  assert.equal(mdHtml('3. <script>bad</script>'), '<ol start="3"><li>&lt;script&gt;bad&lt;/script&gt;</li></ol>');
});

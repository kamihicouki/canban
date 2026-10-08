// Component styles: one choice per component, shared UI state, unknown values fall back to the default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { boardHtml } from '../server/ui.mjs';

const source = fs.readFileSync(new URL('../ui/component-styles-model.js', import.meta.url), 'utf8');
const model = vm.runInNewContext(`${source}\n({ COMPONENT_STYLES, COMPONENT_STYLE_KEYS, componentStyleDefaults, normalizeComponentStyles });`);
const plain = (v) => JSON.parse(JSON.stringify(v));

test('every component has a default among its options, and each option has a label and a meaning', () => {
  for (const key of model.COMPONENT_STYLE_KEYS) {
    const [label, def, options] = model.COMPONENT_STYLES[key];
    assert.ok(label, key);
    assert.ok(options.length >= 2, key);
    assert.ok(options.some(([v]) => v === def), `${key} default`);
    for (const [value, text, desc] of options) assert.ok(value && text && desc, `${key}/${value}`);
    assert.equal(new Set(options.map(([v]) => v)).size, options.length, `${key} values are unique`);
  }
});

test('the defaults are the new designs; the current ones stay selectable', () => {
  const d = plain(model.componentStyleDefaults());
  assert.deepEqual(d, { boardCard: 'standard', peek: 'on', boardView: 'board', detail: 'thread', conversation: 'folded', composer: 'chips', taskDetail: 'threads', review: 'on' });
  const has = (key, value) => model.COMPONENT_STYLES[key][2].some(([v]) => v === value);
  assert.ok(has('boardCard', 'classic') && has('detail', 'modules') && has('conversation', 'classic') && has('composer', 'classic') && has('taskDetail', 'classic'));
});

test('saved choices survive; unknown components, values and shapes are dropped', () => {
  assert.deepEqual(plain(model.normalizeComponentStyles({ boardCard: 'rich', detail: 'modules', nope: 'x' })),
    { ...plain(model.componentStyleDefaults()), boardCard: 'rich', detail: 'modules' });
  assert.deepEqual(plain(model.normalizeComponentStyles({ boardCard: 'huge', composer: 3 })), plain(model.componentStyleDefaults()));
  for (const bad of [null, undefined, 'standard', 7, ['classic']]) assert.deepEqual(plain(model.normalizeComponentStyles(bad)), plain(model.componentStyleDefaults()));
});

test('the board shares the choices with other screens and offers them in the palette and the look menu', () => {
  const html = boardHtml({ version: '0.0.0' });
  assert.match(html, /SHARED_UI_KEYS = \[[^\]]*'componentStyles'/);
  assert.match(html, /componentStyles: \{ \.\.\.state\.styles \}/);
  assert.match(html, /componentStyleChooser\(\)/);
  assert.match(html, /スタイル: \$\{COMPONENT_STYLES\[key\]\[0\]\}/);
});

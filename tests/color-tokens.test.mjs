import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// AGENTS.md: 色は ui/base.css の :root のトークンから使い、16進の色を直接書かない。
const uiDir = new URL('../ui/', import.meta.url);
const exempt = new Set(['base.css', 'vendor-xterm.css']);
const HEX = /#[0-9a-fA-F]{3,8}\b/g;

test('ui/*.css (base.css 以外) は16進の色を直接書かない', () => {
  const hits = [];
  for (const name of fs.readdirSync(uiDir).filter((n) => n.endsWith('.css') && !exempt.has(n)).sort()) {
    fs.readFileSync(new URL(name, uiDir), 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(HEX)) hits.push(`ui/${name}:${i + 1} ${m[0]}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('base.css の色トークンはライトとダークの両方で定義する', () => {
  const css = fs.readFileSync(new URL('base.css', uiDir), 'utf8');
  const block = (selector) => {
    const names = new Set();
    for (const m of css.matchAll(new RegExp(`${selector.replace(/[[\]"]/g, '\\$&')} \\{([^}]*)\\}`, 'g'))) {
      for (const d of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) if (/#|rgba?\(/.test(d[2])) names.add(d[1]);
    }
    return names;
  };
  const light = block(':root');
  const dark = block(':root[data-theme="dark"]');
  // 既存トークンのうち、ダークでライトの値を引き継ぐものは対象外にし、今回足した意味ベースのトークンを守る。
  const tokens = ['--on-solid', '--on-label', '--on-c-green', '--on-c-yellow', '--prio-high-bg', '--prio-high-fg', '--prio-medium-bg', '--prio-medium-fg',
    '--prio-low-bg', '--prio-low-fg', '--pr-fg', '--pr-open', '--pr-draft', '--pr-merged', '--pr-closed', '--pr-failing-fg', '--mark-bg', '--mark-fg',
    '--toast-bg', '--toast-fg', '--usage-remaining-bg', '--usage-remaining-fg', '--agm-ring', '--backdrop', '--toast-shadow', '--tip-shadow',
    '--dialog-shadow', '--drawer-shadow', '--seg-shadow', '--pop-shadow', '--drag-shadow'];
  for (const t of tokens) {
    assert.ok(light.has(t), `${t} がライトにない`);
    assert.ok(dark.has(t), `${t} がダークにない`);
  }
});

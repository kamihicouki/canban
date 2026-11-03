import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// AGENTS.md: アイコンは線のアイコン1種類（picon()）に揃え、メニューやボタンに絵文字を使わない。
const uiDir = new URL('../ui/', import.meta.url);
// ▶ 再開・◀ 戻る・↗ 外で開く のような矢印と図形は文字として使ってよい。
const EMOJI = /(?![\u2190-\u21ff\u25a0-\u25ff])\p{Extended_Pictographic}/u;
const BUTTON_TEXT = /h\('button',\s*\{(?:\$\{[^}]*\}|[^}])*?\btext:\s*(['`])((?:(?!\1).)*)\1/g;
// ⌘K の項目: add(group, badge, label, …) の badge。
const PALETTE_BADGE = /\badd\([^,]+,\s*(['`])((?:(?!\1).)*)\1/g;

test('ui/*.js のボタンの文字と ⌘K の項目の印に絵文字を使わない', () => {
  const hits = [];
  for (const name of fs.readdirSync(uiDir).filter((n) => n.endsWith('.js')).sort()) {
    fs.readFileSync(new URL(name, uiDir), 'utf8').split('\n').forEach((line, i) => {
      for (const re of [BUTTON_TEXT, PALETTE_BADGE]) {
        for (const m of line.matchAll(re)) if (EMOJI.test(m[2])) hits.push(`ui/${name}:${i + 1} ${m[2]}`);
      }
    });
  }
  assert.deepEqual(hits, []);
});

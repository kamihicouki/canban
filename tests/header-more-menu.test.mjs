import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../ui/header.js', import.meta.url), 'utf8');

test('the ⋯ menu shows the full-text toggle with a line icon and a pressed state, not ☑/☐', () => {
  assert.doesNotMatch(src, /[☑☐]/u);
  const row = src.slice(src.indexOf("classList.contains('ft-toggle')"), src.indexOf('本文も検索') + 10);
  assert.match(row, /'aria-pressed': String\(cb\.checked\)/);
  assert.match(row, /picon\('check', 16\)/);
});

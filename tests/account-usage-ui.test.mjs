import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const accounts = fs.readFileSync(new URL('../ui/accounts.js', import.meta.url), 'utf8');
const model = fs.readFileSync(new URL('../ui/workspace-model.js', import.meta.url), 'utf8');
const context = vm.createContext({ h: (tag, attrs = {}, ...children) => ({ tag, ...attrs, children }),
  heat: () => 'normal', fmtReset: () => 'リセット時刻' });
vm.runInContext(`${model.match(/function usageWindow\([\s\S]*?\n}/)[0]}
  ${accounts.match(/function usageWindows[^\n]+/)[0]}
  ${accounts.slice(accounts.indexOf('function accountUsageContent('), accounts.indexOf('function accountUpdateText('))}
`, context);
const now = Date.now();
const five = { usedPercent: 0, windowMinutes: 300, resetsAt: now + 3600000 };
const week = { usedPercent: 27, windowMinutes: 10080, resetsAt: now + 86400000 };
const render = (primary, secondary, usage) => context.accountUsageContent({ label: 'テスト', plan: 'prolite', limits: { at: now, primary, secondary }, usage });
const text = node => [node.text || '', ...(node.children || []).map(text)].join(' ');

test('a weekly-only account shows one full-width weekly meter in either provider slot', () => {
  for (const [primary, secondary] of [[week, null], [null, week]]) {
    const node = render(primary, secondary);
    assert.equal(node.children.length, 1);
    assert.match(node.class, /single/);
    assert.match(text(node), /週間枠.*27%/);
    assert.doesNotMatch(text(node), /5時間枠|未取得/);
  }
});

test('reported five-hour and weekly windows retain their labels and zero usage', () => {
  const single = render(five, null);
  assert.equal(single.children.length, 1);
  assert.match(text(single), /5時間枠.*0%/);
  const both = render(five, week);
  assert.equal(both.children.length, 2);
  assert.doesNotMatch(both.class, /single/);
  assert.match(text(both), /5時間枠.*0%.*週間枠.*27%/);
});

test('unavailable or invalid windows display a neutral empty state', () => {
  for (const node of [render(null, null), render({ usedPercent: NaN }, null), context.accountUsageContent({})]) {
    assert.equal(node.text, '使用量は未取得です');
    assert.equal(node.children.length, 0);
  }
});

test('a failed refresh retains the recorded usage with a stale marker', () => {
  const node = render(week, null, { status: 'error' });
  assert.match(text(node), /週間枠.*前回 27%/);
  assert.match(node.children[0].children[1].class, /stale/);
  assert.match(node.children[0].children[1]['aria-valuetext'], /要更新/);
});

// Lifetime: a card's phase follows its status and its age; the board folds what has slept for a week.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { boardHtml } from '../server/ui.mjs';

const source = fs.readFileSync(new URL('../ui/lifetime-model.js', import.meta.url), 'utf8');
const m = vm.runInNewContext(`${source}\n({ lifeOf, daysAgo, timeGroupOf, dayHistogram, splitByLife, DAY_MS, TIME_GROUPS, LIFE_LABELS });`);
const plain = (v) => JSON.parse(JSON.stringify(v));
const now = new Date(2026, 9, 8, 15, 0).getTime();
const ago = (days, hours = 0) => now - days * m.DAY_MS - hours * 3600000;

test('running or waiting is live, whatever the age; an error or an unread card stays fresh', () => {
  assert.equal(m.lifeOf({ status: 'running', updatedAt: ago(40) }, now), 'live');
  assert.equal(m.lifeOf({ status: 'waiting', updatedAt: ago(9) }, now), 'live');
  assert.equal(m.lifeOf({ status: 'aborted', updatedAt: ago(20) }, now), 'fresh');
  assert.equal(m.lifeOf({ status: 'idle', unread: true, updatedAt: ago(20) }, now), 'fresh');
});

test('a card ages from fresh (a day) through active (a week) to dormant', () => {
  assert.equal(m.lifeOf({ status: 'completed', updatedAt: ago(0, 3) }, now), 'fresh');
  assert.equal(m.lifeOf({ status: 'completed', updatedAt: ago(3) }, now), 'active');
  assert.equal(m.lifeOf({ status: 'completed', updatedAt: ago(7, 1) }, now), 'dormant');
  assert.equal(m.lifeOf({ status: 'idle' }, now), 'dormant'); // no time at all is old
});

test('what the user keeps does not fall asleep: task cards, a priority, a due date', () => {
  assert.equal(m.lifeOf({ kind: 'task', status: 'completed', links: [], updatedAt: ago(30) }, now), 'active');
  assert.equal(m.lifeOf({ status: 'idle', priority: 'high', updatedAt: ago(30) }, now), 'active');
  assert.equal(m.lifeOf({ status: 'idle', due: '2026-10-20', updatedAt: ago(30) }, now), 'active');
  assert.equal(m.lifeOf({ kind: 'task', status: 'idle', links: [{ status: 'running' }], updatedAt: ago(30) }, now), 'live');
});

test('days follow the calendar, not 24-hour blocks', () => {
  const lateYesterday = new Date(2026, 9, 7, 23, 50).getTime();
  assert.equal(m.daysAgo(lateYesterday, now), 1);
  assert.equal(m.daysAgo(new Date(2026, 9, 8, 0, 5).getTime(), now), 0);
  assert.equal(m.daysAgo(0, now), Infinity);
});

test('the timeline puts what needs you first, then running, then the calendar', () => {
  assert.equal(m.timeGroupOf({ status: 'waiting', updatedAt: ago(40) }, now), 'need');
  assert.equal(m.timeGroupOf({ status: 'aborted', updatedAt: ago(2) }, now), 'need');
  assert.equal(m.timeGroupOf({ status: 'running', updatedAt: ago(0) }, now), 'live');
  assert.deepEqual([0, 1, 3, 12, 45].map((d) => m.timeGroupOf({ status: 'completed', updatedAt: ago(d) }, now)), ['today', 'yesterday', 'week', 'month', 'older']);
  assert.deepEqual(plain(m.TIME_GROUPS.map(([k]) => k)), ['need', 'live', 'today', 'yesterday', 'week', 'month', 'older']);
});

test('the ribbon counts cards per day inside its window', () => {
  const cards = [{ updatedAt: ago(0) }, { updatedAt: ago(0, 2) }, { updatedAt: ago(2) }, { updatedAt: ago(9) }];
  assert.deepEqual(plain(m.dayHistogram(cards, 7, now)), [2, 0, 1, 0, 0, 0, 0]);
});

test('a list keeps its order for awake cards and folds the dormant ones', () => {
  const cards = [{ id: 'a', status: 'idle', updatedAt: ago(12) }, { id: 'b', status: 'completed', updatedAt: ago(1) }, { id: 'c', status: 'running', updatedAt: ago(30) }];
  const { awake, dormant } = m.splitByLife(cards, now);
  assert.deepEqual(plain(awake.map((c) => c.id)), ['b', 'c']);
  assert.deepEqual(plain(dormant.map((c) => c.id)), ['a']);
});

test('shared card styling and lifetime remain wired in across selectable layouts', () => {
  const html = boardHtml({ version: '0.0.0' });
  assert.doesNotMatch(html, /componentStyleChooser|COMPONENT_STYLES|data-cs-/);
  assert.doesNotMatch(html, /SHARED_UI_KEYS = \[[^\]]*'(componentStyles|cardFit|cardLayouts)'/);
  assert.match(html, /SHARED_UI_KEYS = \[[^\]]*'boardView'/);
  assert.match(html, /SHARED_UI_KEYS = \[[^\]]*'layout'/);
  assert.match(html, /function layoutChooser/);
  assert.match(html, /id="ribbon"/);
  assert.match(html, /splitByLife\(list\.cards\)/);
  assert.match(html, /i: toggleBoardView/);
});

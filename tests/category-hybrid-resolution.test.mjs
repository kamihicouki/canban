import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCategory } from '../server/category-bindings.mjs';

test('resolveCategory: explicit category takes top priority (Mode 2)', () => {
  const directories = [
    { id: 'dir-1', name: 'Work' },
    { id: 'dir-2', name: 'Private' },
  ];
  const res = resolveCategory({
    card: { directoryId: 'dir-2' },
    sourceView: null,
    legacy: {
      directories,
      sessionId: 'sess-1',
      repoName: 'work-repo',
    },
  });
  assert.equal(res.status, 'explicit');
  assert.equal(res.categoryId, 'dir-2');
});

test('resolveCategory: unclassified cards retain unclassified status without arbitrary assignment', () => {
  const directories = [
    { id: 'dir-canban', name: 'Canban' },
  ];
  const res = resolveCategory({
    card: {},
    sourceView: null,
    legacy: {
      directories,
      sessionId: 'sess-2',
      repoName: 'other-repo',
    },
  });
  assert.equal(res.status, 'unclassified');
  assert.equal(res.categoryId, null);
});

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

test('resolveCategory: auto matches existing directory by repoName or projectName', () => {
  const directories = [
    { id: 'dir-canban', name: 'Canban' },
    { id: 'dir-other', name: 'Other Project' },
  ];
  // repoName is 'canban' (lowercase), directory name is 'Canban'
  const res = resolveCategory({
    card: {},
    sourceView: null,
    legacy: {
      directories,
      sessionId: 'sess-2',
      repoName: 'canban',
    },
  });
  assert.equal(res.status, 'auto_matched');
  assert.equal(res.categoryId, 'dir-canban');
});

test('resolveCategory: falls back to auto-repo category when unclassified (Mode 1)', () => {
  const directories = [
    { id: 'dir-other', name: 'Other' },
  ];
  const res = resolveCategory({
    card: {},
    sourceView: null,
    legacy: {
      directories,
      sessionId: 'sess-3',
      repoName: 'my-cool-app',
    },
  });
  assert.equal(res.status, 'auto_repo');
  assert.equal(res.categoryId, 'auto:repo:my-cool-app');
  assert.equal(res.categoryName, 'my-cool-app');
});

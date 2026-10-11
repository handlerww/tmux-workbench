import test from 'node:test';
import assert from 'node:assert/strict';
import { changeVariants, checkSummary } from './git-panel-utils.js';

test('Git changes expose every staged, unstaged, or untracked version', () => {
  assert.deepEqual(changeVariants({ staged: true, unstaged: true }), ['staged', 'unstaged']);
  assert.deepEqual(changeVariants({ untracked: true }), ['untracked']);
  assert.deepEqual(changeVariants({ status: 'D' }), ['unstaged']);
});

test('pull request check summaries count success, failure, and pending statuses', () => {
  assert.equal(checkSummary({ contexts: { nodes: [
    { state: 'SUCCESS' }, { conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' },
  ] } }), '1 passed, 1 failed, 1 pending');
  assert.equal(checkSummary('[{"conclusion":"SUCCESS"}]'), '1 passed');
  assert.equal(checkSummary(null), '');
});

test('change groups separate index and worktree versions and search renamed paths', async () => {
  const { groupedChanges } = await import('./git-panel-utils.js');
  const changes = [
    { path: 'src/api/New.js', oldPath: 'src/api/Old.js', staged: true, unstaged: true },
    { path: 'docs/notes.md', untracked: true },
  ];
  assert.deepEqual(groupedChanges(changes).map(group => [group.kind, group.changes.length]), [
    ['staged', 1], ['unstaged', 1], ['untracked', 1],
  ]);
  assert.deepEqual(groupedChanges(changes, 'API OLD').map(group => group.kind), ['staged', 'unstaged']);
  assert.deepEqual(groupedChanges(changes, 'api notes'), []);
});

test('Changes tree sorts directories first and compresses single folder chains', async () => {
  const { buildChangesTree, flattenChangesTree } = await import('./git-panel-utils.js');
  const root = buildChangesTree([
    { path: 'README.md', unstaged: true },
    { path: 'src/api/z.js', unstaged: true },
    { path: 'src/api/a.js', staged: true },
  ]);
  const rows = flattenChangesTree(root);
  assert.deepEqual(rows.map(row => [row.type, row.name, row.depth]), [
    ['folder', 'src/api', 0], ['file', 'a.js', 1], ['file', 'z.js', 1], ['file', 'README.md', 0],
  ]);
  assert.deepEqual(flattenChangesTree(root, new Set(['src/api'])).map(row => row.name), ['src/api', 'README.md']);
  assert.deepEqual(flattenChangesTree(root, new Set(['src'])).map(row => row.name), ['src/api', 'README.md']);
});

test('Changes tree retains collapse identity when a compressed folder gains a sibling', async () => {
  const { buildChangesTree, flattenChangesTree } = await import('./git-panel-utils.js');
  const root = buildChangesTree([{ path: 'src/api/a.js' }, { path: 'src/ui/b.js' }]);
  const rows = flattenChangesTree(root, new Set(['src/api']));
  assert.deepEqual(rows.map(row => row.path), ['src', 'src/api', 'src/ui', 'src/ui/b.js']);
  assert.equal(rows.find(row => row.path === 'src/api').collapsed, true);
});

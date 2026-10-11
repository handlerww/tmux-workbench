import assert from 'node:assert/strict';
import test from 'node:test';
import {
  closeMissingSessionTabs,
  closeTab,
  createWorkspace,
  editorDropPosition,
  findCreateTab,
  findGroup,
  findTab,
  groupsInOrder,
  moveTab,
  openCreateTab,
  openDiffPreview,
  openSession,
  openSessionPreview,
  gitDiffKey,
  placeSessionInGroup,
  replaceCreateTab,
  sanitizeWorkspace,
  splitTab,
  workspaceForStorage,
} from './workspace.js';

function sequence(prefix) {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

function ids() {
  return { group: sequence('group'), tab: sequence('tab'), split: sequence('split') };
}

test('opening a session focuses its existing tab instead of duplicating it', () => {
  const workspace = createWorkspace('main');
  const createTabId = sequence('tab');
  const first = openSession(workspace, '$1', createTabId);
  const second = openSession(workspace, '$2', createTabId);
  const reopened = openSession(workspace, '$1', createTabId);

  assert.equal(first.created, true);
  assert.equal(second.created, true);
  assert.equal(reopened.created, false);
  assert.equal(findGroup(workspace, 'main').tabs.length, 2);
  assert.equal(findGroup(workspace, 'main').activeTabId, first.tab.id);
});

test('new session uses one transient tab and replaces it in place after creation', () => {
  const workspace = createWorkspace('main');
  const createTabId = sequence('tab');
  const first = openCreateTab(workspace, createTabId);
  const reopened = openCreateTab(workspace, createTabId);

  assert.equal(first.created, true);
  assert.equal(reopened.created, false);
  assert.equal(findGroup(workspace, 'main').tabs.length, 1);
  assert.equal(findCreateTab(workspace).tab.id, first.tab.id);

  const replaced = replaceCreateTab(workspace, '$4');
  assert.equal(replaced.tab.id, first.tab.id);
  assert.equal(replaced.tab.sessionId, '$4');
  assert.equal(findCreateTab(workspace), null);
});

test('new session tabs are omitted from persisted workspace state', () => {
  const workspace = createWorkspace('main');
  const generated = ids();
  const session = openSession(workspace, '$1', generated.tab);
  const right = splitTab(workspace, session.tab.id, 'main', 'right', generated, true).group;
  openCreateTab(workspace, generated.tab);
  closeTab(workspace, right.tabs[0].id, generated.group);

  const stored = workspaceForStorage(workspace);

  assert.equal(groupsInOrder(stored.root).length, 1);
  assert.equal(stored.root.id, 'main');
  assert.deepEqual(stored.root.tabs, [{ id: session.tab.id, sessionId: '$1', pinned: true }]);
  assert.equal(stored.activeGroupId, 'main');
  assert.equal(right.tabs.some((tab) => tab.kind === 'create'), true);

  const empty = createWorkspace('empty');
  openCreateTab(empty, generated.tab);
  assert.equal(workspaceForStorage(empty), null);
});

test('file tabs persist serializable identity without saving file contents', () => {
  const workspace = createWorkspace('main');
  const group = findGroup(workspace, 'main');
  group.tabs.push({
    id: 'file-tab', sessionId: '$1', file: { root: '/work', path: 'README.md', name: 'README.md', language: 'markdown', size: 30, content: 'buffer text' },
    fileKey: '$1:README.md', pinned: true,
  });
  group.activeTabId = 'file-tab';
  const stored = workspaceForStorage(workspace);
  assert.deepEqual(stored.root.tabs, [{
    id: 'file-tab', sessionId: '$1', pinned: true,
    file: { root: '/work', path: 'README.md', name: 'README.md', language: 'markdown', size: 30 },
    fileKey: '$1:README.md',
  }]);
  const restored = sanitizeWorkspace(stored, new Set(['$1']), ids());
  assert.deepEqual(findGroup(restored, 'main').tabs[0].file, { root: '/work', path: 'README.md', name: 'README.md', language: 'markdown', size: 30 });
});

test('Git diff tabs preview and dedupe without replacing terminal or file previews', () => {
  const workspace = createWorkspace('main');
  const group = findGroup(workspace, 'main');
  const file = { id: 'file', sessionId: '$1', file: { path: 'README.md' }, fileKey: '$1:README.md', pinned: false };
  const terminal = { id: 'terminal-preview', sessionId: '$terminal', pinned: false };
  const diffPreview = { id: 'diff-preview', sessionId: '$old', diff: { repository: '/repo', path: 'old.js', kind: 'unstaged', name: 'old.js' }, pinned: false };
  group.tabs.push(file, terminal, diffPreview);
  group.activeTabId = diffPreview.id;
  const makeTabId = sequence('diff-tab');
  const diff = { repository: '/repo', path: 'src/main.js', kind: 'unstaged', name: 'main.js' };
  const opened = openDiffPreview(workspace, '$1', diff, makeTabId);

  assert.equal(opened.replaced, true);
  assert.notEqual(opened.tab.id, 'diff-preview');
  assert.equal(opened.tab.pinned, false);
  assert.equal(file.file.path, 'README.md');
  assert.equal(terminal.sessionId, '$terminal');
  assert.equal(findTab(workspace, '$1'), null);
  const duplicate = openDiffPreview(workspace, '$1', diff, makeTabId);
  assert.equal(duplicate.tab.id, opened.tab.id);
  assert.equal(duplicate.created, false);
  assert.equal(group.tabs.length, 3);
  assert.equal(opened.tab.diffKey, gitDiffKey('$1', diff));
});

test('session preview does not replace a Git diff preview; pinning adds a durable diff tab', () => {
  const workspace = createWorkspace('main');
  const makeTabId = sequence('tab');
  const diff = { repository: '/repo', path: 'main.go', kind: 'staged', name: 'main.go' };
  const diffTab = openDiffPreview(workspace, '$1', diff, sequence('diff')).tab;
  const terminal = openSessionPreview(workspace, '$2', makeTabId);
  assert.equal(terminal.created, true);
  assert.equal(diffTab.diff.path, 'main.go');
  assert.equal(diffTab.pinned, false);

  const pinned = openDiffPreview(workspace, '$1', diff, sequence('unused'), true);
  assert.equal(pinned.created, false);
  assert.equal(pinned.tab.id, diffTab.id);
  assert.equal(pinned.tab.pinned, true);
});

test('Git diff tabs duplicate across splits and persist their descriptor and key', () => {
  const workspace = createWorkspace('main');
  const generated = ids();
  const diff = { repository: '/repo', path: 'src/file.ts', kind: 'untracked', oldPath: 'old.ts', name: 'file.ts' };
  const opened = openDiffPreview(workspace, '$1', diff, generated.tab);
  const split = splitTab(workspace, opened.tab.id, 'main', 'right', generated, true);
  assert.deepEqual(split.tab.diff, diff);
  assert.equal(split.tab.diffKey, gitDiffKey('$1', diff));
  assert.equal(split.tab.pinned, true);

  const stored = workspaceForStorage(workspace);
  const restored = sanitizeWorkspace(stored, new Set(['$1']), ids());
  const tabs = groupsInOrder(restored.root).flatMap((group) => group.tabs);
  assert.equal(tabs.length, 2);
  assert.deepEqual(tabs[0].diff, diff);
  assert.equal(tabs[0].diffKey, gitDiffKey('$1', diff));
  assert.equal(tabs[1].pinned, true);
  assert.equal(findTab(restored, '$1'), null);
});

test('PR diff tabs retain immutable PR identity and do not collide across revisions or working tree', () => {
  const workspace = createWorkspace('main');
  const generated = ids();
  const prDiff = {
    repository: '/repo', path: 'src/file.ts', kind: 'pr', number: 42,
    baseSha: 'base-1', headSha: 'head-1', name: 'file.ts',
  };
  const opened = openDiffPreview(workspace, '$1', prDiff, generated.tab, true);
  const local = openDiffPreview(workspace, '$1', { repository: '/repo', path: 'src/file.ts', kind: 'unstaged', name: 'file.ts' }, generated.tab, true);
  const nextRevision = openDiffPreview(workspace, '$1', { ...prDiff, baseSha: 'base-2', headSha: 'head-2' }, generated.tab, true);

  assert.notEqual(opened.tab.id, local.tab.id);
  assert.notEqual(opened.tab.id, nextRevision.tab.id);
  assert.notEqual(opened.tab.diffKey, nextRevision.tab.diffKey);
  const stored = workspaceForStorage(workspace);
  const restored = sanitizeWorkspace(stored, new Set(['$1']), ids());
  const tabs = groupsInOrder(restored.root).flatMap((group) => group.tabs);
  const restoredPR = tabs.find((tab) => tab.diff?.kind === 'pr' && tab.diff.headSha === 'head-1');
  assert.deepEqual(restoredPR.diff, prDiff);
  assert.equal(restoredPR.diffKey, gitDiffKey('$1', prDiff));
  assert.equal(tabs.filter((tab) => tab.diff?.kind === 'pr').length, 2);
});

test('split duplicates only for an explicit split action', () => {
  const workspace = createWorkspace('main');
  const generated = ids();
  const opened = openSession(workspace, '$1', generated.tab);
  const split = splitTab(workspace, opened.tab.id, 'main', 'right', generated, true);

  assert.equal(groupsInOrder(workspace.root).length, 2);
  assert.notEqual(split.tab.id, opened.tab.id);
  assert.equal(split.tab.sessionId, opened.tab.sessionId);
  assert.equal(opened.tab.pinned, true);
  assert.equal(split.tab.pinned, true);
  assert.equal(findTab(workspace, '$1', split.group.id).group.id, split.group.id);
});

test('session disappearance closes terminal tabs but retains file tabs and their buffers', () => {
  const workspace = createWorkspace('main');
  const group = findGroup(workspace, 'main');
  group.tabs.push(
    { id: 'terminal', sessionId: '$ended', pinned: false },
    { id: 'dirty-file', sessionId: '$ended', file: { path: 'draft.md' }, fileKey: '$ended:draft.md', dirty: true, pinned: true },
  );
  group.activeTabId = 'dirty-file';

  const closed = closeMissingSessionTabs(workspace, new Set(), ids().group);

  assert.deepEqual(closed.map(({ id }) => id), ['terminal']);
  assert.deepEqual(group.tabs.map(({ id }) => id), ['dirty-file']);
  assert.equal(group.tabs[0].dirty, true);
});

test('opening a tmux session beside its file tab creates and reuses a terminal tab', () => {
  const workspace = createWorkspace('main');
  const generated = ids();
  const group = findGroup(workspace, 'main');
  group.tabs.push({ id: 'file-1', sessionId: '$1', file: { path: 'README.md' }, fileKey: '$1:README.md' });
  group.activeTabId = 'file-1';

  const opened = openSession(workspace, '$1', generated.tab);

  assert.equal(opened.created, true);
  assert.equal(opened.tab.file, undefined);
  assert.equal(group.tabs.length, 2);
  assert.equal(openSession(workspace, '$1', generated.tab).tab.id, opened.tab.id);
});

test('session previews replace only an unpinned terminal tab in the active pane', () => {
  const workspace = createWorkspace('main');
  const group = findGroup(workspace, 'main');
  const pinned = { id: 'pinned', sessionId: '$pinned', pinned: true };
  const file = { id: 'file', sessionId: '$1', file: { path: 'README.md' }, pinned: false };
  const preview = { id: 'preview', sessionId: '$old', pinned: false };
  const previousId = preview.id;
  group.tabs.push(pinned, file, preview);
  group.activeTabId = preview.id;
  const createTabId = sequence('tab');

  const replaced = openSessionPreview(workspace, '$new', createTabId);

  assert.notEqual(replaced.tab.id, previousId);
  assert.equal(replaced.previousTabId, previousId);
  assert.equal(replaced.replaced, true);
  assert.equal(preview.sessionId, '$new');
  assert.equal(preview.pinned, false);
  assert.equal(pinned.sessionId, '$pinned');
  assert.equal(file.file.path, 'README.md');
  assert.equal(group.tabs.length, 3);
});

test('session previews focus a matching tab and add a tab when only pinned or file tabs exist', () => {
  const workspace = createWorkspace('main');
  const group = findGroup(workspace, 'main');
  group.tabs.push(
    { id: 'pinned', sessionId: '$same', pinned: true },
    { id: 'file-preview', sessionId: '$other', file: { path: 'main.go' }, pinned: false },
  );
  group.activeTabId = 'file-preview';
  const createTabId = sequence('tab');

  const matched = openSessionPreview(workspace, '$same', createTabId);
  assert.equal(matched.tab.id, 'pinned');
  assert.equal(matched.created, false);
  assert.equal(matched.tab.pinned, true);

  const added = openSessionPreview(workspace, '$new', createTabId);
  assert.equal(added.created, true);
  assert.equal(added.tab.pinned, false);
  assert.equal(group.tabs.length, 3);
});

test('legacy session tabs restore pinned to avoid replacing existing tabs unexpectedly', () => {
  const generated = ids();
  const restored = sanitizeWorkspace({
    root: { type: 'group', id: 'main', tabs: [{ id: 'legacy', sessionId: '$1' }], activeTabId: 'legacy' },
    activeGroupId: 'main',
  }, new Set(['$1']), generated);
  assert.equal(findGroup(restored, 'main').tabs[0].pinned, true);
});

test('splitting a file tab duplicates its file identity and remains separate from session lookup', () => {
  const workspace = createWorkspace('main');
  const generated = ids();
  const group = findGroup(workspace, 'main');
  const file = { id: 'file-1', sessionId: '$1', file: { path: 'README.md' }, fileKey: '$1:README.md', pinned: true };
  group.tabs.push(file);

  const split = splitTab(workspace, file.id, group.id, 'right', generated, true);

  assert.notEqual(split.tab.id, file.id);
  assert.deepEqual(split.tab.file, file.file);
  assert.equal(split.tab.fileKey, file.fileKey);
  assert.equal(split.tab.pinned, true);
  assert.equal(findTab(workspace, '$1'), null);
});

test('dragging a tab moves it across groups and collapses an empty source', () => {
  const workspace = createWorkspace('main');
  const generated = ids();
  const first = openSession(workspace, '$1', generated.tab);
  splitTab(workspace, first.tab.id, 'main', 'right', generated, true);
  const original = findGroup(workspace, 'main');
  workspace.activeGroupId = original.id;
  const second = openSession(workspace, '$2', generated.tab);
  const target = groupsInOrder(workspace.root).find((group) => group.id !== original.id);

  assert.equal(moveTab(workspace, second.tab.id, target.id, 0, generated.group), true);
  assert.equal(findTab(workspace, '$2').group.id, target.id);
  closeTab(workspace, first.tab.id, generated.group);
  assert.equal(groupsInOrder(workspace.root).length, 1);
  assert.deepEqual(groupsInOrder(workspace.root)[0].tabs.map((tab) => tab.sessionId), ['$2', '$1']);
});

test('sanitizing persisted state removes tabs for sessions that ended', () => {
  const generated = ids();
  const restored = sanitizeWorkspace({
    activeGroupId: 'left',
    root: {
      type: 'split',
      id: 'saved-split',
      direction: 'horizontal',
      ratio: 0.7,
      children: [
        { type: 'group', id: 'left', activeTabId: 'one', tabs: [{ id: 'one', sessionId: '$1' }] },
        { type: 'group', id: 'right', activeTabId: 'gone', tabs: [{ id: 'gone', sessionId: '$9' }] },
      ],
    },
  }, new Set(['$1']), generated);

  assert.equal(restored.root.type, 'group');
  assert.equal(restored.root.id, 'left');
  assert.equal(restored.activeGroupId, 'left');
});

test('session refresh closes every tab for sessions that ended', () => {
  const workspace = createWorkspace('main');
  const generated = ids();
  const ended = openSession(workspace, '$1', generated.tab);
  splitTab(workspace, ended.tab.id, 'main', 'right', generated, true);
  workspace.activeGroupId = 'main';
  const live = openSession(workspace, '$2', generated.tab);

  const closed = closeMissingSessionTabs(workspace, new Set(['$2']), generated.group);

  assert.equal(closed.length, 2);
  assert.deepEqual(closed.map((tab) => tab.sessionId), ['$1', '$1']);
  assert.equal(groupsInOrder(workspace.root).length, 1);
  assert.deepEqual(groupsInOrder(workspace.root)[0].tabs, [live.tab]);
  assert.equal(groupsInOrder(workspace.root)[0].activeTabId, live.tab.id);
});

test('closing the final ended session leaves a valid empty workspace', () => {
  const workspace = createWorkspace('main');
  const generated = ids();
  openSession(workspace, '$1', generated.tab);

  assert.equal(closeMissingSessionTabs(workspace, new Set(), generated.group).length, 1);
  assert.equal(workspace.root.type, 'group');
  assert.equal(workspace.root.tabs.length, 0);
  assert.equal(workspace.activeGroupId, workspace.root.id);
});

test('session refresh leaves the transient new session tab open', () => {
  const workspace = createWorkspace('main');
  const generated = ids();
  const create = openCreateTab(workspace, generated.tab);

  assert.deepEqual(closeMissingSessionTabs(workspace, new Set(), generated.group), []);
  assert.equal(findCreateTab(workspace).tab.id, create.tab.id);
});

test('editor drop target uses edge halves and a single center target', () => {
  const bounds = { left: 100, top: 50, width: 800, height: 600 };
  assert.equal(editorDropPosition(110, 350, bounds), 'left');
  assert.equal(editorDropPosition(890, 350, bounds), 'right');
  assert.equal(editorDropPosition(500, 60, bounds), 'top');
  assert.equal(editorDropPosition(500, 640, bounds), 'bottom');
  assert.equal(editorDropPosition(500, 350, bounds), 'center');
  assert.equal(editorDropPosition(270, 170, bounds), 'top', 'the nearest edge wins in a corner');
});

test('placing a sidebar session moves an existing tab instead of duplicating it', () => {
  const workspace = createWorkspace('main');
  const generated = ids();
  const first = openSession(workspace, '$1', generated.tab);
  const right = splitTab(workspace, first.tab.id, 'main', 'right', generated, true).group;
  workspace.activeGroupId = 'main';
  const second = openSession(workspace, '$2', generated.tab);

  const placed = placeSessionInGroup(workspace, '$2', right.id, generated);
  assert.equal(placed.created, false);
  assert.equal(placed.moved, true);
  assert.equal(findTab(workspace, '$2').group.id, right.id);
  assert.equal(groupsInOrder(workspace.root).flatMap((group) => group.tabs).filter((tab) => tab.sessionId === '$2').length, 1);
  assert.equal(second.tab.id, placed.tab.id);
});

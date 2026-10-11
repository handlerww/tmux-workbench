import '@xterm/xterm/css/xterm.css';
import { SessionEditor } from './editor.js';
import { FileBrowser, FileEditor } from './file-browser.js';
import { MobileFilesController } from './mobile-files.js';
import { GitPanel } from './git-panel.js';
import { PRPanel } from './pr-panel.js';
import { GitDiffEditor } from './git-diff-editor.js';
import { SessionHoverCard } from './session-hover-card.js';
import { addRecentPath, nextNumericSessionName, sessionPathOptions } from './session-create.js';
import {
  applySessionGroupOperation,
  applySessionGroupOperations,
  groupedSessions,
  matchingSessionIds,
  matchingUngroupedSessionIds,
  restoreSessionGroups,
  SESSION_GROUPS_STORAGE_KEY,
  sessionGroupsForStorage,
} from './groups.js';
import { nextThemeSetting, readThemeSetting, resolveTheme, storeThemeSetting } from './theme.js';
import {
  activateTab,
  closeMissingSessionTabs,
  closeTab,
  createWorkspace,
  cycleTab,
  editorDropPosition,
  findCreateTab,
  findGroup,
  findTab,
  findTabById,
  groupsInOrder,
  moveTab,
  openCreateTab,
  openDiffPreview,
  openSession,
  openSessionPreview,
  gitDiffKey,
  placeSessionInGroup,
  resizeSplit,
  replaceCreateTab,
  sanitizeWorkspace,
  splitTab,
  workspaceForStorage,
} from './workspace.js';
import './style.css';
import './input-controls.css';
import './session-drag.css';
import './session-layout.css';
import './sidebar-toggle.css';
import './file-tree.css';

const elements = {
  welcome: document.querySelector('#welcome'),
  workspaceLayout: document.querySelector('#workspace-layout'),
  sidebar: document.querySelector('#sidebar'),
  workspacesToggle: document.querySelector('#workspaces-toggle'),
  sidebarResizer: document.querySelector('#sidebar-resizer'),
  sidebarBackdrop: document.querySelector('#sidebar-backdrop'),
  mobileSessionToggle: document.querySelector('#mobile-session-toggle'),
  mobileSidebarClose: document.querySelector('#mobile-sidebar-close'),
  mobileActiveName: document.querySelector('#mobile-active-name'),
  mobileFilesToggle: document.querySelector('#mobile-files-toggle'),
  sessionList: document.querySelector('#session-list'),
  sessionSearch: document.querySelector('#session-search-input'),
  sessionSearchClear: document.querySelector('#session-search-clear'),
  themeButton: document.querySelector('#theme-button'),
  createSessionButton: document.querySelector('#create-session-button'),
  createSessionForm: document.querySelector('#create-session-form'),
  createSessionPath: document.querySelector('#create-session-path'),
  createSessionPathSearch: document.querySelector('#create-session-path-search'),
  createSessionName: document.querySelector('#create-session-name'),
  recentSessionPaths: document.querySelector('#recent-session-paths'),
  createSessionSave: document.querySelector('#create-session-save'),
  createSessionCancel: document.querySelector('#create-session-cancel'),
  refresh: document.querySelector('#refresh-button'),
  toast: document.querySelector('#toast'),
  createGroupButton: document.querySelector('#create-group-button'),
  filesSidebar: document.querySelector('#files-sidebar'),
  filesContent: document.querySelector('#files-content'),
  gitContent: document.querySelector('#git-content'),
  prContent: document.querySelector('#pr-content'),
  filesTab: document.querySelector('#right-files-tab'),
  gitTab: document.querySelector('#right-git-tab'),
  prTab: document.querySelector('#right-pr-tab'),
  filesResizer: document.querySelector('#files-resizer'),
  filesToggle: document.querySelector('#files-toggle'),
};

const sessionNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
const mobileLayoutQuery = window.matchMedia('(max-width: 520px)');
const sidebarWidthSetting = 'workbench.sidebarWidth';
const sidebarCollapsedSetting = 'workbench.sidebarCollapsed';
const workspaceSetting = 'workbench.workspace.v1';
const readerAutoFollowSetting = 'workbench.readerAutoFollow';
const recentPathsSetting = 'workbench.recentPaths.v1';
const filesWidthSetting = 'workbench.filesWidth';
const filesVisibleSetting = 'workbench.filesVisible';
const maximumRecentPaths = 10;
const defaultSidebarWidth = 282;
const minimumSidebarWidth = 220;
const compactMinimumSidebarWidth = 190;
const maximumSidebarWidth = 520;
const minimumWorkspaceWidth = 360;
const terminalThemes = {
  light: {
    background: '#ffffff', foreground: '#27272a', cursor: '#52525b', cursorAccent: '#ffffff',
    selectionBackground: '#d4d4d8aa', selectionInactiveBackground: '#e4e4e7aa', black: '#18181b',
    red: '#b91c1c', green: '#15803d', yellow: '#a16207', blue: '#1d4ed8', magenta: '#7e22ce',
    cyan: '#0e7490', white: '#e4e4e7', brightBlack: '#71717a', brightRed: '#dc2626',
    brightGreen: '#16a34a', brightYellow: '#ca8a04', brightBlue: '#2563eb', brightMagenta: '#9333ea',
    brightCyan: '#0891b2', brightWhite: '#fafafa',
  },
  dark: {
    background: '#18181b', foreground: '#e4e4e7', cursor: '#a1a1aa', cursorAccent: '#18181b',
    selectionBackground: '#52525b99', selectionInactiveBackground: '#3f3f4699', black: '#18181b',
    red: '#f87171', green: '#4ade80', yellow: '#facc15', blue: '#60a5fa', magenta: '#c084fc',
    cyan: '#22d3ee', white: '#d4d4d8', brightBlack: '#71717a', brightRed: '#fca5a5',
    brightGreen: '#86efac', brightYellow: '#fde047', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9', brightWhite: '#fafafa',
  },
};

let nextID = Date.now();
const ids = {
  group: () => `group-${crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join('-')}`,
  tab: () => `tab-${++nextID}`,
  split: () => `split-${++nextID}`,
};
let sessions = [];
let workspace = createWorkspace(ids.group());
let workspaceRestored = false;
let editorViews = new Map();
let fileViews = new Map();
let diffViews = new Map();
let fileBrowser = null;
let gitPanel = null;
let prPanel = null;
let activeRightPanel = 'files';
let mobileFilesController = null;
let sessionGroups = restoreSessionGroups();
let sharedSessionGroups = restoreSessionGroups();
let sharedGroupsRevision = null;
let sharedGroupsReady = false;
let sharedGroupsRequestInFlight = false;
let sharedGroupsWriteInFlight = false;
let pendingSessionGroupOperations = [];
let sharedGroupsRetryTimer = null;
let groupsUnavailableToastShown = false;
let refreshInFlight = false;
let createInFlight = false;
let pendingCreatedSession = null;
let draggedItem = null;
let dragGeneration = 0;
let deferredSessionRender = false;
let sessionListScrollFrame = null;
let sessionListScrollSpeed = 0;
let sessionListScrollTime = null;
let tabContextMenu = null;
let toastTimer = null;
let sidebarWidth = readSidebarWidth();
let sidebarCollapsed = readSidebarCollapsed();
let filesWidth = readFilesWidth();
let filesVisible = readFilesVisible();
let readerAutoFollow = readReaderAutoFollow();
let recentPaths = readRecentPaths();
let themeSetting = readThemeSetting();
let resolvedTheme = resolveTheme(themeSetting, systemThemeQuery.matches);

const sessionHoverCard = new SessionHoverCard({
  getSession: (sessionId) => sessions.find((session) => session.id === sessionId),
  getGroups: () => sessionGroups,
  getEnabled: () => !sidebarCollapsed && !mobileLayoutQuery.matches && !draggedItem && !tabContextMenu && !createInFlight,
  onBeforeOpen: () => closeTabContextMenu(),
  onMove: (sessionId, groupId) => {
    if (!sessions.some((session) => session.id === sessionId)) return false;
    const moved = queueSessionGroupOperation({ type: 'assign', sessionId, groupId });
    if (moved) showToast(`Moved to ${sessionGroups.groups.find((group) => group.id === groupId)?.name || 'Untagged'}`);
    return moved;
  },
});

bindPageEvents();
restoreSessionSearch();
applyTheme(themeSetting, false);
applySidebarWidth(sidebarWidth, false);
applySidebarCollapsed(false);
applyFilesWidth(filesWidth, false);
applyFilesPanel(false);
mobileFilesController = new MobileFilesController({
  panel: elements.filesSidebar,
  toggle: elements.mobileFilesToggle,
  onOpenChange: (open) => {
    const visible = mobileLayoutQuery.matches ? open : filesVisible;
    gitPanel?.setVisible(activeRightPanel === 'git' && visible);
    prPanel?.setVisible(activeRightPanel === 'pr' && visible);
  },
});
gitPanel = new GitPanel(elements.gitContent, {
  getTheme: () => resolvedTheme,
  onToast: showToast,
  onOpenDiff: openGitDiffTab,
  onSnapshot: updateGitDiffSnapshots,
  isVisible: () => activeRightPanel === 'git' && isRightSidebarVisible(),
});
prPanel = new PRPanel(elements.prContent, {
  getTheme: () => resolvedTheme,
  onToast: showToast,
  onOpenDiff: openGitDiffTab,
  onSnapshot: updatePRDiffSnapshots,
  isVisible: () => activeRightPanel === 'pr' && isRightSidebarVisible(),
});
setRightPanel(activeRightPanel, false);
syncMobileSidebar();
loadSessions(false);
setInterval(() => loadSessions(false), 5000);

function bindPageEvents() {
  elements.refresh.addEventListener('click', () => loadSessions(true));
  elements.workspacesToggle.addEventListener('click', () => {
    sidebarCollapsed = !sidebarCollapsed;
    applySidebarCollapsed();
  });
  elements.mobileSessionToggle.addEventListener('click', () => setMobileSidebarOpen(true));
  elements.mobileSidebarClose.addEventListener('click', () => setMobileSidebarOpen(false, true));
  elements.sidebarBackdrop.addEventListener('click', () => setMobileSidebarOpen(false, true));
  mobileLayoutQuery.addEventListener('change', syncMobileSidebar);
  elements.sidebarResizer.addEventListener('pointerdown', startSidebarResize);
  elements.sidebarResizer.addEventListener('keydown', resizeSidebarWithKeyboard);
  elements.sidebarResizer.addEventListener('dblclick', () => applySidebarWidth(defaultSidebarWidth));
  elements.filesResizer.addEventListener('pointerdown', startFilesResize);
  elements.filesResizer.addEventListener('keydown', resizeFilesWithKeyboard);
  elements.filesResizer.addEventListener('dblclick', () => applyFilesWidth(270));
  elements.filesTab.addEventListener('click', () => setRightPanel('files'));
  elements.gitTab.addEventListener('click', () => setRightPanel('git'));
  elements.prTab.addEventListener('click', () => setRightPanel('pr'));
  const rightTabs = [[elements.filesTab, 'files'], [elements.gitTab, 'git'], [elements.prTab, 'pr']];
  for (const [button, panel] of rightTabs) {
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = rightTabs.findIndex(([, value]) => value === panel);
      const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? rightTabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + rightTabs.length) % rightTabs.length;
      setRightPanel(rightTabs[nextIndex][1]);
      rightTabs[nextIndex][0].focus();
    });
  }
  elements.filesToggle.addEventListener('click', () => {
    if (mobileLayoutQuery.matches) {
      mobileFilesController?.toggle();
      return;
    }
    filesVisible = !filesVisible;
    applyFilesPanel();
  });
  elements.themeButton.addEventListener('click', () => applyTheme(nextThemeSetting(themeSetting)));
  systemThemeQuery.addEventListener('change', () => {
    if (themeSetting === 'system') applyTheme('system', false);
  });
  elements.sessionSearch.addEventListener('input', () => updateSessionSearch());
  window.addEventListener('popstate', restoreSessionSearch);
  elements.sessionSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && elements.sessionSearch.value) clearSessionSearch();
  });
  elements.sessionSearchClear.addEventListener('click', clearSessionSearch);
  elements.createSessionButton.addEventListener('click', startCreateSession);
  elements.createGroupButton.addEventListener('click', () => promptCreateGroup());
  elements.createSessionCancel.addEventListener('click', () => cancelCreateSession(true));
  elements.createSessionForm.addEventListener('submit', (event) => {
    event.preventDefault();
    createSession();
  });
  elements.createSessionPath.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !createInFlight) {
      event.preventDefault();
      cancelCreateSession(true);
    }
  });
  elements.createSessionPathSearch.addEventListener('input', renderCreateSessionOptions);
  elements.createSessionPathSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') event.preventDefault();
    if (event.key === 'Escape' && elements.createSessionPathSearch.value) {
      event.preventDefault();
      elements.createSessionPathSearch.value = '';
      renderCreateSessionOptions();
    }
  });
window.addEventListener('resize', () => {
    applySidebarWidth(sidebarWidth, false);
    applyFilesWidth(filesWidth, false);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      for (const editor of editorViews.values()) editor.suspend();
      return;
    }
    resumePage();
  });
  window.addEventListener('pagehide', () => {
    for (const editor of editorViews.values()) editor.suspend();
  });
  window.addEventListener('beforeunload', warnBeforeDiscardingUnsavedState);
  window.addEventListener('pageshow', resumePage);
  window.addEventListener('online', resumePage);
  document.addEventListener('keydown', handleWorkspaceShortcut);
  document.addEventListener('dragend', clearWorkspaceDrag);
  document.addEventListener('drop', () => queueMicrotask(clearWorkspaceDrag));
  document.addEventListener('dragover', updateSessionListDragScroll, true);
  elements.sessionList.addEventListener('dragleave', (event) => {
    if (event.target === elements.sessionList && !elements.sessionList.contains(event.relatedTarget)) stopSessionListDragScroll();
  });
  window.addEventListener('blur', clearWorkspaceDrag);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearWorkspaceDrag();
  });
  elements.welcome.addEventListener('dragenter', showWelcomeDropTarget);
  elements.welcome.addEventListener('dragover', showWelcomeDropTarget);
  elements.welcome.addEventListener('dragleave', (event) => {
    if (!elements.welcome.contains(event.relatedTarget)) elements.welcome.classList.remove('drag-target');
  });
  elements.welcome.addEventListener('drop', dropSessionOnWelcome);
}

function resumePage() {
  if (document.hidden) return;
  restoreSessionSearch();
  loadSessions(false);
  for (const editor of editorViews.values()) editor.resume();
  for (const editor of diffViews.values()) editor.resume();
}

function handleWorkspaceShortcut(event) {
  const target = event.target;
  const isTyping = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
  const commandKey = event.ctrlKey || event.metaKey;
  if (event.key === 'Escape' && draggedItem) {
    event.preventDefault();
    clearWorkspaceDrag();
    return;
  }
  if (event.key === '/' && !isTyping && !commandKey && !event.altKey) {
    event.preventDefault();
    if (mobileLayoutQuery.matches) {
      setMobileSidebarOpen(true);
      requestAnimationFrame(() => elements.sessionSearch.focus());
    } else {
      sidebarCollapsed = false;
      applySidebarCollapsed();
      elements.sessionSearch.focus();
    }
    return;
  }
  if (event.key === 'Escape' && mobileLayoutQuery.matches && elements.sidebar.classList.contains('open') && !isTyping) {
    setMobileSidebarOpen(false, true);
    return;
  }
  if (!commandKey || event.altKey) return;
  const group = findGroup(workspace, workspace.activeGroupId);
  if (!group?.activeTabId) return;
  if (event.key.toLowerCase() === 'w') {
    event.preventDefault();
    closeWorkspaceTab(group.activeTabId);
  } else if (event.key === 'Tab') {
    event.preventDefault();
    if (cycleTab(workspace, group.id, event.shiftKey ? -1 : 1)) commitWorkspace();
  } else if (event.key === '\\') {
    event.preventDefault();
    splitActiveTab(group.id, 'right');
  }
}

async function loadSessions(showFeedback = false) {
  if (refreshInFlight) return;
  refreshInFlight = true;
  elements.refresh.classList.add('spinning');
  try {
    const response = await fetch('/api/sessions', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    sessions = body.sessions ?? [];
    if (pendingCreatedSession) {
      if (!sessions.some((item) => item.id === pendingCreatedSession.id)) sessions.push(pendingCreatedSession);
      pendingCreatedSession = null;
    }
    await syncSharedSessionGroups();
    const initialWorkspaceRender = !workspaceRestored;
    let closedTabs = [];
    if (initialWorkspaceRender) {
      workspace = sanitizeWorkspace(readStoredWorkspace(), new Set(sessions.map((session) => session.id)), ids);
      workspaceRestored = true;
    } else {
      closedTabs = closeMissingSessionTabs(workspace, new Set(sessions.map((session) => session.id)), ids.group);
      if (closedTabs.length > 0) persistWorkspace();
    }
    syncEditors();
    renderSessions();
    // Keep mounted editors in place during polling so native Reader/xterm state,
    // including scroll position and selection, survives session metadata updates.
    if (initialWorkspaceRender || closedTabs.length > 0) renderWorkspace();
    else refreshWorkspaceSessions();
    if (showFeedback) showToast('Updated');
  } catch {
    renderSessionError();
    if (showFeedback) showToast('Could not refresh');
  } finally {
    refreshInFlight = false;
    elements.refresh.classList.remove('spinning');
  }
}

function renderSessions() {
  if (['session', 'session-group'].includes(draggedItem?.type) && draggedItem.source?.isConnected) {
    deferredSessionRender = true;
    return;
  }
  const focusedSessionAction = document.activeElement?.matches?.('.session-card')
    ? document.activeElement.dataset.sessionId
    : null;
  renderCreateSessionOptions();
  elements.sessionList.replaceChildren();
  const query = elements.sessionSearch.value.trim().toLocaleLowerCase();
  const all = sessions.slice().sort((left, right) => (
    sessionNameCollator.compare(left.name, right.name)
    || left.name.localeCompare(right.name)
    || left.id.localeCompare(right.id)
  ));
  const visible = (items) => query
    ? items.filter((session) => session.name.toLocaleLowerCase().includes(query) || (session.path || '').toLocaleLowerCase().includes(query))
    : items;
  if (sessions.length === 0) {
    sessionHoverCard.close();
    const empty = document.createElement('div');
    empty.className = 'empty-sessions';
    empty.innerHTML = '<span class="empty-icon">◇</span><strong>No sessions</strong><small>Use + to create one</small>';
    elements.sessionList.append(empty);
    return;
  }
  const buckets = groupedSessions(all, sessionGroups);
  const sections = [...buckets.groups, {
    id: null,
    name: 'Untagged',
    sessions: buckets.ungrouped,
    collapsed: sessionGroups.ungroupedCollapsed,
  }];
  const matchingCount = all.filter((session) => visible([session]).length).length;
  if (query) {
    const untaggedCount = matchingUngroupedSessionIds(sessionGroups, all, query).length;
    const actions = document.createElement('div');
    actions.className = 'search-group-controls';
    const summary = document.createElement('small');
    summary.className = 'search-group-summary';
    summary.textContent = `${matchingCount} match${matchingCount === 1 ? '' : 'es'} · ${untaggedCount} Untagged`;
    actions.append(summary);
    if (untaggedCount) {
      const create = document.createElement('button');
      create.type = 'button';
      create.className = 'search-group-action';
      create.textContent = `Create group from ${untaggedCount} Untagged result${untaggedCount === 1 ? '' : 's'}`;
      create.title = 'Only matching Untagged sessions join the new group';
      create.addEventListener('click', createGroupFromCurrentSearch);
      actions.append(create);
    }
    if (matchingCount && sessionGroups.groups.length) {
      const move = document.createElement('select');
      move.className = 'search-group-move';
      move.setAttribute('aria-label', 'Move search results to a group');
      move.title = 'Move all matching sessions, including sessions already in a group';
      const placeholder = document.createElement('option');
      placeholder.value = '__choose__';
      placeholder.textContent = `Move ${matchingCount} result${matchingCount === 1 ? '' : 's'} to…`;
      placeholder.disabled = true;
      placeholder.selected = true;
      move.append(placeholder);
      for (const group of [{ id: '', name: 'Untagged' }, ...sessionGroups.groups]) {
        const option = document.createElement('option');
        option.value = group.id;
        option.textContent = group.name;
        move.append(option);
      }
      move.addEventListener('change', () => {
        queueSessionGroupOperation({ type: 'assign_many', sessionIds: matchingSessionIds(sessions, query), groupId: move.value || null });
      });
      actions.append(move);
    }
    elements.sessionList.append(actions);
  }
  for (const section of sections) {
    const matches = visible(section.sessions);
    if (query && matches.length === 0) continue;
    const collapsed = Boolean(section.collapsed && !query);
    const sectionNode = document.createElement('section');
    sectionNode.className = 'workspace-section';
    sectionNode.dataset.sessionGroupId = section.id ?? '';
    sectionNode.addEventListener('dragover', (event) => {
      if (draggedItem?.type === 'session-group') return;
      event.preventDefault();
    });
    sectionNode.addEventListener('drop', (event) => {
      if (draggedItem?.type === 'session-group') {
        event.preventDefault();
        event.stopPropagation();
        const operation = { type: 'reorder', groupId: draggedItem.groupId, targetId: null, after: false };
        clearWorkspaceDrag();
        queueSessionGroupOperation(operation);
        return;
      }
      const sessionId = draggedItem?.type === 'session' ? draggedItem.sessionId : null;
      if (!sessionId) {
        clearWorkspaceDrag();
        return;
      }
      event.preventDefault();
      const targetId = section.sessions.filter((item) => item.id !== sessionId).at(-1)?.id ?? null;
      const operation = sessionReorderOperation(sessionId, section.id, targetId, true);
      clearWorkspaceDrag();
      queueSessionGroupOperation(operation);
    });
    const heading = document.createElement('div');
    heading.className = 'workspace-section-heading';
    if (section.id) {
      heading.draggable = true;
      heading.addEventListener('dragstart', (event) => startSessionGroupDrag(event, section.id));
      heading.addEventListener('dragend', () => {
        if (draggedItem?.source === heading) clearWorkspaceDrag();
      });
    }
    heading.addEventListener('dragover', (event) => {
      if (draggedItem?.type !== 'session-group') return;
      event.preventDefault();
      event.stopPropagation();
      heading.dataset.dropPosition = event.clientY < heading.getBoundingClientRect().top + heading.offsetHeight / 2 ? 'before' : 'after';
    });
    heading.addEventListener('dragleave', (event) => {
      if (!heading.contains(event.relatedTarget)) delete heading.dataset.dropPosition;
    });
    heading.addEventListener('drop', (event) => {
      if (draggedItem?.type !== 'session-group') return;
      event.preventDefault();
      event.stopPropagation();
      const after = heading.dataset.dropPosition === 'after';
      delete heading.dataset.dropPosition;
      const operation = { type: 'reorder', groupId: draggedItem.groupId, targetId: section.id, after };
      clearWorkspaceDrag();
      queueSessionGroupOperation(operation);
    });
    const fold = document.createElement('button');
    fold.className = 'section-fold';
    fold.type = 'button';
    fold.setAttribute('aria-expanded', String(!collapsed));
    fold.textContent = collapsed ? '›' : '⌄';
    fold.addEventListener('click', () => toggleSessionGroup(section.id));
    const title = document.createElement('span');
    title.className = 'workspace-section-title';
    const folder = document.createElement('span');
    folder.className = 'workspace-group-icon';
    folder.setAttribute('aria-hidden', 'true');
    folder.innerHTML = '<svg viewBox="0 0 20 20"><path d="M2.5 5.2a1 1 0 0 1 1-1h4l1.7 1.7h7.3a1 1 0 0 1 1 1v7.9a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1z"/><path d="M2.8 7h14.4"/></svg>';
    title.textContent = section.name;
    title.prepend(folder);
    const count = document.createElement('small');
    count.textContent = String(section.sessions.length);
    heading.append(fold, title, count);
    if (section.id) {
      const menu = document.createElement('button');
      menu.type = 'button';
      menu.className = 'group-menu';
      menu.title = `Manage ${section.name}`;
      menu.setAttribute('aria-label', `Manage ${section.name}`);
      menu.textContent = '···';
      menu.setAttribute('aria-haspopup', 'menu');
      menu.addEventListener('click', (event) => manageSessionGroup(event, section));
      heading.append(menu);
    }
    sectionNode.append(heading);
    if (!collapsed) for (const session of matches) sectionNode.append(renderSessionCard(session));
    if (matches.length === 0 && !query && section.id && !collapsed) {
      const empty = document.createElement('div');
      empty.className = 'group-empty';
      empty.textContent = 'Drop sessions here';
      sectionNode.append(empty);
    }
    elements.sessionList.append(sectionNode);
  }
  if (query && matchingCount === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-sessions search-empty';
    empty.innerHTML = '<span class="empty-icon">⌕</span><strong>No matches</strong><small>Search by name or path</small>';
    elements.sessionList.append(empty);
  }
  sessionHoverCard.sync();
  if (focusedSessionAction) {
    elements.sessionList.querySelector(`.session-card[data-session-id="${CSS.escape(focusedSessionAction)}"]`)
      ?.focus({ preventScroll: true });
  }
}

function renderSessionCard(session) {
    const wrapper = document.createElement('div');
    wrapper.className = 'session-card-row';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'session-card';
    button.dataset.sessionId = session.id;
    button.disabled = createInFlight;
    button.draggable = !createInFlight;
    button.classList.toggle('active', activeTab()?.sessionId === session.id);
    button.classList.toggle('open', Boolean(findTab(workspace, session.id)));
    button.addEventListener('click', () => {
      sessionHoverCard.close();
      openSessionTab(session);
    });
    button.addEventListener('dblclick', () => pinSessionInActiveGroup(session.id));
    button.addEventListener('dragstart', (event) => startSessionDrag(event, session.id));
    button.addEventListener('dragend', () => {
      if (draggedItem?.source === button) clearWorkspaceDrag();
    });

    const top = document.createElement('span');
    top.className = 'session-card-top';
    const name = document.createElement('strong');
    name.textContent = session.name;
    top.append(name);
    const sessionPath = document.createElement('span');
    sessionPath.className = 'session-path';
    sessionPath.textContent = session.path || 'Path unavailable';
    sessionPath.title = session.path || '';
    button.append(top, sessionPath);
    wrapper.append(button);
    wrapper.addEventListener('contextmenu', (event) => {
      if (mobileLayoutQuery.matches) return;
      event.preventDefault();
      closeTabContextMenu();
      sessionHoverCard.open(session.id, { focus: true, pinned: true });
    });
    wrapper.addEventListener('dragover', (event) => {
      if (draggedItem?.type !== 'session' || draggedItem.sessionId === session.id) return;
      event.preventDefault();
      event.stopPropagation();
      for (const row of elements.sessionList.querySelectorAll('.session-card-row[data-drop-position]')) {
        if (row !== wrapper) delete row.dataset.dropPosition;
      }
      const bounds = wrapper.getBoundingClientRect();
      wrapper.dataset.dropPosition = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
      event.dataTransfer.dropEffect = 'move';
    });
    wrapper.addEventListener('dragleave', (event) => {
      if (!wrapper.contains(event.relatedTarget)) delete wrapper.dataset.dropPosition;
    });
    wrapper.addEventListener('drop', (event) => {
      if (draggedItem?.type !== 'session') return;
      event.preventDefault();
      event.stopPropagation();
      const sessionId = draggedItem.sessionId;
      const groupId = wrapper.closest('.workspace-section')?.dataset.sessionGroupId || null;
      const after = event.clientY >= wrapper.getBoundingClientRect().top + wrapper.offsetHeight / 2;
      const operation = sessionReorderOperation(sessionId, groupId, session.id, after);
      clearWorkspaceDrag();
      if (sessionId !== session.id) queueSessionGroupOperation(operation);
    });
    sessionHoverCard.attach(wrapper, session.id);
    return wrapper;
}

function sessionReorderOperation(sessionId, groupId, targetId, after) {
  return {
    type: 'reorder_session', sessionId, groupId, targetId, after,
    fallbackOrder: sessions.slice().sort((left, right) => (
      sessionNameCollator.compare(left.name, right.name)
      || left.name.localeCompare(right.name)
      || left.id.localeCompare(right.id)
    )).map((session) => session.id),
  };
}

function promptCreateGroup(initialName = '') {
  const name = window.prompt('Group name', initialName)?.trim();
  if (!name) return;
  const operation = { type: 'create', group: { id: ids.group(), name, collapsed: false } };
  queueSessionGroupOperation(operation);
}

function createGroupFromCurrentSearch() {
  const query = elements.sessionSearch.value.trim();
  if (!query) return;
  const sessionIds = matchingUngroupedSessionIds(sessionGroups, sessions, query);
  if (!sessionIds.length) return;
  const name = window.prompt('Name this group', query)?.trim();
  if (!name) return;
  const operation = { type: 'create_from_search', group: { id: ids.group(), name, collapsed: false }, sessionIds };
  if (!queueSessionGroupOperation(operation)) return;
  elements.sessionSearch.value = '';
  updateSessionSearch();
  showToast(`Created ${name} with ${sessionIds.length} sessions`);
}

function manageSessionGroup(event, group) {
  const bounds = event.currentTarget.getBoundingClientRect();
  showActionMenu({ clientX: bounds.left, clientY: bounds.bottom }, 'Group actions', [
    { label: 'Move to top', disabled: sessionGroups.groups[0]?.id === group.id, run: () => {
      queueSessionGroupOperation({ type: 'move_to_top', groupId: group.id });
    } },
    { label: 'Rename group', run: () => {
      const name = window.prompt('Group name', group.name)?.trim();
      if (name) queueSessionGroupOperation({ type: 'rename', groupId: group.id, name });
    } },
    { label: 'Dissolve group', run: () => {
      if (window.confirm(`Dissolve “${group.name}”? Its sessions will move to Untagged.`)) {
        queueSessionGroupOperation({ type: 'delete', groupId: group.id });
      }
    } },
  ]);
}

function toggleSessionGroup(groupId) {
  const group = groupId === null ? null : sessionGroups.groups.find((item) => item.id === groupId);
  if (groupId !== null && !group) return;
  const collapsed = groupId === null ? !sessionGroups.ungroupedCollapsed : !group.collapsed;
  queueSessionGroupOperation({ type: 'set_collapsed', groupId, collapsed });
}

function readStoredSessionGroups() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_GROUPS_STORAGE_KEY));
  } catch {
    return null;
  }
}

const SESSION_GROUPS_MIGRATION_KEY = 'workbench.sessionGroups.serverMigration.v1';

function parseServerSessionGroups(body) {
  if (!body || typeof body !== 'object' || typeof body.revision !== 'string') {
    throw new Error('Invalid shared groups response');
  }
  return { state: restoreSessionGroups(body), revision: body.revision };
}

function groupStateHasData(state) {
  return state.groups.length > 0 || Object.keys(state.assignments).length > 0 || state.ungroupedCollapsed;
}

function markGroupMigrationComplete() {
  try {
    localStorage.setItem(SESSION_GROUPS_MIGRATION_KEY, 'true');
    localStorage.removeItem(SESSION_GROUPS_STORAGE_KEY);
  } catch {
    // The server remains authoritative if browser storage is unavailable.
  }
}

function groupMigrationComplete() {
  try {
    return localStorage.getItem(SESSION_GROUPS_MIGRATION_KEY) === 'true';
  } catch {
    return false;
  }
}

async function putServerSessionGroups(state, revision) {
  const response = await fetch('/api/groups', {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...sessionGroupsForStorage(state), revision }),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function initializeSharedSessionGroups(snapshot) {
  let { state, revision } = parseServerSessionGroups(snapshot);
  if (!groupMigrationComplete()) {
    const localState = restoreSessionGroups(readStoredSessionGroups());
    let migrationSafeToFinalize = true;
    if (!groupStateHasData(state) && groupStateHasData(localState)) {
      let migrated = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { response, body } = await putServerSessionGroups(localState, revision);
        if (response.ok) {
          ({ state, revision } = parseServerSessionGroups(body));
          migrated = true;
          break;
        }
        if (response.status !== 409) break;
        ({ state, revision } = parseServerSessionGroups(body));
        if (groupStateHasData(state)) break;
      }
      if (!migrated && !groupStateHasData(state)) {
        showToast('Could not migrate local groups to shared storage');
        migrationSafeToFinalize = false;
      } else if (migrated) {
        showToast('Moved your groups to shared storage');
      }
    }
    if (migrationSafeToFinalize) markGroupMigrationComplete();
  }
  sharedSessionGroups = state;
  sharedGroupsRevision = revision;
  sharedGroupsReady = true;
  rebuildOptimisticSessionGroups();
}

async function syncSharedSessionGroups() {
  if (sharedGroupsRequestInFlight || sharedGroupsWriteInFlight || pendingSessionGroupOperations.length || draggedItem) return false;
  sharedGroupsRequestInFlight = true;
  try {
    const response = await fetch('/api/groups', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const snapshot = await response.json();
    if (sharedGroupsReady && (pendingSessionGroupOperations.length || draggedItem || sharedGroupsWriteInFlight)) return false;
    if (!sharedGroupsReady) {
      await initializeSharedSessionGroups(snapshot);
      return true;
    }
    const next = parseServerSessionGroups(snapshot);
    if (next.revision === sharedGroupsRevision) return false;
    sharedSessionGroups = next.state;
    sharedGroupsRevision = next.revision;
    rebuildOptimisticSessionGroups();
    renderSessions();
    return true;
  } catch {
    if (!groupsUnavailableToastShown) {
      showToast('Could not sync shared groups');
      groupsUnavailableToastShown = true;
    }
    return false;
  } finally {
    sharedGroupsRequestInFlight = false;
    if (pendingSessionGroupOperations.length) void flushSessionGroupOperations();
  }
}

function rebuildOptimisticSessionGroups() {
  sessionGroups = applySessionGroupOperations(restoreSessionGroups(sharedSessionGroups), pendingSessionGroupOperations);
}

function queueSessionGroupOperation(operation) {
  if (!sharedGroupsReady) {
    showToast('Shared groups are still loading');
    return false;
  }
  if (!applySessionGroupOperation(sessionGroups, operation)) {
    showToast('That group changed in another window');
    return false;
  }
  pendingSessionGroupOperations.push(operation);
  renderSessions();
  void flushSessionGroupOperations();
  return true;
}

function scheduleSessionGroupRetry() {
  if (sharedGroupsRetryTimer !== null) return;
  sharedGroupsRetryTimer = window.setTimeout(() => {
    sharedGroupsRetryTimer = null;
    void flushSessionGroupOperations();
  }, 2500);
}

async function flushSessionGroupOperations() {
  if (!sharedGroupsReady || sharedGroupsWriteInFlight || sharedGroupsRequestInFlight || !pendingSessionGroupOperations.length) return;
  sharedGroupsWriteInFlight = true;
  try {
    while (pendingSessionGroupOperations.length) {
      const operation = pendingSessionGroupOperations[0];
      let saved = false;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const proposed = restoreSessionGroups(sharedSessionGroups);
        if (!applySessionGroupOperation(proposed, operation)) {
          pendingSessionGroupOperations.shift();
          rebuildOptimisticSessionGroups();
          renderSessions();
          showToast('Group changed elsewhere; that action could not be applied');
          saved = true;
          break;
        }
        const { response, body } = await putServerSessionGroups(proposed, sharedGroupsRevision);
        if (response.status === 409) {
          const current = parseServerSessionGroups(body);
          sharedSessionGroups = current.state;
          sharedGroupsRevision = current.revision;
          rebuildOptimisticSessionGroups();
          continue;
        }
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        const persisted = parseServerSessionGroups(body);
        sharedSessionGroups = persisted.state;
        sharedGroupsRevision = persisted.revision;
        pendingSessionGroupOperations.shift();
        rebuildOptimisticSessionGroups();
        renderSessions();
        saved = true;
        break;
      }
      if (!saved) {
        showToast('Groups changed repeatedly; your change is queued for retry');
        scheduleSessionGroupRetry();
        break;
      }
    }
  } catch {
    showToast('Could not save shared groups; your change is queued for retry');
    scheduleSessionGroupRetry();
  } finally {
    sharedGroupsWriteInFlight = false;
  }
}

function openSessionTab(session, { pinned = false } = {}) {
  rememberRecentPath(session.path);
  const previousGroupId = workspace.activeGroupId;
  const previousTabId = activeTab()?.id;
  const opened = openSessionPreview(workspace, session.id, ids.tab);
  if (pinned && opened) opened.tab.pinned = true;
  setMobileSidebarOpen(false);
  const changed = opened && (opened.created || opened.replaced
    || previousGroupId !== workspace.activeGroupId || previousTabId !== opened.tab.id || pinned);
  if (changed) commitWorkspace();
  else updateSessionCardStates();
}

function pinSessionInActiveGroup(sessionId) {
  const group = findGroup(workspace, workspace.activeGroupId);
  const tab = group?.tabs.find((item) => item.sessionId === sessionId && !item.file && item.kind !== 'create');
  if (!tab || tab.pinned !== false) return;
  tab.pinned = true;
  commitWorkspace();
  showToast('Session tab pinned');
}

function openFileTab(session, file, { pinned = false } = {}) {
  if (!session || !file) return;
  const fileKey = `${session.id}:${file.path}`;
  const tabs = groupsInOrder(workspace.root).flatMap((group) => group.tabs.map((tab) => ({ group, tab })));
  let current = tabs.find(({ tab }) => tab.file && tab.fileKey === fileKey)
    ?? (!pinned ? tabs.find(({ tab }) => tab.file && tab.sessionId === session.id && !tab.pinned) : null);
  if (current?.tab.dirty && current.tab.fileKey !== fileKey) current = null;
  if (current) {
    const sameFile = current.tab.fileKey === fileKey;
    current.tab.file = file;
    current.tab.fileKey = fileKey;
    if (pinned) current.tab.pinned = true;
    current.group.activeTabId = current.tab.id;
    workspace.activeGroupId = current.group.id;
    if (sameFile && !current.tab.dirty) fileViews.get(current.tab.id)?.loadFile(true);
  } else {
    const group = findGroup(workspace, workspace.activeGroupId) ?? groupsInOrder(workspace.root)[0];
    if (!group) return;
    const tab = { id: ids.tab(), sessionId: session.id, file, fileKey, pinned: Boolean(pinned) };
    group.tabs.push(tab);
    group.activeTabId = tab.id;
    workspace.activeGroupId = group.id;
  }
  setMobileSidebarOpen(false);
  commitWorkspace();
  mobileFilesController?.close({ restoreFocus: false });
}

function openGitDiffTab(session, diff, { pinned = false } = {}) {
  if (!session || !diff?.repository || !diff?.path || !diff?.kind) return;
  const previousGroupId = workspace.activeGroupId;
  const previousTabId = activeTab()?.id;
  const opened = openDiffPreview(workspace, session.id, diff, ids.tab, pinned);
  if (!opened) return;
  const changed = opened.created || opened.replaced
    || previousGroupId !== workspace.activeGroupId
    || previousTabId !== opened.tab.id
    || (pinned && opened.tab.pinned);
  if (changed) commitWorkspace();
  else updateSessionCardStates();
  mobileFilesController?.close({ restoreFocus: false });
}

function updateGitDiffSnapshots(session, snapshot) {
  if (!session) return;
  if (prPanel?.sessionId === session.id) prPanel.setGitStatus?.(snapshot);
  for (const [tabId, view] of diffViews) {
    const found = findTabById(workspace, tabId);
    if (!found?.tab.diff || found.tab.sessionId !== session.id) continue;
    if (found.tab.diff.kind === 'pr') {
      if (!snapshot?.repository || snapshot.repository.path !== found.tab.diff.repository) void view.setPRStatus(null);
    } else void view.setGitStatus(snapshot);
  }
}

function updatePRDiffSnapshots(session, snapshot) {
  if (!session) return;
  for (const [tabId, view] of diffViews) {
    const found = findTabById(workspace, tabId);
    if (found?.tab.diff?.kind === 'pr' && found.tab.sessionId === session.id) void view.setPRStatus(snapshot);
  }
}

function renderWorkspace() {
  syncEditors();
  if (!fileBrowser) fileBrowser = new FileBrowser(elements.filesContent, {
    onOpen: openFileTab,
    onToast: showToast,
    onReveal: () => setRightPanel('files'),
    getTheme: () => resolvedTheme,
  });
  const groups = groupsInOrder(workspace.root);
  const visibleTabIds = new Set(groups.map((group) => group.activeTabId).filter(Boolean));
  for (const [tabId, editor] of editorViews) {
    if (!visibleTabIds.has(tabId)) editor.setVisible(false);
  }
  for (const [tabId, editor] of fileViews) {
    if (!visibleTabIds.has(tabId)) editor.setVisible(false);
  }
  for (const [tabId, editor] of diffViews) {
    if (!visibleTabIds.has(tabId)) editor.setVisible(false);
  }
  const hasTabs = groups.some((group) => group.tabs.length > 0);
  elements.welcome.hidden = hasTabs;
  elements.workspaceLayout.hidden = !hasTabs;
  elements.workspaceLayout.replaceChildren();
  if (!hasTabs) {
    fileBrowser.setSession(null);
    gitPanel?.setSession(null);
    prPanel?.setSession(null);
    elements.mobileActiveName.textContent = 'Sessions';
    updateSessionCardStates();
    return;
  }
  elements.workspaceLayout.append(renderLayoutNode(workspace.root));
  for (const group of groups) {
    if (!group.activeTabId) continue;
    const editor = editorViews.get(group.activeTabId);
    editor?.setVisible(true);
    fileViews.get(group.activeTabId)?.setVisible(true);
    diffViews.get(group.activeTabId)?.setVisible(true);
  }
  const session = sessionForTab(activeTab());
  fileBrowser.setSession(session);
  gitPanel?.setSession(session);
  prPanel?.setSession(session);
  gitPanel?.setSelectedDiff(activeTab()?.diff ?? null);
  prPanel?.setSelectedDiff(activeTab()?.diff ?? null);
  elements.mobileActiveName.textContent = activeTab()?.kind === 'create' ? 'New session' : tabTitle(activeTab(), session);
  elements.createSessionButton.setAttribute('aria-expanded', String(Boolean(findCreateTab(workspace))));
  updateSessionCardStates();
}

function updateSessionCardStates() {
  const activeSessionId = activeTab()?.sessionId;
  for (const item of elements.sessionList.querySelectorAll('.session-card')) {
    const sessionId = item.dataset.sessionId;
    item.classList.toggle('active', activeSessionId === sessionId);
    item.classList.toggle('open', Boolean(findTab(workspace, sessionId)));
  }
}

function refreshWorkspaceSessions() {
  for (const item of elements.workspaceLayout.querySelectorAll('.editor-tab[data-tab-id]')) {
    const found = findTabById(workspace, item.dataset.tabId);
    if (!found) continue;
    if (found.tab.kind === 'create') continue;
    const liveSession = sessions.find((candidate) => candidate.id === found.tab.sessionId);
    const session = liveSession ?? editorViews.get(found.tab.id)?.session ?? diffViews.get(found.tab.id)?.session;
    const label = item.querySelector('.tab-label');
    const close = item.querySelector('.tab-close');
    const name = tabTitle(found.tab, session);
    item.classList.toggle('ended', !found.tab.file && !found.tab.diff && !liveSession);
    item.title = found.tab.diff ? `Diff · ${found.tab.diff.repository} · ${found.tab.diff.oldPath ? `${found.tab.diff.oldPath} → ` : ''}${found.tab.diff.path}` : found.tab.file?.path || session?.path || session?.name || 'Session ended';
    if (label) label.textContent = `${found.tab.diff ? `Diff · ${diffTabName(found.tab.diff)}` : name}${found.tab.dirty ? ' •' : ''}`;
    if (close) close.setAttribute('aria-label', `Close ${found.tab.diff ? 'diff ' : ''}${found.tab.diff ? diffTabName(found.tab.diff) : name}`);
  }
  const session = sessionForTab(activeTab());
  elements.mobileActiveName.textContent = activeTab()?.kind === 'create' ? 'New session' : tabTitle(activeTab(), session);
  updateSessionCardStates();
}

function renderLayoutNode(node) {
  if (node.type === 'group') return renderEditorGroup(node);
  const split = document.createElement('div');
  split.className = `editor-split ${node.direction}`;
  split.dataset.splitId = node.id;
  const first = document.createElement('div');
  const second = document.createElement('div');
  first.className = 'split-child';
  second.className = 'split-child';
  first.style.flexBasis = `${node.ratio * 100}%`;
  second.style.flexBasis = `${(1 - node.ratio) * 100}%`;
  first.append(renderLayoutNode(node.children[0]));
  second.append(renderLayoutNode(node.children[1]));
  const divider = document.createElement('div');
  divider.className = 'split-divider';
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-orientation', node.direction === 'horizontal' ? 'vertical' : 'horizontal');
  divider.tabIndex = 0;
  divider.addEventListener('pointerdown', (event) => startSplitResize(event, node, split, first, second));
  divider.addEventListener('keydown', (event) => resizeSplitWithKeyboard(event, node));
  split.append(first, divider, second);
  return split;
}

function renderEditorGroup(group) {
  const container = document.createElement('section');
  container.className = 'editor-group';
  container.classList.toggle('active', group.id === workspace.activeGroupId);
  container.dataset.groupId = group.id;
  container.classList.toggle('with-workspaces-toggle', groupsInOrder(workspace.root)[0]?.id === group.id);
  container.addEventListener('pointerdown', () => setActiveGroup(group.id));

  const tabbar = document.createElement('div');
  tabbar.className = 'editor-tabbar';
  tabbar.setAttribute('role', 'tablist');
  const tabs = document.createElement('div');
  tabs.className = 'editor-tabs';
  tabs.addEventListener('dragover', (event) => event.preventDefault());
  tabs.addEventListener('drop', (event) => dropItemInGroup(event, group.id, group.tabs.length));
  for (const [index, tab] of group.tabs.entries()) tabs.append(renderTab(group, tab, index));
  const actions = document.createElement('div');
  actions.className = 'group-actions';
  const active = group.tabs.find((tab) => tab.id === group.activeTabId);
  const creating = active?.kind === 'create';
  const dirtyFile = isFileTabDirty(active);
  const splitBlocked = creating || dirtyFile;
  actions.append(
    groupAction(dirtyFile ? 'Save changes before splitting' : 'Split right', 'split-right', () => splitActiveTab(group.id, 'right'), splitBlocked),
    groupAction(dirtyFile ? 'Save changes before splitting' : 'Split down', 'split-down', () => splitActiveTab(group.id, 'bottom'), splitBlocked),
  );
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'group-action tab-menu-action';
  more.title = 'Tab actions';
  more.setAttribute('aria-label', 'Tab actions');
  more.textContent = '···';
  more.disabled = !active || creating;
  more.addEventListener('pointerdown', (event) => event.stopPropagation());
  more.addEventListener('click', (event) => {
    if (!active || creating) return;
    const rect = event.currentTarget.getBoundingClientRect();
    showTabContextMenu({ clientX: rect.left, clientY: rect.bottom }, group.id, active.id);
  });
  actions.append(more);
  tabbar.append(tabs, actions);

  const body = document.createElement('div');
  body.className = 'editor-group-body';
  body.dataset.activeTabId = group.activeTabId ?? '';
  if (creating) body.append(renderCreateSessionPanel());
  else {
    const editor = diffViews.get(group.activeTabId) ?? fileViews.get(group.activeTabId) ?? editorViews.get(group.activeTabId);
    if (editor) body.append(editor.panel);
  }
  body.append(createDropZones(group.id));
  container.append(tabbar, body);
  return container;
}

function activateWorkspaceTabInPlace(group, tab) {
  for (const container of document.querySelectorAll('.editor-group')) {
    const isActive = container.dataset.groupId === group.id;
    container.classList.toggle('active', isActive);
    for (const item of container.querySelectorAll('.editor-tab[data-tab-id]')) {
      const selected = isActive && item.dataset.tabId === tab.id;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-selected', String(selected));
    }
  }
  const container = [...document.querySelectorAll('.editor-group')].find((item) => item.dataset.groupId === group.id);
  const body = container?.querySelector('.editor-group-body');
  if (body && body.dataset.activeTabId !== tab.id) {
    body.replaceChildren();
    if (tab.kind === 'create') body.append(renderCreateSessionPanel());
    else {
      const editor = diffViews.get(tab.id) ?? fileViews.get(tab.id) ?? editorViews.get(tab.id);
      if (editor) body.append(editor.panel);
    }
    body.append(createDropZones(group.id));
    body.dataset.activeTabId = tab.id;
  }
  const visibleTabIds = new Set(groupsInOrder(workspace.root).map((item) => item.activeTabId).filter(Boolean));
  for (const [tabId, editor] of editorViews) editor.setVisible(visibleTabIds.has(tabId));
  for (const [tabId, editor] of fileViews) editor.setVisible(visibleTabIds.has(tabId));
  for (const [tabId, editor] of diffViews) editor.setVisible(visibleTabIds.has(tabId));
  const session = sessionForTab(tab);
  elements.mobileActiveName.textContent = tab.kind === 'create' ? 'New session' : tabTitle(tab, session);
  elements.createSessionButton.setAttribute('aria-expanded', String(Boolean(findCreateTab(workspace))));
  fileBrowser?.setSession(session);
  gitPanel?.setSession(session);
  prPanel?.setSession(session);
  gitPanel?.setSelectedDiff(tab.diff ?? null);
  prPanel?.setSelectedDiff(tab.diff ?? null);
  updateSessionCardStates();
}

function renderTab(group, tab, index) {
  const creating = tab.kind === 'create';
  const session = sessionForTab(tab);
  const item = document.createElement('div');
  item.className = 'editor-tab';
  item.classList.toggle('active', group.activeTabId === tab.id);
  item.classList.toggle('create', creating);
  item.classList.toggle('file-tab', Boolean(tab.file));
  item.classList.toggle('diff-tab', Boolean(tab.diff));
  item.classList.toggle('dirty', Boolean(tab.dirty));
  item.classList.toggle('ended', !creating && !tab.file && !tab.diff && !sessions.some((candidate) => candidate.id === tab.sessionId));
  item.dataset.tabId = tab.id;
  item.draggable = !creating;
  item.setAttribute('role', 'tab');
  item.setAttribute('aria-selected', String(group.activeTabId === tab.id));
  item.title = creating ? 'Create tmux session' : tab.diff ? `Diff · ${tab.diff.repository} · ${tab.diff.oldPath ? `${tab.diff.oldPath} → ` : ''}${tab.diff.path}` : tab.file?.path || session?.path || session?.name || 'Session ended';
  item.addEventListener('click', () => {
    const alreadyActive = workspace.activeGroupId === group.id && group.activeTabId === tab.id;
    if (alreadyActive) return;
    activateTab(workspace, group.id, tab.id);
    persistWorkspace();
    activateWorkspaceTabInPlace(group, tab);
  });
  item.addEventListener('dblclick', (event) => {
    if (creating || event.target.closest('button')) return;
    if (tab.pinned === false) {
      tab.pinned = true;
      commitWorkspace();
    }
  });
  item.addEventListener('auxclick', (event) => {
    if (event.button !== 1 || creating) return;
    event.preventDefault();
    closeWorkspaceTab(tab.id);
  });
  item.addEventListener('contextmenu', (event) => {
    if (creating) return;
    event.preventDefault();
    showTabContextMenu(event, group.id, tab.id);
  });
  if (!creating) {
    item.addEventListener('dragstart', (event) => startTabDrag(event, tab.id));
    item.addEventListener('dragend', () => {
      if (draggedItem?.source === item) clearWorkspaceDrag();
    });
  }
  item.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const before = event.clientX < item.getBoundingClientRect().left + item.offsetWidth / 2;
    item.dataset.dropSide = before ? 'before' : 'after';
  });
  item.addEventListener('dragleave', () => delete item.dataset.dropSide);
  item.addEventListener('drop', (event) => {
    event.stopPropagation();
    const targetIndex = index + (item.dataset.dropSide === 'after' ? 1 : 0);
    delete item.dataset.dropSide;
    dropItemInGroup(event, group.id, targetIndex);
  });

  const icon = document.createElement('span');
  icon.className = 'tab-terminal-icon';
  icon.textContent = creating ? '+' : tab.diff ? 'Δ' : tab.file ? '◇' : '>_';
  const label = document.createElement('span');
  label.className = 'tab-label';
  label.textContent = creating ? 'New session' : `${tab.diff ? `Diff · ${diffTabName(tab.diff)}` : tab.file?.name ?? session?.name ?? 'Session ended'}${tab.dirty ? ' •' : ''}`;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'tab-close';
  close.title = 'Close tab';
  close.setAttribute('aria-label', `Close ${tab.diff ? 'diff ' : ''}${tab.diff ? diffTabName(tab.diff) : tab.file?.name ?? session?.name ?? label.textContent}`);
  close.textContent = '×';
  close.disabled = creating && createInFlight;
  close.addEventListener('pointerdown', (event) => event.stopPropagation());
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    closeWorkspaceTab(tab.id);
  });
  item.append(icon, label, close);
  if (!creating) {
    const pinned = tab.file ? Boolean(tab.pinned) : tab.pinned !== false;
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'tab-pin';
    pin.textContent = pinned ? '●' : '○';
    const tabType = tab.diff ? 'diff' : tab.file ? 'file' : 'session';
    pin.title = pinned ? `Unpin ${tabType} tab` : `Pin ${tabType} tab`;
    pin.setAttribute('aria-label', pin.title);
    pin.addEventListener('pointerdown', (event) => event.stopPropagation());
    pin.addEventListener('click', (event) => {
      event.stopPropagation();
      if (isFileTabDirty(tab)) return;
      tab.pinned = !tab.pinned;
      commitWorkspace();
    });
    item.append(pin);
  }
  return item;
}

function renderCreateSessionPanel() {
  const panel = document.createElement('section');
  panel.className = 'create-session-panel';
  elements.createSessionForm.hidden = false;
  panel.append(elements.createSessionForm);
  return panel;
}

function createDropZones(groupId) {
  const overlay = document.createElement('div');
  overlay.className = 'editor-drop-overlay';
  const preview = document.createElement('div');
  preview.className = 'editor-drop-preview';
  preview.dataset.position = 'center';
  overlay.append(preview);

  const updatePreview = (event) => {
    event.preventDefault();
    for (const other of document.querySelectorAll('.editor-drop-overlay.is-active')) {
      if (other !== overlay) other.classList.remove('is-active');
    }
    overlay.classList.add('is-active');
    preview.dataset.position = editorDropPosition(event.clientX, event.clientY, overlay.getBoundingClientRect());
  };
  overlay.addEventListener('dragenter', (event) => {
    if (!['session', 'tab'].includes(draggedItem?.type)) return;
    updatePreview(event);
  });
  overlay.addEventListener('dragover', (event) => {
    if (!['session', 'tab'].includes(draggedItem?.type)) return;
    updatePreview(event);
  });
  overlay.addEventListener('dragleave', (event) => {
    if (!overlay.contains(event.relatedTarget)) {
      overlay.classList.remove('is-active');
      preview.dataset.position = 'center';
    }
  });
  overlay.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!draggedItem) return;
    if (draggedItem.type === 'session-group') {
      clearWorkspaceDrag();
      return;
    }
    const position = editorDropPosition(event.clientX, event.clientY, overlay.getBoundingClientRect());
    if (draggedItem.type === 'tab') {
      if (position === 'center') moveTab(workspace, draggedItem.tabId, groupId, findGroup(workspace, groupId)?.tabs.length ?? 0, ids.group);
      else splitTab(workspace, draggedItem.tabId, groupId, position, ids, false);
    } else {
      const placed = placeSessionInGroup(workspace, draggedItem.sessionId, groupId, ids);
      if (placed && position !== 'center') splitTab(workspace, placed.tab.id, groupId, position, ids, false);
    }
    clearWorkspaceDrag();
    commitWorkspace();
  });
  return overlay;
}

function groupAction(label, kind, action, disabled = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `group-action ${kind}`;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.disabled = disabled;
  button.innerHTML = kind === 'split-right'
    ? '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>'
    : '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/></svg>';
  button.addEventListener('pointerdown', (event) => event.stopPropagation());
  button.addEventListener('click', action);
  return button;
}

function startTabDrag(event, tabId) {
  sessionHoverCard.close();
  const tabElement = event.currentTarget;
  const generation = ++dragGeneration;
  draggedItem = { type: 'tab', tabId, source: tabElement, generation };
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', tabId);
  document.body.classList.add('workspace-item-dragging');
  requestAnimationFrame(() => {
    if (draggedItem?.generation === generation && tabElement.isConnected) tabElement.classList.add('dragging');
  });
}

function startSessionDrag(event, sessionId) {
  sessionHoverCard.close();
  const sessionCard = event.currentTarget;
  const generation = ++dragGeneration;
  draggedItem = { type: 'session', sessionId, source: sessionCard, generation };
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-tmux-session', sessionId);
  event.dataTransfer.setData('text/plain', sessionId);
  document.body.classList.add('workspace-item-dragging');
  requestAnimationFrame(() => {
    if (draggedItem?.generation === generation && sessionCard.isConnected) sessionCard.classList.add('dragging');
  });
}

function startSessionGroupDrag(event, groupId) {
  sessionHoverCard.close();
  const source = event.currentTarget;
  const generation = ++dragGeneration;
  draggedItem = { type: 'session-group', groupId, source, generation };
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-workbench-session-group', groupId);
  event.dataTransfer.setData('text/plain', groupId);
  document.body.classList.add('workspace-item-dragging');
  requestAnimationFrame(() => {
    if (draggedItem?.generation === generation && source.isConnected) source.classList.add('dragging');
  });
}

function clearWorkspaceDrag() {
  stopSessionListDragScroll();
  const shouldRefreshSessions = deferredSessionRender;
  draggedItem = null;
  dragGeneration += 1;
  deferredSessionRender = false;
  document.body.classList.remove('workspace-item-dragging');
  elements.welcome.classList.remove('drag-target');
  for (const overlay of document.querySelectorAll('.editor-drop-overlay.is-active')) overlay.classList.remove('is-active');
  for (const preview of document.querySelectorAll('.editor-drop-preview')) preview.dataset.position = 'center';
  for (const item of document.querySelectorAll('.editor-tab.dragging, .editor-tab[data-drop-side], .session-card.dragging, .workspace-section-heading.dragging, .workspace-section-heading[data-drop-position], .session-card-row[data-drop-position]')) {
    item.classList.remove('dragging');
    delete item.dataset.dropSide;
    delete item.dataset.dropPosition;
  }
  if (shouldRefreshSessions) renderSessions();
}

function updateSessionListDragScroll(event) {
  for (const overlay of document.querySelectorAll('.editor-drop-overlay.is-active')) {
    if (!overlay.contains(event.target)) overlay.classList.remove('is-active');
  }
  const list = elements.sessionList;
  if (!['session', 'session-group'].includes(draggedItem?.type) || !list.contains(event.target)) {
    stopSessionListDragScroll();
    return;
  }
  const bounds = list.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
    stopSessionListDragScroll();
    return;
  }
  event.preventDefault();
  const edge = Math.min(64, bounds.height / 4);
  const topDistance = event.clientY - bounds.top;
  const bottomDistance = bounds.bottom - event.clientY;
  sessionListScrollSpeed = topDistance < edge ? -720 * (1 - topDistance / edge)
    : bottomDistance < edge ? 720 * (1 - bottomDistance / edge) : 0;
  if (!sessionListScrollSpeed) {
    stopSessionListDragScroll();
    return;
  }
  if (sessionListScrollFrame === null) sessionListScrollFrame = requestAnimationFrame(scrollSessionListDuringDrag);
}

function scrollSessionListDuringDrag(time) {
  sessionListScrollFrame = null;
  if (!['session', 'session-group'].includes(draggedItem?.type) || !sessionListScrollSpeed) {
    stopSessionListDragScroll();
    return;
  }
  const elapsed = sessionListScrollTime === null ? 16 : Math.min(32, time - sessionListScrollTime);
  sessionListScrollTime = time;
  const previousTop = elements.sessionList.scrollTop;
  elements.sessionList.scrollTop += sessionListScrollSpeed * elapsed / 1000;
  if (elements.sessionList.scrollTop === previousTop) {
    stopSessionListDragScroll();
    return;
  }
  sessionListScrollFrame = requestAnimationFrame(scrollSessionListDuringDrag);
}

function stopSessionListDragScroll() {
  if (sessionListScrollFrame !== null) cancelAnimationFrame(sessionListScrollFrame);
  sessionListScrollFrame = null;
  sessionListScrollSpeed = 0;
  sessionListScrollTime = null;
}

function dropItemInGroup(event, groupId, index) {
  event.preventDefault();
  if (!draggedItem) return;
  if (draggedItem.type === 'tab') {
    moveTab(workspace, draggedItem.tabId, groupId, index, ids.group);
  } else {
    const placed = placeSessionInGroup(workspace, draggedItem.sessionId, groupId, ids);
    if (placed) moveTab(workspace, placed.tab.id, groupId, index, ids.group);
  }
  clearWorkspaceDrag();
  commitWorkspace();
}

function showWelcomeDropTarget(event) {
  if (draggedItem?.type !== 'session') return;
  event.preventDefault();
  elements.welcome.classList.add('drag-target');
}

function dropSessionOnWelcome(event) {
  if (draggedItem?.type !== 'session') return;
  event.preventDefault();
  const session = sessions.find((candidate) => candidate.id === draggedItem.sessionId);
  clearWorkspaceDrag();
  if (session) openSessionTab(session, { pinned: true });
}

function splitActiveTab(groupId, position) {
  const group = findGroup(workspace, groupId);
  if (!group?.activeTabId) return;
  const active = group.tabs.find((tab) => tab.id === group.activeTabId);
  if (active?.kind === 'create') return;
  if (active?.file && isFileTabDirty(active)) {
    showToast('Save file changes before splitting this tab');
    return;
  }
  if (active) active.pinned = true;
  splitTab(workspace, group.activeTabId, groupId, position, ids, true);
  commitWorkspace();
}

function closeWorkspaceTab(tabId) {
  const found = findTabById(workspace, tabId);
  if (found?.tab.kind === 'create' && createInFlight) return;
  if (fileViews.get(tabId)?.saveInFlight) {
    showToast('Wait for the file save to finish before closing this tab');
    return;
  }
  if (found && isFileTabDirty(found.tab) && !confirmDiscardDirtyFiles([found.tab])) return;
  closeTab(workspace, tabId, ids.group);
  if (found?.tab.kind === 'create') {
    elements.createSessionForm.hidden = true;
    elements.createSessionButton.setAttribute('aria-expanded', 'false');
  }
  commitWorkspace();
}

function showTabContextMenu(event, groupId, keepTabId) {
  const group = findGroup(workspace, groupId);
  if (!group) return;
  showActionMenu(event, 'Tab actions', [{ label: 'Close other tabs', disabled: group.tabs.length < 2, run: () => closeOtherTabs(groupId, keepTabId) }]);
}

function showActionMenu(event, label, actions) {
  sessionHoverCard.close();
  closeTabContextMenu();
  const menu = document.createElement('div');
  menu.className = 'tab-context-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label);
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.textContent = action.label;
    button.disabled = Boolean(action.disabled);
    button.addEventListener('click', () => {
      closeTabContextMenu();
      action.run();
    });
    menu.append(button);
  }
  menu.addEventListener('pointerdown', (pointerEvent) => pointerEvent.stopPropagation());
  document.body.append(menu);
  menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8))}px`;
  const outsidePointerDown = (pointerEvent) => {
    if (!menu.contains(pointerEvent.target)) closeTabContextMenu();
  };
  const escapeKey = (keyEvent) => {
    if (keyEvent.key === 'Escape') {
      keyEvent.preventDefault();
      closeTabContextMenu();
    } else if (keyEvent.key === 'ArrowDown' || keyEvent.key === 'ArrowUp') {
      keyEvent.preventDefault();
      const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement);
      buttons[(index + (keyEvent.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }
  };
  tabContextMenu = { menu, outsidePointerDown, escapeKey };
  document.addEventListener('pointerdown', outsidePointerDown);
  document.addEventListener('keydown', escapeKey);
  menu.querySelector('button:not(:disabled)')?.focus();
}

function closeTabContextMenu() {
  if (!tabContextMenu) return;
  document.removeEventListener('pointerdown', tabContextMenu.outsidePointerDown);
  document.removeEventListener('keydown', tabContextMenu.escapeKey);
  tabContextMenu.menu.remove();
  tabContextMenu = null;
}

function closeOtherTabs(groupId, keepTabId) {
  const group = findGroup(workspace, groupId);
  if (!group) return;
  const closing = group.tabs.filter((tab) => tab.id !== keepTabId);
  if (closing.some((tab) => fileViews.get(tab.id)?.saveInFlight)) {
    showToast('Wait for file saves to finish before closing tabs');
    return;
  }
  if (!confirmDiscardDirtyFiles(closing)) return;
  for (const tab of closing) {
    if (tab.kind === 'create') {
      elements.createSessionForm.hidden = true;
      elements.createSessionButton.setAttribute('aria-expanded', 'false');
    }
    closeTab(workspace, tab.id, ids.group);
  }
  activateTab(workspace, groupId, keepTabId);
  commitWorkspace();
  if (closing.length) showToast(`Closed ${closing.length} other tab${closing.length === 1 ? '' : 's'}`);
}

function isFileTabDirty(tab) {
  return Boolean(tab?.file && (tab.dirty || fileViews.get(tab.id)?.isDirty));
}

function confirmDiscardDirtyFiles(tabs) {
  const dirtyNames = tabs.filter(isFileTabDirty).map((tab) => tab.file?.name || tab.file?.path || 'Untitled file');
  if (dirtyNames.length === 0) return true;
  const label = dirtyNames.length === 1 ? dirtyNames[0] : `${dirtyNames.length} files`;
  return window.confirm(`Discard unsaved changes to ${label}?`);
}

function setFileTabDirty(tabId, dirty) {
  const found = findTabById(workspace, tabId);
  if (!found?.tab.file) return;
  const nextDirty = Boolean(dirty);
  const wasDirty = Boolean(found.tab.dirty);
  const wasPinned = Boolean(found.tab.pinned);
  found.tab.dirty = nextDirty;
  if (nextDirty) found.tab.pinned = true;
  const item = [...document.querySelectorAll('.editor-tab[data-tab-id]')].find((candidate) => candidate.dataset.tabId === tabId);
  if (item) {
    item.classList.toggle('dirty', found.tab.dirty);
    const label = item.querySelector('.tab-label');
    if (label) label.textContent = `${found.tab.file.name || found.tab.file.path || 'File'}${found.tab.dirty ? ' •' : ''}`;
    const pin = item.querySelector('.tab-pin');
    if (pin) {
      pin.textContent = found.tab.pinned ? '●' : '○';
      pin.title = found.tab.dirty ? 'Unsaved files stay pinned' : found.tab.pinned ? 'Unpin file tab' : 'Pin file tab';
      pin.setAttribute('aria-label', pin.title);
    }
    const group = item.closest('.editor-group');
    for (const split of group?.querySelectorAll('.group-action.split-right, .group-action.split-down') ?? []) {
      split.disabled = found.tab.dirty;
      split.title = found.tab.dirty ? 'Save changes before splitting' : (split.classList.contains('split-right') ? 'Split right' : 'Split down');
      split.setAttribute('aria-label', split.title);
    }
  }
  if (wasDirty !== nextDirty || wasPinned !== Boolean(found.tab.pinned)) persistWorkspace();
}

function warnBeforeDiscardingUnsavedState(event) {
  const dirtyFiles = [...fileViews.values()].some((view) => view.isDirty);
  const unsyncedGroups = pendingSessionGroupOperations.length > 0 || sharedGroupsWriteInFlight;
  if (!dirtyFiles && !unsyncedGroups) return;
  event.preventDefault();
  event.returnValue = unsyncedGroups ? 'Group changes are waiting to sync.' : 'Unsaved file changes.';
}

function setActiveGroup(groupId) {
  if (workspace.activeGroupId === groupId) return;
  workspace.activeGroupId = groupId;
  persistWorkspace();
  for (const group of document.querySelectorAll('.editor-group')) {
    group.classList.toggle('active', group.dataset.groupId === groupId);
  }
  const session = sessionForTab(activeTab());
  fileBrowser?.setSession(session);
  gitPanel?.setSession(session);
  prPanel?.setSession(session);
  gitPanel?.setSelectedDiff(activeTab()?.diff ?? null);
  prPanel?.setSelectedDiff(activeTab()?.diff ?? null);
  elements.mobileActiveName.textContent = activeTab()?.kind === 'create' ? 'New session' : tabTitle(activeTab(), session);
  updateSessionCardStates();
}

function startSplitResize(event, node, split, first, second) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  document.body.classList.add(node.direction === 'horizontal' ? 'split-resizing-horizontal' : 'split-resizing-vertical');
  const move = (moveEvent) => {
    const rect = split.getBoundingClientRect();
    const ratio = node.direction === 'horizontal'
      ? (moveEvent.clientX - rect.left) / rect.width
      : (moveEvent.clientY - rect.top) / rect.height;
    resizeSplit(workspace, node.id, ratio);
    first.style.flexBasis = `${node.ratio * 100}%`;
    second.style.flexBasis = `${(1 - node.ratio) * 100}%`;
  };
  const stop = (stopEvent) => {
    event.currentTarget.removeEventListener('pointermove', move);
    event.currentTarget.removeEventListener('pointerup', stop);
    event.currentTarget.removeEventListener('pointercancel', stop);
    if (event.currentTarget.hasPointerCapture(stopEvent.pointerId)) event.currentTarget.releasePointerCapture(stopEvent.pointerId);
    document.body.classList.remove('split-resizing-horizontal', 'split-resizing-vertical');
    persistWorkspace();
  };
  event.currentTarget.addEventListener('pointermove', move);
  event.currentTarget.addEventListener('pointerup', stop);
  event.currentTarget.addEventListener('pointercancel', stop);
}

function resizeSplitWithKeyboard(event, node) {
  const delta = event.shiftKey ? 0.1 : 0.04;
  const decrease = node.direction === 'horizontal' ? event.key === 'ArrowLeft' : event.key === 'ArrowUp';
  const increase = node.direction === 'horizontal' ? event.key === 'ArrowRight' : event.key === 'ArrowDown';
  if (!decrease && !increase) return;
  event.preventDefault();
  resizeSplit(workspace, node.id, node.ratio + (increase ? delta : -delta));
  persistWorkspace();
  renderWorkspace();
}

function syncEditors() {
  const tabs = groupsInOrder(workspace.root).flatMap((group) => group.tabs);
  const liveTabIds = new Set(tabs.map((tab) => tab.id));
  for (const [tabId, editor] of editorViews) {
    const tab = tabs.find((item) => item.id === tabId);
    if (liveTabIds.has(tabId) && !tab?.file && !tab?.diff) continue;
    editor.destroy();
    editorViews.delete(tabId);
  }
  for (const [tabId, editor] of fileViews) {
    const tab = tabs.find((item) => item.id === tabId);
    if (liveTabIds.has(tabId) && tab?.file && editor.fileKey === tab.fileKey) continue;
    editor.destroy();
    fileViews.delete(tabId);
  }
  for (const [tabId, editor] of diffViews) {
    const tab = tabs.find((item) => item.id === tabId);
    if (liveTabIds.has(tabId) && tab?.diff && editor.diffKey === tab.diffKey) continue;
    editor.destroy();
    diffViews.delete(tabId);
  }
  for (const tab of tabs) {
    const liveSession = sessions.find((session) => session.id === tab.sessionId);
    if (tab.diff) {
      if (!liveSession) continue;
      if (!diffViews.has(tab.id)) {
        const view = new GitDiffEditor(tab.id, liveSession, tab.diff, { getTheme: () => resolvedTheme });
        view.diffKey = tab.diffKey || gitDiffKey(tab.sessionId, tab.diff);
        diffViews.set(tab.id, view);
        if (tab.diff.kind === 'pr') {
          if (prPanel?.sessionId === tab.sessionId && prPanel.snapshot) void view.setPRStatus(prPanel.snapshot);
        } else if (gitPanel?.sessionId === tab.sessionId && gitPanel.snapshot) void view.setGitStatus(gitPanel.snapshot);
      }
      continue;
    }
    if (tab.file) {
      if (!liveSession) continue;
      if (!fileViews.has(tab.id)) {
        const view = new FileEditor(tab.id, liveSession, tab.file, {
          getTheme: () => resolvedTheme,
          onToast: showToast,
          onDirtyChange: setFileTabDirty,
        });
        view.fileKey = tab.fileKey;
        fileViews.set(tab.id, view);
      }
      continue;
    }
    const existing = editorViews.get(tab.id);
    if (existing) {
      existing.updateSession(liveSession ?? existing.session, Boolean(liveSession));
      continue;
    }
    if (!liveSession) continue;
    editorViews.set(tab.id, new SessionEditor(tab.id, liveSession, {
      getTerminalTheme: () => terminalThemes[resolvedTheme],
      getAutoFollow: () => readerAutoFollow,
      onAutoFollowChange: setReaderAutoFollow,
      onFocus: focusEditorTab,
      onRename: renameSession,
      onToast: showToast,
    }));
  }
}

function focusEditorTab(tabId) {
  for (const group of groupsInOrder(workspace.root)) {
    if (group.activeTabId !== tabId) continue;
    setActiveGroup(group.id);
    return;
  }
}

async function renameSession(sessionID, name) {
  const response = await fetch('/api/sessions/rename', {
    method: 'PATCH',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: sessionID, name }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Could not rename session');
  sessions = sessions.map((session) => (session.id === sessionID ? { ...session, name: body.name || name } : session));
  syncEditors();
  refreshWorkspaceSessions();
  renderSessions();
  showToast(`Renamed to ${body.name || name}`);
  loadSessions(false);
}

function commitWorkspace() {
  persistWorkspace();
  renderWorkspace();
}

function activeTab() {
  const group = findGroup(workspace, workspace.activeGroupId);
  return group?.tabs.find((tab) => tab.id === group.activeTabId) ?? null;
}

function sessionForTab(tab) {
  if (!tab) return null;
  return sessions.find((session) => session.id === tab.sessionId) ?? editorViews.get(tab.id)?.session ?? fileViews.get(tab.id)?.session ?? diffViews.get(tab.id)?.session ?? null;
}

function diffTabName(diff) {
  return diff?.name || String(diff?.path || 'Git change').replace(/\\/g, '/').split('/').at(-1) || 'Git change';
}

function tabTitle(tab, session = sessionForTab(tab)) {
  if (tab?.diff) return `${tab.diff.kind === 'pr' ? `PR #${tab.diff.number}` : 'Diff'} · ${diffTabName(tab.diff)}`;
  return tab?.file?.name ?? session?.name ?? (tab?.sessionId ? 'Session ended' : 'Sessions');
}

function readStoredWorkspace() {
  try {
    return JSON.parse(localStorage.getItem(workspaceSetting));
  } catch {
    return null;
  }
}

function persistWorkspace() {
  try {
    const stored = workspaceForStorage(workspace);
    if (stored) localStorage.setItem(workspaceSetting, JSON.stringify(stored));
    else localStorage.removeItem(workspaceSetting);
  } catch {
    // The current page keeps working when browser storage is unavailable.
  }
}

function readReaderAutoFollow() {
  try {
    return localStorage.getItem(readerAutoFollowSetting) === 'true';
  } catch {
    return false;
  }
}

function setReaderAutoFollow(value) {
  readerAutoFollow = Boolean(value);
  try {
    localStorage.setItem(readerAutoFollowSetting, String(readerAutoFollow));
  } catch {
    // The current page keeps working when browser storage is unavailable.
  }
  for (const editor of editorViews.values()) editor.updateAutoFollow();
}

function applyTheme(setting, persist = true) {
  themeSetting = persist ? storeThemeSetting(setting) : setting;
  resolvedTheme = resolveTheme(themeSetting, systemThemeQuery.matches);
  document.documentElement.dataset.theme = themeSetting;
  document.documentElement.dataset.colorScheme = resolvedTheme;
  document.querySelector('meta[name="theme-color"]').content = resolvedTheme === 'dark' ? '#18181b' : '#fafafa';
  elements.themeButton.dataset.themeSetting = themeSetting;
  const label = capitalize(themeSetting);
  const resolvedLabel = capitalize(resolvedTheme);
  const next = nextThemeSetting(themeSetting);
  const description = `Theme: ${label}${themeSetting === 'system' ? ` (${resolvedLabel})` : ''}. Switch to ${capitalize(next)}`;
  elements.themeButton.title = description;
  elements.themeButton.setAttribute('aria-label', description);
  for (const editor of editorViews.values()) editor.updateTheme();
  for (const editor of fileViews.values()) editor.applyTheme();
  for (const editor of diffViews.values()) editor.applyTheme();
  gitPanel?.applyTheme();
  prPanel?.applyTheme?.();
}

function startCreateSession() {
  if (createInFlight) return;
  const existing = findCreateTab(workspace);
  if (!existing) {
    const activePath = sessionForTab(activeTab())?.path;
    elements.createSessionPath.value = activePath || recentSessionPaths()[0] || '';
    elements.createSessionPathSearch.value = '';
  }
  renderCreateSessionOptions();
  openCreateTab(workspace, ids.tab);
  elements.createSessionForm.hidden = false;
  elements.createSessionButton.setAttribute('aria-expanded', 'true');
  setMobileSidebarOpen(false);
  commitWorkspace();
  requestAnimationFrame(() => {
    elements.createSessionPath.focus();
    if (!existing) elements.createSessionPath.select();
  });
}

function cancelCreateSession(restoreFocus) {
  if (createInFlight) return;
  const found = findCreateTab(workspace);
  elements.createSessionForm.hidden = true;
  elements.createSessionButton.setAttribute('aria-expanded', 'false');
  if (found) {
    closeTab(workspace, found.tab.id, ids.group);
    commitWorkspace();
  }
  if (restoreFocus) requestAnimationFrame(() => elements.createSessionButton.focus());
}

async function createSession() {
  if (createInFlight) return;
  const workingDirectory = elements.createSessionPath.value.trim();
  if (!workingDirectory) {
    showToast('Enter a working directory');
    elements.createSessionPath.focus();
    return;
  }
  createInFlight = true;
  elements.createSessionPath.disabled = true;
  elements.createSessionPathSearch.disabled = true;
  elements.createSessionSave.disabled = true;
  elements.createSessionCancel.disabled = true;
  renderCreateSessionOptions();
  renderSessions();
  try {
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: workingDirectory }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Could not create session');
    if (!body.session?.id || !body.session?.name || !body.session?.path) throw new Error('Invalid session response');
    pendingCreatedSession = body.session;
    sessions = [...sessions.filter((item) => item.id !== body.session.id), body.session];
    if (!replaceCreateTab(workspace, body.session.id)) openSession(workspace, body.session.id, ids.tab);
    rememberRecentPath(body.session.path);
    elements.createSessionForm.hidden = true;
    elements.createSessionButton.setAttribute('aria-expanded', 'false');
    showToast(`Created ${body.session.name}`);
    commitWorkspace();
    loadSessions(false);
  } catch (error) {
    showToast(error.message || 'Could not create session');
    elements.createSessionPath.focus();
    elements.createSessionPath.select();
  } finally {
    createInFlight = false;
    elements.createSessionPath.disabled = false;
    elements.createSessionPathSearch.disabled = false;
    elements.createSessionSave.disabled = false;
    elements.createSessionCancel.disabled = false;
    renderCreateSessionOptions();
    renderSessions();
  }
}

function renderCreateSessionOptions() {
  elements.createSessionName.textContent = nextNumericSessionName(sessions);
  elements.recentSessionPaths.replaceChildren();
  const query = elements.createSessionPathSearch.value.trim();
  const paths = sessionPathOptions(recentPaths, sessions, maximumRecentPaths, query);
  if (paths.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'create-session-recent-empty';
    empty.textContent = query ? 'No matching paths.' : 'No recent or session paths yet.';
    elements.recentSessionPaths.append(empty);
    return;
  }
  for (const path of paths) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'create-session-recent-path';
    button.title = path;
    button.disabled = createInFlight;
    const icon = document.createElement('span');
    icon.className = 'create-session-recent-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = recentPaths.includes(path) ? '↺' : '⌘';
    const label = document.createElement('span');
    label.textContent = path;
    button.append(icon, label);
    button.addEventListener('click', () => {
      if (createInFlight) return;
      elements.createSessionPath.value = path;
      elements.createSessionPath.focus();
    });
    elements.recentSessionPaths.append(button);
  }
}

function recentSessionPaths() {
  return sessionPathOptions(recentPaths, [], maximumRecentPaths);
}

function rememberRecentPath(path) {
  const updated = addRecentPath(recentPaths, path, maximumRecentPaths);
  if (updated === recentPaths) return;
  recentPaths = updated;
  try {
    localStorage.setItem(recentPathsSetting, JSON.stringify(recentPaths));
  } catch {
    // The current page retains recent paths when browser storage is unavailable.
  }
  renderCreateSessionOptions();
}

function readRecentPaths() {
  try {
    const stored = JSON.parse(localStorage.getItem(recentPathsSetting));
    if (!Array.isArray(stored)) return [];
    return sessionPathOptions(stored, [], maximumRecentPaths);
  } catch {
    return [];
  }
}

function clearSessionSearch() {
  elements.sessionSearch.value = '';
  updateSessionSearch();
}

function restoreSessionSearch() {
  elements.sessionSearch.value = new URLSearchParams(location.search).get('q') ?? '';
  updateSessionSearch(false);
}

function updateSessionSearch(updateURL = true) {
  const query = elements.sessionSearch.value;
  elements.sessionSearchClear.hidden = query.length === 0;
  if (updateURL) {
    const url = new URL(location.href);
    if (query) url.searchParams.set('q', query);
    else url.searchParams.delete('q');
    const next = `${url.pathname}${url.search}${url.hash}`;
    if (next !== `${location.pathname}${location.search}${location.hash}`) {
      history.replaceState(history.state, '', next);
    }
  }
  const label = query.trim();
  document.title = label ? `${label} · Workbench` : 'Workbench · tmux sessions';
  renderSessions();
}

function renderSessionError() {
  sessionHoverCard.close();
  if (draggedItem?.type === 'session' && draggedItem.source?.isConnected) {
    deferredSessionRender = true;
    return;
  }
  elements.sessionList.replaceChildren();
  const error = document.createElement('button');
  error.type = 'button';
  error.className = 'session-error';
  error.textContent = 'Could not load. Retry';
  error.addEventListener('click', () => loadSessions(false));
  elements.sessionList.append(error);
}

function readSidebarCollapsed() {
  try { return localStorage.getItem(sidebarCollapsedSetting) === 'true'; }
  catch { return false; }
}

function applySidebarCollapsed(persist = true) {
  const focusInSidebar = elements.sidebar.contains(document.activeElement);
  document.documentElement.classList.toggle('workspaces-collapsed', sidebarCollapsed);
  elements.workspacesToggle.setAttribute('aria-expanded', String(!sidebarCollapsed));
  const label = sidebarCollapsed ? 'Show workspaces' : 'Hide workspaces';
  elements.workspacesToggle.title = label;
  elements.workspacesToggle.setAttribute('aria-label', label);
  if (!mobileLayoutQuery.matches) {
    elements.sidebar.inert = sidebarCollapsed;
    elements.sidebar.setAttribute('aria-hidden', String(sidebarCollapsed));
    if (sidebarCollapsed) {
      sessionHoverCard.close();
      clearWorkspaceDrag();
      if (focusInSidebar) elements.workspacesToggle.focus({ preventScroll: true });
    }
  }
  applyFilesWidth(filesWidth, false);
  if (persist) {
    try { localStorage.setItem(sidebarCollapsedSetting, String(sidebarCollapsed)); }
    catch { /* The current page still keeps its collapse state. */ }
  }
}

function readSidebarWidth() {
  try {
    const stored = Number.parseFloat(localStorage.getItem(sidebarWidthSetting));
    return Number.isFinite(stored) ? stored : defaultSidebarWidth;
  } catch {
    return defaultSidebarWidth;
  }
}

function sidebarWidthBounds() {
  const minimum = window.innerWidth <= 760 ? compactMinimumSidebarWidth : minimumSidebarWidth;
  const availableWidth = Math.max(minimum, window.innerWidth - minimumWorkspaceWidth);
  return { minimum, maximum: Math.max(minimum, Math.min(maximumSidebarWidth, availableWidth)) };
}

function applySidebarWidth(width, persist = true) {
  const { minimum, maximum } = sidebarWidthBounds();
  sidebarWidth = Math.max(minimum, Math.min(maximumSidebarWidth, Math.round(width)));
  const appliedWidth = Math.min(sidebarWidth, maximum);
  document.documentElement.style.setProperty('--sidebar-width', `${appliedWidth}px`);
  elements.sidebarResizer.setAttribute('aria-valuemin', String(minimum));
  elements.sidebarResizer.setAttribute('aria-valuemax', String(maximum));
  elements.sidebarResizer.setAttribute('aria-valuenow', String(appliedWidth));
  elements.sidebarResizer.title = `Sidebar width: ${appliedWidth}px. Double-click to reset`;
  if (persist) {
    try {
      localStorage.setItem(sidebarWidthSetting, String(sidebarWidth));
    } catch {
      // The current page keeps working when browser storage is unavailable.
    }
  }
}

function readFilesWidth() {
  try {
    const stored = Number.parseFloat(localStorage.getItem(filesWidthSetting));
    return Number.isFinite(stored) ? stored : 270;
  } catch {
    return 270;
  }
}

function readFilesVisible() {
  try {
    return localStorage.getItem(filesVisibleSetting) !== 'false';
  } catch {
    return true;
  }
}

function isRightSidebarVisible() {
  return mobileLayoutQuery.matches ? Boolean(mobileFilesController?.isOpen) : filesVisible;
}

function setRightPanel(panel, resize = true) {
  activeRightPanel = ['git', 'pr'].includes(panel) ? panel : 'files';
  for (const [name, button, content] of [
    ['files', elements.filesTab, elements.filesContent],
    ['git', elements.gitTab, elements.gitContent],
    ['pr', elements.prTab, elements.prContent],
  ]) {
    const selected = activeRightPanel === name;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    content.hidden = !selected;
    content.inert = !selected;
    content.setAttribute('aria-hidden', String(!selected));
  }
  gitPanel?.setVisible(activeRightPanel === 'git' && isRightSidebarVisible());
  prPanel?.setVisible(activeRightPanel === 'pr' && isRightSidebarVisible());
  if (resize) requestAnimationFrame(() => {
    if (activeRightPanel === 'git') gitPanel?.layout();
    else if (activeRightPanel === 'pr') prPanel?.layout?.();
  });
}

function applyFilesWidth(width, persist = true) {
  const leftWidth = mobileLayoutQuery.matches || sidebarCollapsed ? 0
    : Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width')) || defaultSidebarWidth;
  const maximum = Math.max(200, Math.min(520, window.innerWidth - leftWidth - minimumWorkspaceWidth - 6));
  filesWidth = Math.max(200, Math.min(maximum, Math.round(width)));
  document.documentElement.style.setProperty('--files-width', `${filesWidth}px`);
  elements.filesResizer.setAttribute('aria-valuenow', String(filesWidth));
  if (persist) {
    try { localStorage.setItem(filesWidthSetting, String(filesWidth)); } catch { /* Keep the width for this page. */ }
  }
}

function applyFilesPanel(persist = true) {
  document.documentElement.classList.toggle('files-hidden', !filesVisible);
  gitPanel?.setVisible(activeRightPanel === 'git' && isRightSidebarVisible());
  prPanel?.setVisible(activeRightPanel === 'pr' && isRightSidebarVisible());
  elements.filesToggle.setAttribute('aria-expanded', String(filesVisible));
  elements.filesToggle.title = filesVisible ? 'Hide files' : 'Show files';
  elements.filesToggle.setAttribute('aria-label', elements.filesToggle.title);
  elements.filesResizer.hidden = !filesVisible;
  if (persist) {
    try { localStorage.setItem(filesVisibleSetting, String(filesVisible)); } catch { /* Keep visibility for this page. */ }
  }
}

function startFilesResize(event) {
  if (event.button !== 0 || !filesVisible) return;
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  document.body.classList.add('files-resizing');
  const startX = event.clientX;
  const startWidth = filesWidth;
  const move = (moveEvent) => applyFilesWidth(startWidth + startX - moveEvent.clientX, false);
  const stop = (stopEvent) => {
    event.currentTarget.removeEventListener('pointermove', move);
    event.currentTarget.removeEventListener('pointerup', stop);
    event.currentTarget.removeEventListener('pointercancel', stop);
    if (event.currentTarget.hasPointerCapture(stopEvent.pointerId)) event.currentTarget.releasePointerCapture(stopEvent.pointerId);
    document.body.classList.remove('files-resizing');
    applyFilesWidth(filesWidth);
  };
  event.currentTarget.addEventListener('pointermove', move);
  event.currentTarget.addEventListener('pointerup', stop);
  event.currentTarget.addEventListener('pointercancel', stop);
}

function resizeFilesWithKeyboard(event) {
  const increase = event.key === 'ArrowLeft';
  const decrease = event.key === 'ArrowRight';
  if (!increase && !decrease) return;
  event.preventDefault();
  applyFilesWidth(filesWidth + (increase ? 20 : -20));
}

function startSidebarResize(event) {
  if (event.button !== 0 || mobileLayoutQuery.matches || sidebarCollapsed) return;
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = elements.sidebar.getBoundingClientRect().width;
  elements.sidebarResizer.setPointerCapture(event.pointerId);
  document.body.classList.add('sidebar-resizing');
  const move = (moveEvent) => applySidebarWidth(startWidth + moveEvent.clientX - startX, false);
  const stop = (stopEvent) => {
    elements.sidebarResizer.removeEventListener('pointermove', move);
    elements.sidebarResizer.removeEventListener('pointerup', stop);
    elements.sidebarResizer.removeEventListener('pointercancel', stop);
    if (elements.sidebarResizer.hasPointerCapture(stopEvent.pointerId)) elements.sidebarResizer.releasePointerCapture(stopEvent.pointerId);
    document.body.classList.remove('sidebar-resizing');
    applySidebarWidth(elements.sidebar.getBoundingClientRect().width);
  };
  elements.sidebarResizer.addEventListener('pointermove', move);
  elements.sidebarResizer.addEventListener('pointerup', stop);
  elements.sidebarResizer.addEventListener('pointercancel', stop);
}

function resizeSidebarWithKeyboard(event) {
  if (mobileLayoutQuery.matches || sidebarCollapsed) return;
  const { minimum, maximum } = sidebarWidthBounds();
  const appliedWidth = elements.sidebar.getBoundingClientRect().width;
  const step = event.shiftKey ? 40 : 16;
  let nextWidth;
  if (event.key === 'ArrowLeft') nextWidth = appliedWidth - step;
  if (event.key === 'ArrowRight') nextWidth = appliedWidth + step;
  if (event.key === 'Home') nextWidth = minimum;
  if (event.key === 'End') nextWidth = maximum;
  if (nextWidth === undefined) return;
  event.preventDefault();
  applySidebarWidth(nextWidth);
}

function setMobileSidebarOpen(open, restoreFocus = false) {
  if (!mobileLayoutQuery.matches) return;
  elements.sidebar.classList.toggle('open', open);
  elements.sidebarBackdrop.hidden = !open;
  elements.mobileSessionToggle.setAttribute('aria-expanded', String(open));
  elements.mobileSessionToggle.setAttribute('aria-label', open ? 'Sessions open' : 'Open sessions');
  elements.sidebar.setAttribute('aria-hidden', String(!open));
  elements.sidebar.inert = !open;
  document.body.classList.toggle('mobile-sidebar-open', open);
  if (open) requestAnimationFrame(() => elements.mobileSidebarClose.focus());
  else if (restoreFocus) elements.mobileSessionToggle.focus();
}

function syncMobileSidebar() {
  mobileFilesController?.setOpen(false);
  if (mobileLayoutQuery.matches) {
    if (document.activeElement === elements.workspacesToggle) elements.mobileSessionToggle.focus();
    const open = elements.sidebar.classList.contains('open');
    elements.sidebarBackdrop.hidden = !open;
    elements.sidebar.setAttribute('aria-hidden', String(!open));
    elements.sidebar.inert = !open;
    elements.mobileSessionToggle.setAttribute('aria-expanded', String(open));
  } else {
    if (document.activeElement === elements.mobileSessionToggle || document.activeElement === elements.mobileSidebarClose
      || (sidebarCollapsed && elements.sidebar.contains(document.activeElement))) elements.workspacesToggle.focus();
    elements.sidebar.classList.remove('open');
    elements.sidebar.setAttribute('aria-hidden', String(sidebarCollapsed));
    elements.sidebar.inert = sidebarCollapsed;
    elements.sidebarBackdrop.hidden = true;
    elements.mobileSessionToggle.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('mobile-sidebar-open');
  }
}

function relativeTime(value) {
  const timestamp = new Date(value).getTime();
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
  return formatter.format(Math.round(hours / 24), 'day');
}

function plural(count, word) {
  return count === 1 ? word : `${word}s`;
}

function capitalize(value) {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  toastTimer = setTimeout(() => elements.toast.classList.remove('visible'), 2200);
}

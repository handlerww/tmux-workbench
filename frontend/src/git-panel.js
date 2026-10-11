import './git-panel.css';
import { makeTreeIcon, makeTreeDisclosure } from './file-tree-icons.js';
import { changeVariants, checkSummary, buildChangesTree, flattenChangesTree } from './git-panel-utils.js';

const REPO_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 3h11a1 1 0 0 1 1 1v13H5a2 2 0 0 1-2-2V4a1 1 0 0 1 1-1Zm0 10h12M6 6h6M6 9h4"/></svg>';
const BRANCH_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="5" cy="4" r="2"/><circle cx="5" cy="16" r="2"/><circle cx="15" cy="5" r="2"/><path d="M5 6v8m10-7c0 5-10 1-10 7"/></svg>';
const PR_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="5" cy="4" r="2"/><circle cx="5" cy="16" r="2"/><circle cx="15" cy="16" r="2"/><path d="M5 6v8m10 0V7a3 3 0 0 0-3-3H9m3-3L9 4l3 3"/></svg>';
const REFRESH_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16.4 8a6.7 6.7 0 0 0-11.6-2L3.4 8M3.4 4.5V8h3.5M3.6 12a6.7 6.7 0 0 0 11.6 2l1.4-2M16.6 15.5V12h-3.5"/></svg>';

function apiURL(endpoint, params) {
  const query = new URLSearchParams(params);
  return `${endpoint}?${query}`;
}

async function readJSON(response) {
  let body = {};
  try { body = await response.json(); } catch { /* status fallback below */ }
  if (!response.ok) throw new GitAPIError(body.error || `HTTP ${response.status}`, response.status, body);
  return body;
}

class GitAPIError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'GitAPIError';
    this.status = status;
    this.body = body;
  }
}

function pathLabel(path) {
  return String(path ?? '').replace(/\\/g, '/');
}

export function changeKey(path, kind) {
  return `${kind}\n${path}`;
}

export function safePRURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export class GitPanel {
  constructor(container, { getTheme = () => 'dark', onToast, onOpenDiff, onSnapshot, isVisible = () => true } = {}) {
    this.container = container;
    this.getTheme = getTheme;
    this.onToast = onToast;
    this.onOpenDiff = onOpenDiff;
    this.onSnapshot = onSnapshot;
    this.collapsedFolders = new Set();
    this.isPanelVisible = isVisible;
    this.session = null;
    this.sessionId = null;
    this.generation = 0;
    this.fetchController = null;
    this.recommendationController = null;
    this.associationController = null;
    this.associationWriteInFlight = false;
    this.recommendationSequence = 0;
    this.recommendationItems = [];
    this.recommendationTimer = null;
    this.refreshTimer = window.setInterval(() => {
      if (this.visible && this.isPanelVisible() && !document.hidden && this.session) void this.refresh({ quiet: true });
    }, 15000);
    this.snapshot = null;
    this.prSignature = null;
    this.selectedChangeKey = null;
    this.selectedChange = null;
    this.changesSignature = null;
    this.visible = false;
    this.destroyed = false;

    this.element = document.createElement('section');
    this.element.className = 'git-panel';
    this.element.innerHTML = `
      <header class="git-panel-heading">
        <strong>Source control</strong>
        <button class="git-refresh" type="button" title="Refresh Git status" aria-label="Refresh Git status">${REFRESH_ICON}</button>
      </header>
      <div class="git-panel-scroll">
        <div class="git-session-status" role="status">Choose a session to inspect its repository.</div>
        <section class="git-repository-card" aria-label="Repository status" hidden>
          <div class="git-repo-heading">
            <span class="git-repo-icon">${REPO_ICON}</span>
            <strong class="git-repo-name"></strong>
            <span class="git-association-mode"></span>
            <button class="git-unbind-repository" type="button" hidden>Unbind</button>
          </div>
          <div class="git-repo-path"></div>
          <div class="git-repo-meta"></div>
        </section>
        <section class="git-association" aria-label="Repository association">
          <div class="git-association-heading">${REPO_ICON}<strong>Connect a repository</strong></div>
          <p class="git-association-note"></p>
          <div class="git-repository-picker" hidden>
          <label class="git-repository-search-label" for="git-repository-search">Choose a repository</label>
          <input id="git-repository-search" class="git-repository-search" type="search" placeholder="Search session repositories" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-controls="git-recommendations" aria-describedby="git-search-scope" aria-expanded="false" />
          <p id="git-search-scope" class="git-association-note"></p>
          <div id="git-recommendations" class="git-recommendations" role="listbox" aria-label="Recommended repositories" hidden></div>
          </div>
        </section>
        <section class="git-pr-card" aria-label="Pull request status" hidden></section>
        <section class="git-changes-section" aria-label="Working tree changes">
          <div class="git-section-heading"><strong>Changes</strong><span class="git-change-count"></span></div>
          <input class="git-changes-filter" type="search" placeholder="Filter changed files" aria-label="Filter changed files" autocomplete="off" />
          <div class="git-changes-list" role="tree" aria-label="Changed files"></div>
        </section>
      </div>
    `;
    this.container.replaceChildren(this.element);
    this.statusElement = this.element.querySelector('.git-session-status');
    this.repoCard = this.element.querySelector('.git-repository-card');
    this.associationSection = this.element.querySelector('.git-association');
    this.repoNameElement = this.element.querySelector('.git-repo-name');
    this.repoPathElement = this.element.querySelector('.git-repo-path');
    this.repoMetaElement = this.element.querySelector('.git-repo-meta');
    this.associationMode = this.element.querySelector('.git-association-mode');
    this.associationNote = this.element.querySelector('.git-association-note');
    this.repositoryPicker = this.element.querySelector('.git-repository-picker');
    this.changesSection = this.element.querySelector('.git-changes-section');
    this.searchInput = this.element.querySelector('.git-repository-search');
    this.searchScope = this.element.querySelector('#git-search-scope');
    this.recommendations = this.element.querySelector('.git-recommendations');
    this.unbindRepositoryButton = this.element.querySelector('.git-unbind-repository');
    this.prCard = this.element.querySelector('.git-pr-card');
    this.changeCount = this.element.querySelector('.git-change-count');
    this.changesList = this.element.querySelector('.git-changes-list');
    this.changesFilter = this.element.querySelector('.git-changes-filter');
    this.onFilterChanges = () => this.renderChanges(this.snapshot?.changes || []);
    this.changesFilter.addEventListener('input', this.onFilterChanges);
    this.refreshButton = this.element.querySelector('.git-refresh');
    this.onRefreshClick = () => void this.refresh();
    this.onSearchInput = () => this.scheduleRecommendations(this.searchInput.value);
    this.onUnbindRepositoryClick = () => void this.saveAssociation(null);
    this.onChangesClick = event => {
      const folder = event.target.closest('[data-git-folder]');
      if (folder) { this.toggleFolder(folder.dataset.gitFolder); return; }
      const button = event.target.closest('[data-change-path][data-change-kind]');
      if (button) this.openDiff(button.dataset.changePath, button.dataset.changeKind, button.dataset.changeOldPath || undefined);
    };
    this.onChangesDoubleClick = event => {
      const button = event.target.closest('[data-change-path][data-change-kind]');
      if (button) this.openDiff(button.dataset.changePath, button.dataset.changeKind, button.dataset.changeOldPath || undefined, { pinned: true });
    };
    this.onTreeKeydown = event => this.handleTreeKeydown(event);
    this.refreshButton.addEventListener('click', this.onRefreshClick);
    this.searchInput.addEventListener('input', this.onSearchInput);
    this.unbindRepositoryButton.addEventListener('click', this.onUnbindRepositoryClick);
    this.changesList.addEventListener('click', this.onChangesClick);
    this.changesList.addEventListener('dblclick', this.onChangesDoubleClick);
    this.changesList.addEventListener('keydown', this.onTreeKeydown);
    this.updateSearchScope();
    this.status('Select a tmux session to load Git status.');
  }

  setSession(session) {
    const nextId = session?.id ?? null;
    if (nextId === this.sessionId && session?.path === this.session?.path) {
      this.session = session ?? null;
      return;
    }
    this.changesFilter.value = '';
    this.collapsedFolders = new Set();
    this.generation += 1;
    this.abortRequests();
    this.associationWriteInFlight = false;
    this.searchInput.value = '';
    this.recommendationItems = [];
    this.unbindRepositoryButton.disabled = false;
    this.recommendations.replaceChildren();
    this.recommendations.hidden = true;
    this.searchInput.setAttribute('aria-expanded', 'false');
    this.session = session ?? null;
    this.sessionId = nextId;
    this.updateSearchScope();
    this.snapshot = null;
    this.prSignature = null;
    this.selectedChangeKey = null;
    this.selectedChange = null;
    this.changesSignature = null;
    this.renderSnapshot();
    if (!session) {
      this.status('Choose a tmux session to inspect its repository.');
      this.recommendations.hidden = true;
      this.searchInput.disabled = true;
      this.unbindRepositoryButton.hidden = true;
      return;
    }
    this.searchInput.disabled = true;
    this.status(`Loading Git status for ${session.name || 'session'}…`);
    void this.refresh();
  }

  async refresh({ quiet = false } = {}) {
    if (!this.session || this.destroyed) return;
    const generation = this.generation;
    this.fetchController?.abort();
    const controller = new AbortController();
    this.fetchController = controller;
    if (!quiet) this.status('Refreshing Git status…');
    try {
      const response = await fetch(apiURL('/api/git', { session: this.session.id }), {
        headers: { Accept: 'application/json' }, signal: controller.signal,
      });
      const body = await readJSON(response);
      if (this.destroyed || generation !== this.generation || controller.signal.aborted) return;
      const previousPath = this.snapshot?.association?.path;
      if (previousPath !== body.association?.path) {
        this.selectedChangeKey = null;
        this.selectedChange = null;
      }
      this.snapshot = body;
      this.searchInput.disabled = this.associationWriteInFlight;
      this.renderSnapshot();
      this.updateRecommendationsEnabled();
      if (!body.association?.path && (previousPath !== body.association?.path || !this.recommendationItems.length)) {
        this.scheduleRecommendations(this.searchInput.value);
      }
      if (body.repositoryError) this.status(body.repositoryError, true);
      else if (!body.repository && body.association?.path) this.status(`Pinned repository is unavailable: ${body.association.path}`, true);
      else this.status('');
      return true;
    } catch (error) {
      if (error.name === 'AbortError' || generation !== this.generation) return false;
      if (!quiet || !this.snapshot) this.status(error.message || 'Could not load Git status.', true);
      return false;
    } finally {
      if (this.fetchController === controller) this.fetchController = null;
    }
  }

  renderSnapshot() {
    const snapshot = this.snapshot;
    if (!snapshot) {
      this.repoCard.hidden = true;
      this.associationSection.hidden = true;
      this.prCard.hidden = true;
      this.changeCount.textContent = '';
      this.changesList.replaceChildren();
      this.associationMode.textContent = '';
      this.associationNote.textContent = '';
      this.unbindRepositoryButton.hidden = true;
      this.repositoryPicker.hidden = true;
      this.changesSection.hidden = true;
      return;
    }
    const repository = snapshot.repository;
    const association = snapshot.association || { path: null, manual: false, revision: null };
    const bound = Boolean(association.path);
    const repositoryPath = repository?.path || association.path || '';
    this.repoCard.hidden = !bound;
    this.associationSection.hidden = bound;
    this.repoNameElement.textContent = pathLabel(repositoryPath).split('/').filter(Boolean).at(-1) || repositoryPath;
    this.repoNameElement.title = repositoryPath;
    this.repoPathElement.textContent = repositoryPath;
    this.repoPathElement.title = repositoryPath;
    this.repoMetaElement.replaceChildren();
    if (repository) {
      const branch = document.createElement('span');
      branch.className = 'git-branch';
      branch.innerHTML = BRANCH_ICON;
      const name = document.createElement('span');
      name.textContent = repository.branch || 'detached HEAD';
      branch.title = name.textContent;
      branch.append(name);
      this.repoMetaElement.append(branch);
      for (const [value, title] of [
        [repository.head?.slice(0, 8), repository.head],
        [repository.ahead ? `↑${repository.ahead}` : '', 'Commits ahead of upstream'],
        [repository.behind ? `↓${repository.behind}` : '', 'Commits behind upstream'],
      ]) {
        if (!value) continue;
        const item = document.createElement('span');
        item.className = 'git-repo-stat';
        item.textContent = value;
        item.title = title;
        this.repoMetaElement.append(item);
      }
    }
    this.associationMode.textContent = bound ? 'Manual' : '';
    this.associationNote.textContent = 'Select a repository to view changes and pull requests.';
    this.associationNote.hidden = false;
    this.repositoryPicker.hidden = bound;
    this.unbindRepositoryButton.hidden = !bound;
    this.changesSection.hidden = !bound;
    if (bound) this.cancelRecommendations();
    this.renderPullRequest(snapshot.pr);
    this.prCard.hidden = !bound || !repository;
    this.restoreTreeCollapse();
    if (this.pendingSelectedDiff && repository && this.pendingSelectedDiff.repository === repository.path) {
      this.selectedChange = this.pendingSelectedDiff;
      this.selectedChangeKey = changeKey(this.pendingSelectedDiff.path, this.pendingSelectedDiff.kind);
    }
    this.renderChanges(Array.isArray(snapshot.changes) ? snapshot.changes : []);
    this.onSnapshot?.(this.session, snapshot);
  }

  renderPullRequest(pr = {}) {
    const signature = JSON.stringify(pr);
    if (signature === this.prSignature) return;
    this.prSignature = signature;
    const focusedLink = this.prCard.contains(document.activeElement) ? document.activeElement.getAttribute('href') : null;
    this.prCard.replaceChildren();
    this.prCard.hidden = false;
    const heading = document.createElement('div');
    heading.className = 'git-pr-heading';
    heading.innerHTML = `${PR_ICON}<strong>Pull request</strong>`;
    const detail = document.createElement('div');
    detail.className = 'git-pr-detail';
    if (pr.status === 'ready' && pr.data) {
      const data = pr.data;
      const state = document.createElement('span');
      state.className = 'git-pr-state';
      state.textContent = data.isDraft ? 'Draft' : String(data.state || 'Open').toLowerCase();
      state.dataset.state = data.isDraft ? 'draft' : String(data.state || 'OPEN').toLowerCase();
      heading.append(state);
      const link = safePRURL(data.url);
      const text = `#${data.number} ${data.title || ''}`.trim();
      const label = document.createElement(link ? 'a' : 'div');
      label.className = 'git-pr-title';
      label.textContent = text;
      label.title = text;
      if (link) {
        label.href = link;
        label.target = '_blank';
        label.rel = 'noopener noreferrer';
      }
      detail.append(label);
      const meta = document.createElement('div');
      meta.className = 'git-pr-meta';
      const checks = checkSummary(data.statusCheckRollup);
      const headBranch = data.headRepositoryOwner?.login && data.headRefName ? `${data.headRepositoryOwner.login}:${data.headRefName}` : data.headRefName;
      for (const [text, title] of [
        [data.baseRefName ? `→ ${data.baseRefName}` : '', `${headBranch || ''} → ${data.baseRefName || ''}`],
        [data.reviewDecision ? data.reviewDecision.toLowerCase().replaceAll('_', ' ') : '', 'Review status'],
        [checks, 'Checks'],
      ]) {
        if (!text) continue;
        const item = document.createElement('span');
        item.className = 'git-pr-stat';
        item.textContent = text;
        item.title = title;
        meta.append(item);
      }
      detail.append(meta);
    } else {
      detail.classList.add('git-pr-empty');
      detail.textContent = pr.status === 'none' ? 'No open pull request.'
        : pr.message || (pr.status === 'unavailable' ? 'GitHub CLI is unavailable.' : 'Pull request status is unavailable.');
    }
    this.prCard.append(heading, detail);
    if (focusedLink) [...this.prCard.querySelectorAll('a[href]')].find((link) => link.getAttribute('href') === focusedLink)?.focus({ preventScroll: true });
  }

  restoreTreeCollapse() {
    const scope = `${this.sessionId}:${this.snapshot?.association?.path || ''}`;
    if (scope === this.treeScope) return;
    this.treeScope = scope;
    try {
      const saved = JSON.parse(localStorage.getItem('workbench.gitTreeCollapsed.v1') || '{}');
      this.collapsedFolders = new Set(Array.isArray(saved[scope]) ? saved[scope].filter(path => typeof path === 'string') : []);
    } catch { this.collapsedFolders = new Set(); }
  }

  toggleFolder(path) {
    const aliases = this.treeRows?.find(row => row.path === path)?.aliases || [path];
    if (aliases.some(key => this.collapsedFolders.has(key))) aliases.forEach(key => this.collapsedFolders.delete(key));
    else this.collapsedFolders.add(path);
    try {
      const saved = JSON.parse(localStorage.getItem('workbench.gitTreeCollapsed.v1') || '{}');
      saved[this.treeScope] = [...this.collapsedFolders];
      localStorage.setItem('workbench.gitTreeCollapsed.v1', JSON.stringify(saved));
    } catch { /* usable without storage */ }
    this.changesSignature = null;
    this.renderChanges(this.snapshot?.changes || []);
    this.changesList.querySelector(`[data-git-folder="${CSS.escape(path)}"]`)?.focus({ preventScroll: true });
  }

  handleTreeKeydown(event) {
    const item = event.target.closest('[role="treeitem"]');
    if (!item) return;
    const rows = [...this.changesList.querySelectorAll('[role="treeitem"]')];
    const index = rows.indexOf(item);
    let next;
    if (event.key === 'ArrowDown') next = rows[index + 1];
    else if (event.key === 'ArrowUp') next = rows[index - 1];
    else if (event.key === 'Home') next = rows[0];
    else if (event.key === 'End') next = rows.at(-1);
    else if (event.key === 'ArrowRight' && item.dataset.gitFolder && item.getAttribute('aria-expanded') === 'false') this.toggleFolder(item.dataset.gitFolder);
    else if (event.key === 'ArrowLeft' && item.dataset.gitFolder && item.getAttribute('aria-expanded') === 'true') this.toggleFolder(item.dataset.gitFolder);
    else return;
    event.preventDefault();
    next?.focus({ preventScroll: true });
    next?.scrollIntoView({ block: 'nearest' });
  }

  renderChanges(changes) {
    const words = this.changesFilter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = changes.filter(change => words.every(word => `${change.path} ${change.oldPath || ''}`.toLowerCase().includes(word)));
    const searching = words.length > 0;
    this.changeCount.textContent = searching ? `${matches.length} / ${changes.length}` : String(changes.length);
    const signature = JSON.stringify({ repository: this.snapshot?.repository?.path, changes, filter: this.changesFilter.value, collapsed: [...this.collapsedFolders] });
    this.updateTreeSelection();
    if (signature === this.changesSignature) return;
    this.changesSignature = signature;
    const focused = document.activeElement;
    const focusKey = this.changesList.contains(focused) ? focused.dataset?.changeKey : null;
    const scrollTop = this.changesList.scrollTop;
    this.changesList.replaceChildren();
    if (!this.snapshot?.repository || !changes.length || !matches.length) {
      this.changesList.append(this.message(!this.snapshot?.repository ? 'Choose a repository to see its changes.' : !changes.length ? 'Working tree is clean.' : 'No changed files match this filter.'));
      return;
    }
    const rows = flattenChangesTree(buildChangesTree(matches), searching ? new Set() : this.collapsedFolders);
    this.treeRows = rows;
    for (const entry of rows) {
      if (entry.type === 'folder') {
        const folder = document.createElement('button');
        folder.type = 'button';
        folder.className = 'git-change-folder';
        folder.dataset.gitFolder = entry.path;
        folder.style.setProperty('--tree-depth', entry.depth);
        folder.setAttribute('role', 'treeitem');
        folder.setAttribute('aria-level', String(entry.depth + 1));
        folder.setAttribute('aria-expanded', String(!entry.collapsed));
        folder.title = entry.path;
        const chevron = makeTreeDisclosure(!entry.collapsed, false, 'git-tree-chevron');
        const icon = makeTreeIcon('folder', 'git-tree-folder-icon');
        const label = document.createElement('span');
        label.textContent = entry.name;
        label.className = 'git-tree-folder-name';
        folder.append(chevron, icon, label);
        this.changesList.append(folder);
        continue;
      }
      const change = entry.change;
      const variants = changeVariants(change);
      const kind = variants.includes('unstaged') ? 'unstaged' : variants[0];
      const row = document.createElement('div');
      row.className = 'git-change-row';
      row.style.setProperty('--tree-depth', entry.depth);
      const makeButton = (variant, secondary = false) => {
        const key = changeKey(change.path, variant);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `git-change-variant${secondary ? ' git-change-index' : ''}${key === this.selectedChangeKey ? ' active' : ''}`;
        button.dataset.changePath = change.path;
        button.dataset.changeKind = variant;
        button.dataset.changeKey = key;
        if (change.oldPath) button.dataset.changeOldPath = change.oldPath;
        button.setAttribute('aria-pressed', String(key === this.selectedChangeKey));
        button.setAttribute('aria-label', `${change.path}, ${variant}`);
        button.title = `${change.path}${change.oldPath ? ` (from ${change.oldPath})` : ''} · ${variant}`;
        if (!secondary) {
          button.setAttribute('role', 'treeitem');
          button.setAttribute('aria-level', String(entry.depth + 1));
          button.setAttribute('aria-selected', String(this.selectedChange?.path === change.path));
          const icon = makeTreeIcon('file', 'git-tree-file-icon');
          const name = document.createElement('span');
          name.className = 'git-change-name';
          name.textContent = entry.name;
          const status = document.createElement('span');
          status.className = 'git-change-status';
          status.textContent = change.untracked ? 'U' : change.status?.trim() || 'M';
          status.dataset.status = status.textContent;
          button.append(makeTreeDisclosure(false, true), icon, name, status);
        } else button.textContent = 'Staged';
        return button;
      };
      row.append(makeButton(kind));
      if (variants.includes('staged') && variants.includes('unstaged')) row.append(makeButton('staged', true));
      this.changesList.append(row);
    }
    this.changesList.scrollTop = scrollTop;
    this.updateTreeSelection();
    if (focusKey) this.changesList.querySelector(`[data-change-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  }

  message(text) {
    const element = document.createElement('div');
    element.className = 'git-empty-state';
    element.textContent = text;
    return element;
  }

  openDiff(path, kind, oldPath, { pinned = false } = {}) {
    if (!this.session || !this.snapshot?.repository || !path) return;
    this.selectedChangeKey = changeKey(path, kind);
    this.selectedChange = { path, kind, oldPath };
    this.renderChanges(this.snapshot.changes || []);
    this.onOpenDiff?.(this.session, { repository: this.snapshot.repository.path, path, kind, oldPath, name: pathLabel(path).split('/').at(-1) }, { pinned });
  }

  updateTreeSelection() {
    for (const button of this.changesList.querySelectorAll('[data-change-path][data-change-kind]')) {
      const selected = changeKey(button.dataset.changePath, button.dataset.changeKind) === this.selectedChangeKey;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
      if (button.getAttribute('role') === 'treeitem') button.setAttribute('aria-selected', String(button.dataset.changePath === this.selectedChange?.path));
    }
  }

  setSelectedDiff(diff) {
    this.pendingSelectedDiff = diff || null;
    this.selectedChange = diff || null;
    this.selectedChangeKey = diff ? changeKey(diff.path, diff.kind) : null;
    this.renderChanges(this.snapshot?.changes || []);
  }

  scheduleRecommendations(query) {
    this.cancelRecommendations();
    if (!this.canSearchRepositories()) return;
    this.recommendationTimer = window.setTimeout(() => void this.loadRecommendations(query), 180);
  }

  canSearchRepositories() {
    return Boolean(this.session && this.snapshot?.association && !this.snapshot.association.path
      && !this.associationWriteInFlight && this.visible && this.isPanelVisible() && !this.destroyed);
  }

  cancelRecommendations() {
    window.clearTimeout(this.recommendationTimer);
    this.recommendationSequence += 1;
    this.recommendationController?.abort();
    this.recommendationItems = [];
    this.recommendations.replaceChildren();
    this.recommendations.hidden = true;
    this.searchInput.setAttribute('aria-expanded', 'false');
  }

  async loadRecommendations(query) {
    if (!this.canSearchRepositories()) return;
    const generation = this.generation;
    const sequence = ++this.recommendationSequence;
    this.recommendationController?.abort();
    const controller = new AbortController();
    this.recommendationController = controller;
    try {
      const response = await fetch(apiURL('/api/git/recommendations', { session: this.session.id, q: query }), {
        headers: { Accept: 'application/json' }, signal: controller.signal,
      });
      const body = await readJSON(response);
      if (generation !== this.generation || sequence !== this.recommendationSequence || controller.signal.aborted || !this.canSearchRepositories()) return;
      this.updateSearchScope(body.root, body.truncated);
      this.renderRecommendations(Array.isArray(body.repositories) ? body.repositories : []);
    } catch (error) {
      if (error.name !== 'AbortError' && generation === this.generation && sequence === this.recommendationSequence) {
        this.renderRecommendations([], error.message || 'Could not search repositories.');
      }
    } finally {
      if (this.recommendationController === controller) this.recommendationController = null;
    }
  }

  renderRecommendations(repositories, error = '') {
    this.recommendationItems = repositories;
    this.recommendations.replaceChildren();
    this.searchInput.setAttribute('aria-expanded', String(Boolean(repositories.length || error)));
    this.recommendations.hidden = !repositories.length && !error;
    if (error) {
      this.recommendations.append(this.message(error));
      return;
    }
    if (!repositories.length) {
      this.recommendations.append(this.message('No matching repositories in the session directory or its subfolders.'));
      this.recommendations.hidden = false;
      return;
    }
    for (const repository of repositories) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'git-recommendation';
      button.setAttribute('role', 'option');
      button.dataset.repositoryPath = repository.path;
      button.disabled = !this.snapshot?.association?.revision;
      const name = document.createElement('strong');
      name.textContent = pathLabel(repository.path).split('/').filter(Boolean).at(-1) || repository.path;
      const path = document.createElement('span');
      path.className = 'git-recommendation-path';
      path.textContent = repository.path;
      button.append(name, path);
      const sourceLabel = repository.source === 'cwd' ? 'Current directory'
        : repository.source === 'descendant' ? 'Subfolder' : 'Repository';
      button.title = `${repository.path} · ${sourceLabel}`;
      const source = document.createElement('small');
      source.textContent = sourceLabel;
      button.append(source);
      button.addEventListener('click', () => void this.saveAssociation(repository.path));
      this.recommendations.append(button);
    }
    this.recommendations.hidden = false;
  }

  updateRecommendationsEnabled() {
    const ready = Boolean(this.snapshot?.association?.revision && !this.associationWriteInFlight);
    for (const button of this.recommendations.querySelectorAll('.git-recommendation')) button.disabled = !ready;
  }

  updateSearchScope(root = this.session?.path, truncated = false) {
    this.searchScope.textContent = root
      ? `Searches this session’s directory and subfolders.${truncated ? ' Showing partial results.' : ''}`
      : 'Open a session to search its repositories.';
    this.searchScope.title = root || '';
  }

  async saveAssociation(path) {
    if (!this.session || !this.snapshot?.association || this.associationWriteInFlight) return;
    this.associationWriteInFlight = true;
    const generation = this.generation;
    const sessionId = this.session.id;
    const controller = new AbortController();
    this.associationController = controller;
    this.searchInput.disabled = true;
    this.unbindRepositoryButton.disabled = true;
    this.updateRecommendationsEnabled();
    this.cancelRecommendations();
    try {
      const response = await fetch('/api/git/association', {
        method: 'PUT',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: sessionId, path, revision: this.snapshot.association.revision }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (generation !== this.generation || controller.signal.aborted) return;
      if (response.status === 409) {
        if (body.association) {
          if (body.association.path !== this.snapshot.association.path) {
            this.selectedChangeKey = null;
            this.selectedChange = null;
            this.snapshot.repository = null;
            this.snapshot.changes = [];
          }
          this.snapshot.association = body.association;
          this.renderSnapshot();
        }
        await this.refresh({ quiet: true });
        if (generation === this.generation) this.status(body.error || 'Repository association changed elsewhere. Refreshed the current state.', true);
        return;
      }
      if (!response.ok) throw new GitAPIError(body.error || `HTTP ${response.status}`, response.status, body);
      if (body.association) this.snapshot.association = body.association;
      this.snapshot.repository = null;
      this.snapshot.changes = [];
      this.snapshot.repositoryError = null;
      this.selectedChangeKey = null;
      this.selectedChange = null;
      this.searchInput.value = '';
      this.renderSnapshot();
      const refreshed = await this.refresh({ quiet: true });
      if (!refreshed) {
        this.status('Repository association saved, but Git status could not be refreshed.', true);
        return;
      }
      this.status('');
    } catch (error) {
      if (error.name !== 'AbortError' && generation === this.generation) this.status(error.message || 'Could not save repository association.', true);
    } finally {
      if (this.associationController === controller) this.associationController = null;
      if (generation === this.generation) {
        this.associationWriteInFlight = false;
        this.searchInput.disabled = !this.session || !this.snapshot?.association?.revision;
        this.unbindRepositoryButton.disabled = false;
        this.updateRecommendationsEnabled();
        if (!this.snapshot?.association?.path) this.scheduleRecommendations(this.searchInput.value);
      }
    }
  }

  async applyTheme() {}

  setVisible(visible) {
    const becameVisible = !this.visible && Boolean(visible);
    this.visible = Boolean(visible);
    if (this.visible && this.isPanelVisible()) {
      if (becameVisible && this.session) {
        void this.refresh({ quiet: true });
        this.scheduleRecommendations(this.searchInput.value);
      }
    } else {
      this.cancelRecommendations();
    }
  }

  layout() {}

  status(message, error = false) {
    this.statusElement.textContent = message;
    this.statusElement.classList.toggle('is-error', error);
    this.statusElement.hidden = !message;
  }

  abortRequests() {
    this.fetchController?.abort();
    this.recommendationController?.abort();
    this.associationController?.abort();
    window.clearTimeout(this.recommendationTimer);
  }

  destroy() {
    this.destroyed = true;
    this.generation += 1;
    window.clearInterval(this.refreshTimer);
    this.abortRequests();
    this.changesFilter.removeEventListener('input', this.onFilterChanges);
    this.refreshButton.removeEventListener('click', this.onRefreshClick);
    this.searchInput.removeEventListener('input', this.onSearchInput);
    this.unbindRepositoryButton.removeEventListener('click', this.onUnbindRepositoryClick);
    this.changesList.removeEventListener('click', this.onChangesClick);
    this.changesList.removeEventListener('dblclick', this.onChangesDoubleClick);
    this.changesList.removeEventListener('keydown', this.onTreeKeydown);
  }
}

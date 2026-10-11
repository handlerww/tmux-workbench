import { buildChangesTree, checkSummary, flattenChangesTree } from './git-panel-utils.js';
import { safePRURL } from './git-panel.js';
import './pr-panel.css';
import { makeTreeIcon, makeTreeDisclosure } from './file-tree-icons.js';

const REFRESH_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16.4 8a6.7 6.7 0 0 0-11.6-2L3.4 8M3.4 4.5V8h3.5M3.6 12a6.7 6.7 0 0 0 11.6 2l1.4-2M16.6 15.5V12h-3.5"/></svg>';

function requestURL(params) {
  return `/api/git/pr/changes?${new URLSearchParams(params)}`;
}

async function responseJSON(response) {
  let body = {};
  try { body = await response.json(); } catch { /* HTTP status fallback */ }
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function displayPath(path) {
  return String(path || '').replace(/\\/g, '/');
}

export class PRPanel {
  constructor(container, { onOpenDiff, onSnapshot, isVisible = () => true } = {}) {
    this.container = container;
    this.onOpenDiff = onOpenDiff;
    this.onSnapshot = onSnapshot;
    this.isPanelVisible = isVisible;
    this.session = null;
    this.sessionId = null;
    this.snapshot = null;
    this.generation = 0;
    this.sequence = 0;
    this.controller = null;
    this.timer = null;
    this.visible = false;
    this.destroyed = false;
    this.collapsedFolders = new Set();
    this.treeScope = null;
    this.treeRows = [];
    this.signature = null;
    this.selectedKey = null;
    this.pendingSelectedDiff = null;

    this.element = document.createElement('section');
    this.element.className = 'pr-panel';
    this.element.innerHTML = `
      <header class="pr-panel-heading">
        <div><span class="pr-panel-eyebrow">REVIEW</span><strong>Pull Request</strong></div>
        <button class="pr-panel-refresh" type="button" title="Refresh pull request changes" aria-label="Refresh pull request changes">${REFRESH_ICON}</button>
      </header>
      <div class="pr-panel-scroll">
        <div class="pr-panel-status" role="status" aria-live="polite">Choose a session to inspect its pull request.</div>
        <section class="pr-panel-summary" aria-label="Pull request details" hidden></section>
        <section class="pr-panel-files" aria-label="Pull request changed files" hidden>
          <div class="pr-panel-files-heading"><strong>Files changed</strong><span class="pr-panel-count"></span></div>
          <input class="pr-panel-filter" type="search" placeholder="Filter changed files" aria-label="Filter pull request files" autocomplete="off" />
          <div class="pr-panel-tree" role="tree" aria-label="Pull request changed files"></div>
        </section>
      </div>
    `;
    container.replaceChildren(this.element);
    this.statusElement = this.element.querySelector('.pr-panel-status');
    this.summaryElement = this.element.querySelector('.pr-panel-summary');
    this.filesSection = this.element.querySelector('.pr-panel-files');
    this.countElement = this.element.querySelector('.pr-panel-count');
    this.filterInput = this.element.querySelector('.pr-panel-filter');
    this.filterInput.value = '';
    this.tree = this.element.querySelector('.pr-panel-tree');
    this.refreshButton = this.element.querySelector('.pr-panel-refresh');
    this.onRefreshClick = () => void this.refresh();
    this.onFilter = () => this.renderFiles();
    this.onTreeClick = (event) => {
      const folder = event.target.closest('[data-pr-folder]');
      if (folder) { this.toggleFolder(folder.dataset.prFolder); return; }
      const file = event.target.closest('[data-pr-path]');
      if (file) this.openDiff(file.dataset.prPath, file.dataset.prOldPath || undefined);
    };
    this.onTreeDoubleClick = (event) => {
      const file = event.target.closest('[data-pr-path]');
      if (file) this.openDiff(file.dataset.prPath, file.dataset.prOldPath || undefined, { pinned: true });
    };
    this.onTreeKeydown = (event) => this.handleTreeKeydown(event);
    this.refreshButton.addEventListener('click', this.onRefreshClick);
    this.filterInput.addEventListener('input', this.onFilter);
    this.tree.addEventListener('click', this.onTreeClick);
    this.tree.addEventListener('dblclick', this.onTreeDoubleClick);
    this.tree.addEventListener('keydown', this.onTreeKeydown);
    this.timer = window.setInterval(() => {
      if (this.visible && this.isPanelVisible() && !document.hidden && this.session) void this.refresh({ quiet: true });
    }, 15000);
  }

  setSession(session) {
    const nextId = session?.id ?? null;
    if (nextId === this.sessionId && session?.path === this.session?.path) {
      this.session = session ?? null;
      return;
    }
    this.generation += 1;
    this.sequence += 1;
    this.controller?.abort();
    this.controller = null;
    this.session = session ?? null;
    this.sessionId = nextId;
    this.refreshButton.disabled = false;
    this.snapshot = null;
    this.selectedKey = null;
    this.pendingSelectedDiff = null;
    this.filterInput.value = '';
    this.collapsedFolders = new Set();
    this.treeScope = null;
    this.signature = null;
    this.renderSnapshot();
    if (!session) this.status('Choose a session to inspect its pull request.');
    else if (this.visible && this.isPanelVisible()) void this.refresh();
  }

  setVisible(visible) {
    const wasVisible = this.visible;
    this.visible = Boolean(visible);
    if (!this.visible) {
      this.sequence += 1;
      this.controller?.abort();
      this.controller = null;
      this.refreshButton.disabled = false;
    } else if (!wasVisible && this.session && this.isPanelVisible()) {
      void this.refresh();
    }
  }

  setGitStatus(snapshot, session = this.session) {
    if (session?.id && this.sessionId && session.id !== this.sessionId) return;
    const associatedPath = snapshot?.association?.path || null;
    if (!associatedPath) {
      this.generation += 1;
      this.sequence += 1;
      this.controller?.abort();
      this.controller = null;
      this.refreshButton.disabled = false;
      this.snapshot = null;
      this.signature = null;
      this.renderSnapshot();
      this.status('Bind a repository to this session in Git to inspect its pull request.');
      return;
    }
    const currentRepository = snapshot?.repository?.path || null;
    const cachedAssociation = this.snapshot?.association?.path || this.snapshot?.repository || null;
    if ((currentRepository && currentRepository !== associatedPath) || (cachedAssociation && cachedAssociation !== associatedPath)) {
      this.generation += 1;
      this.sequence += 1;
      this.controller?.abort();
      this.controller = null;
      this.refreshButton.disabled = false;
      this.snapshot = null;
      this.signature = null;
      this.renderSnapshot();
      this.status('Repository association changed. Refresh pull request data.');
      if (this.visible && this.isPanelVisible()) void this.refresh();
      return;
    }
    if (!this.snapshot && this.visible && this.isPanelVisible()) void this.refresh();
  }

  setSelectedDiff(diff) {
    const pr = this.snapshot?.pr?.data;
    const matchesCurrentPR = diff?.kind === 'pr'
      && (!this.snapshot || (diff.repository === this.snapshot.repository
        && Number(diff.number) === Number(pr?.number)
        && diff.baseSha === this.snapshot.baseSha
        && diff.headSha === this.snapshot.headSha));
    this.pendingSelectedDiff = matchesCurrentPR ? diff : null;
    this.selectedKey = matchesCurrentPR ? this.fileKey(diff.path, diff.oldPath) : null;
    this.updateSelection();
  }

  async refresh({ quiet = false } = {}) {
    if (!this.session || this.destroyed || !this.visible || !this.isPanelVisible()) return false;
    const generation = this.generation;
    const sequence = ++this.sequence;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.refreshButton.disabled = true;
    if (!quiet || !this.snapshot) this.status('Loading pull request changes…');
    try {
      const response = await fetch(requestURL({ session: this.session.id }), {
        headers: { Accept: 'application/json' }, signal: controller.signal,
      });
      const body = await responseJSON(response);
      if (this.destroyed || generation !== this.generation || sequence !== this.sequence || controller.signal.aborted) return false;
      this.snapshot = body;
      const scope = `${this.sessionId}:${body.repository || ''}:${body.pr?.data?.number || ''}:${body.baseSha || ''}:${body.headSha || ''}`;
      if (scope !== this.treeScope) {
        this.treeScope = scope;
        this.collapsedFolders = new Set();
      }
      this.renderSnapshot();
      this.onSnapshot?.(this.session, body);
      const message = this.statusMessage(body);
      this.status(message, body.status === 'error' || body.status === 'unavailable' || body.pr?.status === 'error' || body.pr?.status === 'unavailable');
      return true;
    } catch (error) {
      if (error.name !== 'AbortError' && generation === this.generation && sequence === this.sequence) {
        this.snapshot = null;
        this.signature = null;
        this.renderSnapshot();
        this.status(error.message || 'Could not load pull request changes.', true);
        this.onSnapshot?.(this.session, null);
        return false;
      }
      return false;
    } finally {
      if (this.controller === controller) this.controller = null;
      if (generation === this.generation && sequence === this.sequence) this.refreshButton.disabled = false;
    }
  }

  statusMessage(snapshot) {
    if (!this.session) return 'Choose a session to inspect its pull request.';
    if (!snapshot) return 'Loading pull request changes…';
    if (!snapshot.association?.path) return 'Bind a repository to this session in Git to inspect its pull request.';
    if (snapshot.status === 'error') return snapshot.message || 'Could not load pull request files.';
    if (snapshot.status === 'unavailable' || snapshot.pr?.status === 'unavailable') return snapshot.message || snapshot.pr?.message || 'Pull request data is unavailable.';
    if (snapshot.status === 'none' || snapshot.pr?.status === 'none') return 'No open pull request found for this repository.';
    if (snapshot.pr?.status !== 'ready' || !snapshot.pr?.data) return snapshot.pr?.message || 'Pull request status is unavailable.';
    if (snapshot.status === 'ready' && !(snapshot.files || []).length) return 'This pull request has no changed files.';
    return '';
  }

  status(text, error = false) {
    this.statusElement.textContent = text || '';
    this.statusElement.classList.toggle('is-error', Boolean(error));
  }

  renderSnapshot() {
    const snapshot = this.snapshot;
    this.summaryElement.replaceChildren();
    this.summaryElement.hidden = true;
    this.filesSection.hidden = true;
    if (!snapshot) {
      this.countElement.textContent = '';
      this.tree.replaceChildren();
      this.signature = null;
      return;
    }
    const pr = snapshot.pr?.data;
    if (snapshot.pr?.status === 'ready' && pr) {
      const title = document.createElement('div');
      title.className = 'pr-panel-title';
      const link = safePRURL(pr.url);
      if (link) {
        const anchor = document.createElement('a');
        anchor.href = link;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.textContent = `#${pr.number} ${pr.title || ''}`.trim();
        title.append(anchor);
      } else title.textContent = `#${pr.number} ${pr.title || ''}`.trim();
      const meta = document.createElement('div');
      meta.className = 'pr-panel-meta';
      const head = pr.headRepositoryOwner?.login && pr.headRefName ? `${pr.headRepositoryOwner.login}:${pr.headRefName}` : pr.headRefName;
      const checks = checkSummary(pr.statusCheckRollup);
      meta.textContent = [pr.state, pr.isDraft ? 'Draft' : '', pr.baseRefName && head ? `${head} → ${pr.baseRefName}` : '', pr.reviewDecision ? `Review: ${pr.reviewDecision.toLowerCase().replaceAll('_', ' ')}` : '', checks ? `Checks: ${checks}` : ''].filter(Boolean).join(' · ');
      const repository = document.createElement('div');
      repository.className = 'pr-panel-repository';
      repository.textContent = snapshot.repository || snapshot.association?.path || '';
      repository.title = repository.textContent;
      this.summaryElement.append(title, meta, repository);
      this.summaryElement.hidden = false;
    }
    this.filesSection.hidden = snapshot.status !== 'ready' || snapshot.pr?.status !== 'ready' || !snapshot.pr?.data;
    const files = Array.isArray(snapshot.files) ? snapshot.files : [];
    if (this.pendingSelectedDiff) {
      const selected = this.pendingSelectedDiff;
      const matches = selected.kind === 'pr' && selected.repository === snapshot.repository
        && Number(selected.number) === Number(snapshot.pr?.data?.number)
        && selected.baseSha === snapshot.baseSha && selected.headSha === snapshot.headSha;
      this.selectedKey = matches ? this.fileKey(selected.path, selected.oldPath) : null;
      this.pendingSelectedDiff = null;
    }
    this.renderFiles();
  }

  fileKey(path, oldPath = '') { return `${oldPath || ''}\n${path || ''}`; }

  renderFiles() {
    const snapshot = this.snapshot;
    const files = Array.isArray(snapshot?.files) ? snapshot.files : [];
    const words = this.filterInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = files.filter(file => words.every(word => `${file.path} ${file.oldPath || ''}`.toLowerCase().includes(word)));
    const searching = words.length > 0;
    this.countElement.textContent = searching ? `${matches.length} / ${files.length}` : String(files.length);
    const signature = JSON.stringify({ repository: snapshot?.repository, number: snapshot?.pr?.data?.number, baseSha: snapshot?.baseSha, headSha: snapshot?.headSha, files, filter: this.filterInput.value, collapsed: [...this.collapsedFolders] });
    if (signature === this.signature) {
      this.updateSelection();
      return;
    }
    this.signature = signature;
    const focused = document.activeElement;
    const focusKey = this.tree.contains(focused) ? focused.dataset?.prKey : null;
    const scrollTop = this.tree.scrollTop;
    this.tree.replaceChildren();
    if (!snapshot?.association?.path) {
      this.tree.append(this.message('Choose a repository association in Git first.'));
      return;
    }
    if (!files.length) {
      this.tree.append(this.message(snapshot.status === 'ready' ? 'This pull request has no changed files.' : 'Pull request files are unavailable.'));
      return;
    }
    if (!matches.length) {
      this.tree.append(this.message('No pull request files match this filter.'));
      return;
    }
    const rows = flattenChangesTree(buildChangesTree(matches), searching ? new Set() : this.collapsedFolders);
    this.treeRows = rows;
    for (const entry of rows) {
      if (entry.type === 'folder') {
        const folder = document.createElement('button');
        folder.type = 'button';
        folder.className = 'pr-tree-folder';
        folder.dataset.prFolder = entry.path;
        folder.style.setProperty('--tree-depth', entry.depth);
        folder.setAttribute('role', 'treeitem');
        folder.setAttribute('aria-level', String(entry.depth + 1));
        folder.setAttribute('aria-expanded', String(!entry.collapsed));
        folder.title = entry.path;
        const chevron = makeTreeDisclosure(!entry.collapsed, false, 'pr-tree-chevron');
        const name = document.createElement('span');
        name.className = 'pr-tree-folder-name';
        name.textContent = entry.name;
        folder.append(chevron, makeTreeIcon('folder', 'pr-tree-folder-icon'), name);
        this.tree.append(folder);
        continue;
      }
      const file = entry.change;
      const key = this.fileKey(file.path, file.oldPath);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `pr-tree-file${key === this.selectedKey ? ' active' : ''}`;
      button.dataset.prPath = file.path;
      button.dataset.prKey = key;
      if (file.oldPath) button.dataset.prOldPath = file.oldPath;
      button.style.setProperty('--tree-depth', entry.depth);
      button.setAttribute('role', 'treeitem');
      button.setAttribute('aria-level', String(entry.depth + 1));
      button.setAttribute('aria-selected', String(key === this.selectedKey));
      button.title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
      const icon = makeTreeIcon('file', 'pr-tree-file-icon');
      const label = document.createElement('span');
      label.className = 'pr-tree-file-name';
      label.textContent = entry.name;
      const status = document.createElement('span');
      status.className = 'pr-tree-file-status';
      status.textContent = file.status || 'M';
      status.dataset.status = status.textContent;
      const stats = document.createElement('small');
      stats.className = 'pr-tree-file-stats';
      stats.textContent = [file.additions ? `+${file.additions}` : '', file.deletions ? `−${file.deletions}` : ''].filter(Boolean).join(' ');
      button.append(makeTreeDisclosure(false, true), icon, label, status, stats);
      this.tree.append(button);
    }
    this.tree.scrollTop = scrollTop;
    if (focusKey) this.tree.querySelector(`[data-pr-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
    this.updateSelection();
  }

  toggleFolder(path) {
    const aliases = this.treeRows.find(row => row.path === path)?.aliases || [path];
    if (aliases.some(key => this.collapsedFolders.has(key))) aliases.forEach(key => this.collapsedFolders.delete(key));
    else this.collapsedFolders.add(path);
    this.signature = null;
    this.renderFiles();
    this.tree.querySelector(`[data-pr-folder="${CSS.escape(path)}"]`)?.focus({ preventScroll: true });
  }

  handleTreeKeydown(event) {
    const item = event.target.closest('[role="treeitem"]');
    if (!item) return;
    const rows = [...this.tree.querySelectorAll('[role="treeitem"]')];
    const index = rows.indexOf(item);
    let next;
    if (event.key === 'ArrowDown') next = rows[index + 1];
    else if (event.key === 'ArrowUp') next = rows[index - 1];
    else if (event.key === 'Home') next = rows[0];
    else if (event.key === 'End') next = rows.at(-1);
    else if (event.key === 'ArrowRight' && item.dataset.prFolder && item.getAttribute('aria-expanded') === 'false') this.toggleFolder(item.dataset.prFolder);
    else if (event.key === 'ArrowLeft' && item.dataset.prFolder && item.getAttribute('aria-expanded') === 'true') this.toggleFolder(item.dataset.prFolder);
    else if ((event.key === 'Enter' || event.key === ' ') && item.dataset.prPath) { event.preventDefault(); this.openDiff(item.dataset.prPath, item.dataset.prOldPath || undefined); return; }
    else return;
    event.preventDefault();
    next?.focus({ preventScroll: true });
    next?.scrollIntoView({ block: 'nearest' });
  }

  openDiff(path, oldPath, { pinned = false } = {}) {
    const snapshot = this.snapshot;
    const pr = snapshot?.pr?.data;
    if (!this.session || !snapshot?.repository || !pr || !snapshot.baseSha || !snapshot.headSha || !path) return;
    this.selectedKey = this.fileKey(path, oldPath);
    this.updateSelection();
    this.onOpenDiff?.(this.session, {
      repository: snapshot.repository,
      path,
      ...(oldPath ? { oldPath } : {}),
      kind: 'pr',
      number: pr.number,
      baseSha: snapshot.baseSha,
      headSha: snapshot.headSha,
      name: displayPath(path).split('/').at(-1),
    }, { pinned });
  }

  updateSelection() {
    for (const button of this.tree?.querySelectorAll('[data-pr-path]') || []) {
      const selected = this.fileKey(button.dataset.prPath, button.dataset.prOldPath) === this.selectedKey;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
    }
  }

  message(text) {
    const element = document.createElement('div');
    element.className = 'pr-panel-empty';
    element.textContent = text;
    return element;
  }

  applyTheme() {}

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation += 1;
    this.sequence += 1;
    this.controller?.abort();
    window.clearInterval(this.timer);
    this.refreshButton.removeEventListener('click', this.onRefreshClick);
    this.filterInput.removeEventListener('input', this.onFilter);
    this.tree.removeEventListener('click', this.onTreeClick);
    this.tree.removeEventListener('dblclick', this.onTreeDoubleClick);
    this.tree.removeEventListener('keydown', this.onTreeKeydown);
    this.element.remove();
  }
}

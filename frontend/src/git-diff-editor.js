import { loadMonaco } from './file-browser.js';
import { changeVariants } from './git-panel-utils.js';
import './git-diff-editor.css';

function endpoint(path, params) {
  return `${path}?${new URLSearchParams(params)}`;
}

async function responseJSON(response) {
  let body = {};
  try { body = await response.json(); } catch { /* report the HTTP status */ }
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function isVariantPresent(snapshot, diff) {
  if (!snapshot?.repository || snapshot.repository.path !== diff.repository) return false;
  return (snapshot.changes || []).some(change => change.path === diff.path
    && (change.oldPath || '') === (diff.oldPath || '')
    && changeVariants(change).includes(diff.kind));
}

function labelFor(diff) {
  if (diff.kind === 'pr') return `PR #${diff.number} · ${diff.name || diff.path}`;
  const kind = ({ staged: 'Staged', unstaged: 'Unstaged', untracked: 'Untracked' })[diff.kind] || diff.kind;
  return `${kind} · ${diff.name || diff.path}`;
}

function isPRFilePresent(snapshot, diff) {
  const pr = snapshot?.pr?.data;
  if (!snapshot || snapshot.status !== 'ready' || snapshot.pr?.status !== 'ready' || !pr) return false;
  if (snapshot.repository !== diff.repository || Number(pr.number) !== Number(diff.number)) return false;
  if (snapshot.baseSha !== diff.baseSha || snapshot.headSha !== diff.headSha) return false;
  return (snapshot.files || []).some(file => file.path === diff.path && (file.oldPath || '') === (diff.oldPath || ''));
}

export class GitDiffEditor {
  constructor(tabId, session, diff, { getTheme = () => 'dark' } = {}) {
    this.tabId = tabId;
    this.session = session;
    this.diff = { ...diff };
    this.getTheme = getTheme;
    this.generation = 0;
    this.sequence = 0;
    this.controller = null;
    this.statusController = null;
    this.timer = null;
    this.visible = false;
    this.destroyed = false;
    this.editor = null;
    this.originalModel = null;
    this.modifiedModel = null;
    this.content = null;
    this.gitStatus = null;
    this.forceSideBySide = null;

    this.element = document.createElement('section');
    this.panel = this.element;
    this.element.className = 'git-diff-tab';
    this.element.innerHTML = `
      <header class="git-diff-tab-toolbar">
        <div class="git-diff-tab-heading">
          <strong class="git-diff-tab-title"></strong>
          <span class="git-diff-tab-path"></span>
        </div>
        <div class="git-diff-tab-actions">
          <button class="git-diff-tab-layout" type="button" aria-pressed="false" title="Switch diff layout">Side by side</button>
          <button class="git-diff-tab-refresh" type="button" title="Refresh diff" aria-label="Refresh diff">Refresh</button>
        </div>
      </header>
      <div class="git-diff-tab-status" role="status" aria-live="polite"></div>
      <div class="git-diff-tab-editor" aria-label="Read-only Git diff"></div>
    `;
    this.title = this.element.querySelector('.git-diff-tab-title');
    this.pathLabel = this.element.querySelector('.git-diff-tab-path');
    this.status = this.element.querySelector('.git-diff-tab-status');
    this.host = this.element.querySelector('.git-diff-tab-editor');
    this.layoutButton = this.element.querySelector('.git-diff-tab-layout');
    this.refreshButton = this.element.querySelector('.git-diff-tab-refresh');
    this.title.textContent = labelFor(this.diff);
    this.pathLabel.textContent = this.diff.oldPath ? `${this.diff.oldPath} → ${this.diff.path}` : this.diff.path;
    this.onRefresh = () => void this.validateAndRefresh();
    this.onToggleLayout = () => {
      this.forceSideBySide = !this.sideBySide;
      this.layoutButton.setAttribute('aria-pressed', String(this.forceSideBySide));
      this.layoutButton.textContent = this.forceSideBySide ? 'Inline' : 'Side by side';
      this.layout();
    };
    this.refreshButton.addEventListener('click', this.onRefresh);
    this.layoutButton.addEventListener('click', this.onToggleLayout);
    this.resizeObserver = new ResizeObserver(() => this.layout());
    this.resizeObserver.observe(this.element);
    this.resizeObserver.observe(this.host);
    this.onVisibilityChange = () => {
      if (!document.hidden && this.visible) void this.validateAndRefresh();
    };
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.status.textContent = 'Open this tab to load the current Git diff.';
    this.timer = window.setInterval(() => {
      if (this.visible && !document.hidden && !this.destroyed) void this.validateAndRefresh();
    }, 15000);
  }

  setVisible(visible) {
    const becameVisible = !this.visible && Boolean(visible);
    this.visible = Boolean(visible);
    if (this.visible) {
      requestAnimationFrame(() => this.layout());
      if (becameVisible) void this.validateAndRefresh();
    } else {
      this.sequence += 1;
      this.controller?.abort();
      this.statusController?.abort();
    }
  }

  resume() {
    if (this.destroyed || !this.visible || document.hidden) return;
    this.layout();
    void this.validateAndRefresh();
  }

  applyTheme() {
    if (!this.editor) return;
    void loadMonaco().then(monaco => {
      if (!this.destroyed) monaco.editor.setTheme(this.getTheme?.() === 'dark' ? 'workbench-dark' : 'workbench-light');
    }).catch(() => {});
  }

  layout() {
    if (!this.editor || !this.host.clientWidth || !this.host.clientHeight) return;
    const sideBySide = this.forceSideBySide ?? this.host.clientWidth >= 1050;
    if (sideBySide !== this.sideBySide) {
      this.sideBySide = sideBySide;
      this.editor.updateOptions({ renderSideBySide: sideBySide });
    }
    this.layoutButton.hidden = this.host.clientWidth < 520;
    this.layoutButton.textContent = this.sideBySide ? 'Inline' : 'Side by side';
    this.layoutButton.setAttribute('aria-pressed', String(this.sideBySide));
    this.editor.layout({ width: this.host.clientWidth, height: this.host.clientHeight });
  }

  async setGitStatus(snapshot) {
    if (this.diff.kind === 'pr') return;
    this.statusController?.abort();
    this.gitStatus = snapshot || null;
    if (!snapshot || !isVariantPresent(snapshot, this.diff)) {
      this.invalidateDiff();
      this.status.textContent = snapshot?.repositoryError
        ? `Repository unavailable: ${snapshot.repositoryError}`
        : snapshot?.repository?.path && snapshot.repository.path !== this.diff.repository
          ? 'This diff belongs to a different repository association.'
          : 'This change is no longer present in the current Git status.';
      return;
    }
    if (this.visible && !document.hidden) await this.refresh();
  }

  async setPRStatus(snapshot) {
    if (this.diff.kind !== 'pr') return;
    this.statusController?.abort();
    this.prStatus = snapshot || null;
    if (!isPRFilePresent(snapshot, this.diff)) {
      this.invalidateDiff();
      if (!snapshot?.association?.path) this.status.textContent = 'Repository is unbound. This PR diff is no longer available.';
      else if (snapshot.repository && snapshot.repository !== this.diff.repository) this.status.textContent = 'This PR diff belongs to a different repository association.';
      else if (snapshot.baseSha !== this.diff.baseSha || snapshot.headSha !== this.diff.headSha || Number(snapshot.pr?.data?.number) !== Number(this.diff.number)) this.status.textContent = 'The pull request changed. Reopen this file to view the current revision.';
      else this.status.textContent = snapshot.message || snapshot.pr?.message || 'This file is no longer part of the current pull request.';
      return;
    }
    if (this.visible && !document.hidden) await this.refresh();
  }

  async validateAndRefresh() {
    if (!this.session || this.destroyed) return;
    if (this.diff.kind === 'pr') return this.validatePRAndRefresh();
    const generation = this.generation;
    this.statusController?.abort();
    const controller = new AbortController();
    this.statusController = controller;
    try {
      const response = await fetch(endpoint('/api/git', { session: this.session.id }), {
        headers: { Accept: 'application/json' }, signal: controller.signal,
      });
      const snapshot = await responseJSON(response);
      if (this.destroyed || generation !== this.generation || controller.signal.aborted) return;
      this.gitStatus = snapshot;
      if (!isVariantPresent(snapshot, this.diff)) {
        this.invalidateDiff();
        this.status.textContent = snapshot.repositoryError
          ? `Repository unavailable: ${snapshot.repositoryError}`
          : snapshot.repository?.path && snapshot.repository.path !== this.diff.repository
            ? 'This diff belongs to a different repository association.'
            : 'This change is no longer present in the current Git status.';
        return;
      }
      await this.refresh();
    } catch (error) {
      if (error.name !== 'AbortError' && generation === this.generation) {
        this.invalidateDiff();
        this.status.textContent = error.message || 'Could not validate the current Git status.';
      }
    } finally {
      if (this.statusController === controller) this.statusController = null;
    }
  }

  async validatePRAndRefresh() {
    if (!this.session || this.destroyed || this.diff.kind !== 'pr') return;
    const generation = this.generation;
    this.statusController?.abort();
    const controller = new AbortController();
    this.statusController = controller;
    try {
      const response = await fetch(endpoint('/api/git/pr/changes', { session: this.session.id }), {
        headers: { Accept: 'application/json' }, signal: controller.signal,
      });
      const snapshot = await responseJSON(response);
      if (this.destroyed || generation !== this.generation || controller.signal.aborted) return;
      this.prStatus = snapshot;
      if (!isPRFilePresent(snapshot, this.diff)) {
        this.invalidateDiff();
        this.status.textContent = !snapshot.association?.path
          ? 'Repository is unbound. This PR diff is no longer available.'
          : snapshot.repository && snapshot.repository !== this.diff.repository
            ? 'This PR diff belongs to a different repository association.'
            : snapshot.baseSha !== this.diff.baseSha || snapshot.headSha !== this.diff.headSha || Number(snapshot.pr?.data?.number) !== Number(this.diff.number)
              ? 'The pull request changed. Reopen this file to view the current revision.'
              : snapshot.message || snapshot.pr?.message || 'This file is no longer part of the current pull request.';
        return;
      }
      await this.refresh();
    } catch (error) {
      if (error.name !== 'AbortError' && generation === this.generation) {
        this.invalidateDiff();
        this.status.textContent = error.message || 'Could not validate the current pull request.';
      }
    } finally {
      if (this.statusController === controller) this.statusController = null;
    }
  }

  async refresh() {
    if (!this.session || this.destroyed) return;
    const generation = this.generation;
    const sequence = ++this.sequence;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.refreshButton.disabled = true;
    if (!this.content) this.status.textContent = 'Loading diff…';
    const params = this.diff.kind === 'pr' ? {
      session: this.session.id,
      repository: this.diff.repository,
      path: this.diff.path,
      number: String(this.diff.number),
      baseSha: this.diff.baseSha,
      headSha: this.diff.headSha,
    } : {
      session: this.session.id,
      repository: this.diff.repository,
      path: this.diff.path,
      kind: this.diff.kind,
    };
    if (this.diff.oldPath) params.oldPath = this.diff.oldPath;
    try {
      const response = await fetch(endpoint(this.diff.kind === 'pr' ? '/api/git/pr/diff' : '/api/git/diff', params), {
        headers: { Accept: 'application/json' }, signal: controller.signal,
      });
      const body = await responseJSON(response);
      if (this.destroyed || generation !== this.generation || sequence !== this.sequence || controller.signal.aborted) return;
      if (body.repository !== this.diff.repository || body.path !== this.diff.path
        || (this.diff.kind === 'pr' && (Number(body.number) !== Number(this.diff.number) || body.baseSha !== this.diff.baseSha || body.headSha !== this.diff.headSha))) {
        throw new Error('The repository or file changed while loading this diff.');
      }
      if (body.binary) {
        this.clearModels();
        this.content = { binary: true };
        this.status.textContent = 'This change is binary and cannot be shown as text.';
        return;
      }
      await this.render(body, generation, sequence);
    } catch (error) {
      if (error.name !== 'AbortError' && generation === this.generation && sequence === this.sequence) {
        this.clearModels();
        this.status.textContent = error.message || 'Could not load this diff.';
      }
    } finally {
      if (this.controller === controller) this.controller = null;
      if (generation === this.generation) this.refreshButton.disabled = false;
    }
  }

  async render(body, generation, sequence) {
    const monaco = await loadMonaco();
    if (this.destroyed || generation !== this.generation || sequence !== this.sequence) return;
    if (!this.editor) {
      this.editor = monaco.editor.createDiffEditor(this.host, {
        automaticLayout: false,
        readOnly: true,
        originalEditable: false,
        renderSideBySide: this.host.clientWidth >= 1050,
        enableSplitViewResizing: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        fontSize: 13,
        lineNumbersMinChars: 3,
        renderOverviewRuler: true,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        theme: this.getTheme?.() === 'dark' ? 'workbench-dark' : 'workbench-light',
      });
      this.sideBySide = this.host.clientWidth >= 1050;
    }
    const original = String(body.original ?? '');
    const modified = String(body.modified ?? '');
    const language = typeof body.language === 'string' ? body.language : 'plaintext';
    if (this.content && this.content.original === original && this.content.modified === modified && this.content.language === language) {
      this.status.textContent = body.truncated ? 'The diff is truncated because the file is large.' : '';
      this.layout();
      return;
    }
    const modifiedEditor = this.editor.getModifiedEditor();
    const scrollTop = modifiedEditor.getScrollTop();
    const selection = modifiedEditor.getSelection();
    this.clearModels();
    this.originalModel = monaco.editor.createModel(original, language);
    this.modifiedModel = monaco.editor.createModel(modified, language);
    this.editor.setModel({ original: this.originalModel, modified: this.modifiedModel });
    this.content = { original, modified, language, truncated: Boolean(body.truncated), binary: false };
    this.status.textContent = body.truncated ? 'The diff is truncated because the file is large.' : '';
    requestAnimationFrame(() => {
      if (this.destroyed || generation !== this.generation || sequence !== this.sequence) return;
      this.layout();
      const currentEditor = this.editor?.getModifiedEditor();
      currentEditor?.setScrollTop(scrollTop);
      if (selection) currentEditor?.setSelection(selection);
    });
  }

  clearModels() {
    if (this.editor) this.editor.setModel(null);
    this.originalModel?.dispose();
    this.modifiedModel?.dispose();
    this.originalModel = null;
    this.modifiedModel = null;
    this.content = null;
  }

  invalidateDiff() {
    this.generation += 1;
    this.sequence += 1;
    this.controller?.abort();
    this.statusController?.abort();
    this.clearModels();
    this.refreshButton.disabled = false;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation += 1;
    this.sequence += 1;
    this.controller?.abort();
    this.statusController?.abort();
    window.clearInterval(this.timer);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.refreshButton.removeEventListener('click', this.onRefresh);
    this.layoutButton.removeEventListener('click', this.onToggleLayout);
    this.resizeObserver.disconnect();
    this.clearModels();
    this.editor?.dispose();
    this.editor = null;
    this.element.remove();
  }
}

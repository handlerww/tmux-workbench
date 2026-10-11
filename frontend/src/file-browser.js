import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import JSONWorker from 'monaco-editor/language/json/json.worker.js?worker';
import CSSWorker from 'monaco-editor/language/css/css.worker.js?worker';
import HTMLWorker from 'monaco-editor/language/html/html.worker.js?worker';
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import { fileLanguage, fileSavePayload, formatFileSize, hasUnsavedChanges, imageMimeType, isImageFile, isSupportedImageMime } from './file-browser-utils.js';
import { isDirectoryDropItem, isExternalFileDrag, uploadTargetForRow } from './file-upload-utils.js';
import './file-browser.css';
import { makeTreeIcon, makeTreeDisclosure } from './file-tree-icons.js';

const NEW_FILE_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 2.8h6l4 4v4M10 2.8v4h4M4 2.8v14.4h6M14.5 12v6M11.5 15h6"/></svg>';
const NEW_FOLDER_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 5.5h5l1.7 1.8h8.3V11M2.5 5.5v10h7M2.5 7.3h15M14.5 12v6M11.5 15h6"/></svg>';
const REFRESH_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16.4 8a6.7 6.7 0 0 0-11.6-2L3.4 8M3.4 4.5V8h3.5M3.6 12a6.7 6.7 0 0 0 11.6 2l1.4-2M16.6 15.5V12h-3.5"/></svg>';
const OPEN_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11 3h6v6M17 3l-8 8"/><path d="M15 11v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>';

function apiURL(endpoint, session, path) {
  const query = new URLSearchParams({ session: session.id, path });
  return `${endpoint}?${query}`;
}

async function readJSON(response) {
  let body = {};
  try { body = await response.json(); } catch { /* show the status below */ }
  if (!response.ok) {
    const detail = typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return body;
}

function errorText(error) {
  const message = error?.message || 'Could not load this path';
  if (/hidden/i.test(message)) return 'Hidden files are not shown';
  if (/special|symlink/i.test(message)) return 'Special files cannot be opened';
  if (/binary|utf-?8/i.test(message)) return 'This file is binary or is not valid UTF-8';
  if (/large|size|limit|too big/i.test(message)) return 'This file exceeds the preview size limit';
  return message;
}

export class FileBrowser {
  constructor(container, { onOpen, onToast, onReveal, getTheme }) {
    this.container = container;
    this.onOpen = onOpen;
    this.onToast = onToast;
    this.onReveal = onReveal;
    this.getTheme = getTheme;
    this.session = null;
    this.generation = 0;
    this.controllers = new Map();
    this.pendingDirectoryLoads = new Set();
    this.fileOpenController = null;
    this.fileOpenSequence = 0;
    this.loaded = new Map();
    this.expanded = new Set();
    this.selectedPath = null;
    this.destroyed = false;
    this.uploadTargetPath = '.';
    this.uploadSequence = 0;
    this.uploadXHR = null;
    this.uploading = false;
    this.dropTargetRow = null;
    this.externalDragActive = false;
    this.dragHoverRow = null;
    this.dragExpandTimer = null;
    this.dragSequence = 0;
    this.preDragUploadTarget = null;
    this.autoScrollTimer = null;
    this.pendingCreate = null;
    this.createController = null;
    this.pathMenuReturnFocus = null;
    this.pathMenuRestoreFocus = false;

    this.element = document.createElement('section');
    this.element.className = 'file-browser';
    this.element.innerHTML = `
      <header class="file-browser-header">
        <strong class="file-browser-title">Files</strong>
        <div class="file-browser-actions">
          <button class="file-browser-new-file file-browser-action" type="button" title="New file" aria-label="New file" disabled>${NEW_FILE_ICON}</button>
          <button class="file-browser-new-folder file-browser-action" type="button" title="New folder" aria-label="New folder" disabled>${NEW_FOLDER_ICON}</button>
          <button class="file-browser-refresh file-browser-action" type="button" title="Refresh files" aria-label="Refresh files">${REFRESH_ICON}</button>
        </div>
      </header>
      <div class="file-upload-status" role="status" aria-live="polite" hidden></div>
      <div class="file-browser-tree" role="tree" aria-label="Session files"></div>
      <div class="file-browser-drop-overlay" aria-hidden="true" hidden><span></span></div>
      <div class="file-path-menu" role="menu" aria-label="File path actions" hidden>
        <div class="file-path-menu-value" role="group" aria-label="Full absolute path"></div>
        <button class="file-path-menu-copy" type="button" role="menuitem">Copy full path</button>
      </div>
    `;
    this.tree = this.element.querySelector('.file-browser-tree');
    this.newFileButton = this.element.querySelector('.file-browser-new-file');
    this.newFolderButton = this.element.querySelector('.file-browser-new-folder');
    this.uploadStatus = this.element.querySelector('.file-upload-status');
    this.dropOverlay = this.element.querySelector('.file-browser-drop-overlay');
    this.dropOverlayText = this.dropOverlay.querySelector('span');
    this.pathMenu = this.element.querySelector('.file-path-menu');
    this.pathMenuValue = this.element.querySelector('.file-path-menu-value');
    this.pathMenuCopy = this.element.querySelector('.file-path-menu-copy');
    this.dropZone = this.container.closest('#files-sidebar') || this.element;
    this.container.replaceChildren(this.element);
    this.onRefreshClick = () => this.refresh();
    this.onTreeClick = (event) => this.handleClick(event);
    this.onTreeDoubleClick = (event) => this.handleDoubleClick(event);
    this.onTreeContextMenu = event => this.handleContextMenu(event);
    this.element.querySelector('.file-browser-refresh').addEventListener('click', this.onRefreshClick);
    this.tree.addEventListener('click', this.onTreeClick);
    this.tree.addEventListener('dblclick', this.onTreeDoubleClick);
    this.tree.addEventListener('contextmenu', this.onTreeContextMenu);
    this.onTreeKeydown = (event) => this.handleKeydown(event);
    this.tree.addEventListener('keydown', this.onTreeKeydown);
    this.onPathMenuCopy = () => void this.copyContextPath();
    this.pathMenuCopy.addEventListener('click', this.onPathMenuCopy);
    this.onNewFile = () => this.beginCreate('file');
    this.onNewFolder = () => this.beginCreate('directory');
    this.newFileButton.addEventListener('click', this.onNewFile);
    this.newFolderButton.addEventListener('click', this.onNewFolder);
    this.onDragEnter = event => this.handleDragEnter(event);
    this.onDragOver = event => this.handleDragOver(event);
    this.onDragLeave = event => this.handleDragLeave(event);
    this.onDrop = event => this.handleDrop(event);
    this.onDragEnd = () => this.clearDropTarget();
    this.onEscapeUpload = event => {
      if (event.key !== 'Escape') return;
      if (!this.pathMenu.hidden) this.closePathMenu(true);
      if (!this.dropOverlay.hidden) this.clearDropTarget();
    };
    this.onDocumentPointerDown = event => { if (!this.pathMenu.hidden && !this.pathMenu.contains(event.target)) this.closePathMenu(false); };
    this.onDocumentScroll = () => { if (!this.pathMenu.hidden) this.closePathMenu(false); };
    this.dropZone.addEventListener('dragenter', this.onDragEnter);
    this.dropZone.addEventListener('dragover', this.onDragOver);
    this.dropZone.addEventListener('dragleave', this.onDragLeave);
    this.dropZone.addEventListener('drop', this.onDrop);
    this.dropZone.addEventListener('dragend', this.onDragEnd);
    document.addEventListener('keydown', this.onEscapeUpload);
    document.addEventListener('pointerdown', this.onDocumentPointerDown);
    document.addEventListener('scroll', this.onDocumentScroll, true);
  }

  setSession(session) {
    const nextId = session?.id ?? null;
    const currentId = this.session?.id ?? null;
    if (nextId === currentId && session?.path === this.session?.path) return;
    this.cancelCreate();
    this.abortRequests();
    this.cancelUploads();
    this.clearDropTarget();
    this.closePathMenu(false);
    this.fileOpenSequence += 1;
    this.fileOpenController?.abort();
    this.fileOpenController = null;
    this.generation += 1;
    this.session = session ?? null;
    this.updateCreateActions();
    this.loaded.clear();
    this.expanded.clear();
    this.pendingDirectoryLoads.clear();
    this.selectedPath = null;
    this.uploadTargetPath = '.';
    this.setUploadStatus('');
    this.render();
    if (this.session) void this.loadDirectory('.');
  }

  async refresh() {
    if (!this.session) return;
    this.cancelCreate();
    const cancelledUpload = this.uploading;
    if (cancelledUpload) {
      this.cancelUploads();
      this.setUploadStatus('Upload cancelled because the file list was refreshed.', true);
    }
    this.clearDropTarget();
    this.closePathMenu(false);
    this.abortRequests();
    this.generation += 1;
    this.loaded.clear();
    this.render();
    await this.loadDirectory('.');
  }

  async loadDirectory(path, generation = this.generation) {
    if (!this.session || this.destroyed) return;
    const previous = this.controllers.get(path);
    previous?.abort();
    const controller = new AbortController();
    this.controllers.set(path, controller);
    this.pendingDirectoryLoads.delete(path);
    this.loaded.set(path, { state: 'loading', entries: [] });
    this.render();
    try {
      const response = await fetch(apiURL('/api/files', this.session, path), {
        headers: { Accept: 'application/json' }, signal: controller.signal,
      });
      const body = await readJSON(response);
      if (generation !== this.generation || controller.signal.aborted) return;
      this.loaded.set(path, { state: 'loaded', entries: Array.isArray(body.entries) ? body.entries : [], truncated: body.truncated });
    } catch (error) {
      if (generation !== this.generation || error.name === 'AbortError') return;
      this.loaded.set(path, { state: 'error', error: errorText(error), entries: [] });
    } finally {
      if (this.controllers.get(path) === controller) this.controllers.delete(path);
      if (generation === this.generation) this.render();
    }
  }

  render() {
    this.updateCreateActions();
    if (!this.session) {
      this.tree.innerHTML = '<div class="file-tree-state">Select a tmux session to see its files.</div>';
      return;
    }
    const root = this.loaded.get('.');
    if (!root) {
      this.tree.innerHTML = '<div class="file-tree-state"><span class="file-spinner"></span>Loading files…</div>';
      return;
    }
    if (root.state === 'loading') {
      this.tree.innerHTML = '<div class="file-tree-state"><span class="file-spinner"></span>Loading files…</div>';
      return;
    }
    if (root.state === 'error') {
      this.tree.replaceChildren(this.stateMessage(root.error, true));
      return;
    }
    const focusDraft = this.tree.contains(document.activeElement) && document.activeElement.classList.contains('file-create-input');
    const selection = focusDraft ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    this.createRendering = true;
    this.tree.replaceChildren();
    if (this.pendingCreate) this.appendCreateDraft(this.tree);
    this.createRendering = false;
    if (focusDraft) {
      const input = this.tree.querySelector('.file-create-input');
      input?.focus({ preventScroll: true });
      if (input && selection) input.setSelectionRange(...selection);
    }
    if (!root.entries.length) {
      if (!this.pendingCreate) this.tree.append(this.stateMessage('This folder is empty'));
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const entry of root.entries) this.appendEntry(fragment, entry, 0);
    this.tree.append(fragment);
    // Directory expansion/loading rebuilds rows while a native file drag continues.
    if (this.externalDragActive && this.dragHoverRow?.dataset.path) {
      const path = this.dragHoverRow.dataset.path;
      const liveRow = [...this.tree.querySelectorAll('.file-tree-row')].find((row) => row.dataset.path === path);
      if (liveRow) {
        this.dragHoverRow = liveRow;
        this.dropTargetRow = liveRow;
        liveRow.classList.add('upload-drop-target');
      }
    }
    if (root.truncated) this.tree.append(this.stateMessage('Some files are hidden because this folder has many entries'));
  }

  updateCreateActions() {
    const disabled = !this.session || this.loaded.get('.')?.state !== 'loaded' || Boolean(this.pendingCreate?.busy);
    this.newFileButton.disabled = disabled;
    this.newFolderButton.disabled = disabled;
  }

  beginCreate(kind) {
    if (!this.session || this.destroyed || this.pendingCreate?.busy) return;
    this.closePathMenu(false);
    this.clearDropTarget();
    this.pendingCreate = { kind, name: '', error: '', busy: false };
    this.updateCreateActions();
    this.render();
    const input = this.tree.querySelector('.file-create-input');
    input?.scrollIntoView({ block: 'nearest' });
    input?.focus();
  }

  cancelCreate({ restoreFocus = false } = {}) {
    const kind = this.pendingCreate?.kind;
    this.createController?.abort();
    this.createController = null;
    this.pendingCreate = null;
    this.updateCreateActions();
    this.tree.querySelector('.file-create-draft')?.remove();
    if (restoreFocus && kind) (kind === 'file' ? this.newFileButton : this.newFolderButton).focus({ preventScroll: true });
  }

  appendCreateDraft(parent) {
    const draft = this.pendingCreate;
    if (!draft) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'file-create-draft';
    const row = document.createElement('form');
    row.className = 'file-create-row';
    row.setAttribute('aria-label', draft.kind === 'file' ? 'Create file' : 'Create folder');
    const spacer = document.createElement('span');
    spacer.className = 'file-tree-disclosure is-empty';
    row.append(spacer, makeTreeIcon(draft.kind === 'file' ? 'file' : 'folder'));
    const input = document.createElement('input');
    input.className = 'file-create-input';
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = draft.kind === 'file' ? 'File name' : 'Folder name';
    input.setAttribute('aria-label', draft.kind === 'file' ? 'New file name' : 'New folder name');
    input.setAttribute('aria-describedby', 'file-create-feedback');
    input.setAttribute('aria-invalid', String(Boolean(draft.error)));
    input.value = draft.name;
    input.disabled = draft.busy;
    input.addEventListener('input', () => {
      draft.name = input.value;
      draft.error = '';
      input.setAttribute('aria-invalid', 'false');
      feedback.textContent = 'Enter to create · Esc to cancel';
      feedback.classList.remove('is-error');
      feedback.setAttribute('role', 'status');
    });
    input.addEventListener('compositionstart', () => { draft.composing = true; });
    input.addEventListener('compositionend', () => { draft.composing = false; draft.name = input.value; });
    input.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.cancelCreate({ restoreFocus: true });
      } else if (event.key === 'Enter') {
        event.preventDefault();
        void this.submitCreate();
      }
    });
    input.addEventListener('blur', () => {
      if (!draft.busy && this.pendingCreate === draft && !this.createRendering) this.cancelCreate();
    });
    row.addEventListener('submit', event => { event.preventDefault(); void this.submitCreate(); });
    row.append(input);
    const feedback = document.createElement('div');
    feedback.id = 'file-create-feedback';
    feedback.className = `file-create-feedback${draft.error ? ' is-error' : ''}`;
    feedback.setAttribute('role', draft.error ? 'alert' : 'status');
    feedback.textContent = draft.error || (draft.busy ? 'Creating…' : 'Enter to create · Esc to cancel');
    wrapper.append(row, feedback);
    parent.append(wrapper);
  }

  async submitCreate() {
    const draft = this.pendingCreate;
    if (!draft || draft.busy || draft.composing || !this.session) return;
    const name = draft.name.trim();
    if (!name) {
      draft.error = draft.kind === 'file' ? 'Enter a file name.' : 'Enter a folder name.';
      this.render();
      return;
    }
    const session = this.session;
    const generation = this.generation;
    const controller = new AbortController();
    this.createController = controller;
    draft.busy = true;
    draft.error = '';
    this.updateCreateActions();
    this.render();
    try {
      const response = await fetch('/api/file/create', {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: session.id, root: session.path, path: name, kind: draft.kind }),
        signal: controller.signal,
      });
      const created = await readJSON(response);
      if (controller.signal.aborted || this.pendingCreate !== draft || generation !== this.generation || this.session?.id !== session.id) return;
      this.pendingCreate = null;
      const path = created.path;
      const parts = path.split('/');
      parts.pop();
      let parent = '.';
      for (const part of parts) {
        parent = parent === '.' ? part : `${parent}/${part}`;
        this.expanded.add(parent);
      }
      if (draft.kind === 'directory') this.expanded.add(path);
      this.selectedPath = path;
      await this.loadDirectory(parts.length ? parts.join('/') : '.', generation);
      if (controller.signal.aborted || generation !== this.generation || this.session?.id !== session.id) return;
      if (draft.kind === 'file') await this.openFile(path, true);
      else this.tree.querySelector(`[data-path="${CSS.escape(path)}"]`)?.focus({ preventScroll: true });
    } catch (error) {
      if (error.name !== 'AbortError' && this.pendingCreate === draft && generation === this.generation) {
        draft.busy = false;
        draft.error = error.message || 'Could not create this entry.';
        this.render();
        const input = this.tree.querySelector('.file-create-input');
        input?.focus({ preventScroll: true });
        input?.select();
      }
    } finally {
      if (this.createController === controller) this.createController = null;
      this.updateCreateActions();
    }
  }

  appendEntry(parent, entry, depth) {
    const isDirectory = entry.type === 'directory';
    const isExpanded = isDirectory && this.expanded.has(entry.path);
    const row = document.createElement('div');
    row.className = `file-tree-row${isDirectory ? ' is-directory' : ''}${entry.path === this.selectedPath ? ' selected' : ''}`;
    row.dataset.path = entry.path;
    row.dataset.type = entry.type;
    row.dataset.name = entry.name;
    row.dataset.previewType = entry.previewType || '';
    row.dataset.size = Number.isFinite(Number(entry.size)) ? String(entry.size) : '';
    row.setAttribute('role', 'treeitem');
    row.tabIndex = 0;
    row.setAttribute('aria-level', String(depth + 1));
    row.setAttribute('aria-selected', entry.path === this.selectedPath ? 'true' : 'false');
    if (isDirectory) row.setAttribute('aria-expanded', String(isExpanded));
    row.style.setProperty('--tree-depth', depth);

    const disclosure = makeTreeDisclosure(isExpanded, !isDirectory);
    row.append(disclosure, makeTreeIcon(isDirectory ? 'folder' : 'file'));
    const name = document.createElement('span');
    name.className = 'file-tree-name';
    name.textContent = entry.name;
    name.title = entry.name;
    row.append(name);
    if (!isDirectory && Number.isFinite(Number(entry.size))) {
      const size = document.createElement('span');
      size.className = 'file-tree-size';
      size.textContent = formatFileSize(entry.size);
      row.append(size);
      const open = document.createElement('button');
      open.className = 'file-tree-open';
      open.type = 'button';
      open.dataset.openPath = entry.path;
      open.title = 'Open in tab';
      open.setAttribute('aria-label', `Open ${entry.name} in tab`);
      open.innerHTML = OPEN_ICON;
      row.append(open);
    }
    parent.append(row);

    if (!isDirectory || !isExpanded) return;
    const content = this.loaded.get(entry.path);
    if (!content) {
      const loading = this.childState(entry.path, depth + 1, 'Loading…', true);
      parent.append(loading);
      if (!this.pendingDirectoryLoads.has(entry.path)) {
        this.pendingDirectoryLoads.add(entry.path);
        const generation = this.generation;
        queueMicrotask(() => {
          if (generation === this.generation && this.expanded.has(entry.path) && !this.loaded.has(entry.path)) {
            void this.loadDirectory(entry.path, generation);
          } else {
            this.pendingDirectoryLoads.delete(entry.path);
          }
        });
      }
    } else if (content.state === 'loading') {
      parent.append(this.childState(entry.path, depth + 1, 'Loading…', true));
    } else if (content.state === 'error') {
      const error = this.childState(entry.path, depth + 1, content.error, false);
      error.classList.add('is-error');
      parent.append(error);
    } else if (content.entries.length === 0) {
      parent.append(this.childState(entry.path, depth + 1, 'Empty folder', false));
    } else {
      for (const child of content.entries) this.appendEntry(parent, child, depth + 1);
    }
    if (content?.state === 'loaded' && content.truncated) {
      parent.append(this.childState(entry.path, depth + 1, 'Some entries omitted', false));
    }
  }

  childState(path, depth, label, loading) {
    const row = document.createElement('div');
    row.className = 'file-tree-child-state';
    row.dataset.parentPath = path;
    row.style.setProperty('--tree-depth', depth);
    if (loading) row.innerHTML = '<span class="file-spinner"></span>';
    const text = document.createElement('span');
    text.textContent = label;
    row.append(text);
    return row;
  }

  stateMessage(message, retry = false) {
    const state = document.createElement('div');
    state.className = 'file-tree-state';
    const text = document.createElement('span');
    text.textContent = message;
    state.append(text);
    if (retry) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'file-tree-retry';
      button.textContent = 'Retry';
      button.addEventListener('click', () => void this.refresh());
      state.append(button);
    }
    return state;
  }

  handleClick(event) {
    const openButton = event.target.closest('[data-open-path]');
    if (openButton) {
      event.stopPropagation();
      const row = openButton.closest('.file-tree-row');
      void this.openFile(row?.dataset.path, true, row);
      return;
    }
    const row = event.target.closest('.file-tree-row');
    if (!row) return;
    if (row.dataset.type === 'directory') {
      this.uploadTargetPath = row.dataset.path;
      if (this.expanded.has(row.dataset.path)) this.expanded.delete(row.dataset.path);
      else this.expanded.add(row.dataset.path);
      this.render();
      return;
    }
    this.uploadTargetPath = uploadTargetForRow(row.dataset.path, row.dataset.type);
    void this.openFile(row.dataset.path, false, row);
  }

  handleDoubleClick(event) {
    const row = event.target.closest('.file-tree-row[data-type="file"]');
    if (!row || event.target.closest('button')) return;
    this.uploadTargetPath = uploadTargetForRow(row.dataset.path, row.dataset.type);
    void this.openFile(row.dataset.path, true, row);
  }

  handleKeydown(event) {
    const row = event.target.closest('.file-tree-row');
    if (!row || event.target.closest('.file-create-draft')) return;
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      this.openPathMenu(row, rect.left + 12, rect.bottom, true);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (row.dataset.type === 'directory') {
        this.uploadTargetPath = row.dataset.path;
        if (this.expanded.has(row.dataset.path)) this.expanded.delete(row.dataset.path);
        else this.expanded.add(row.dataset.path);
        this.render();
      } else {
        this.uploadTargetPath = uploadTargetForRow(row.dataset.path, row.dataset.type);
        void this.openFile(row.dataset.path, false, row);
      }
    } else if (event.key === 'ArrowRight' && row.dataset.type === 'directory' && !this.expanded.has(row.dataset.path)) {
      event.preventDefault();
      this.expanded.add(row.dataset.path);
      this.uploadTargetPath = row.dataset.path;
      this.render();
    } else if (event.key === 'ArrowLeft' && row.dataset.type === 'directory' && this.expanded.has(row.dataset.path)) {
      event.preventDefault();
      this.expanded.delete(row.dataset.path);
      this.render();
    }
  }

  async openFile(path, pinned, row = null) {
    if (!this.session || !path) return;
    this.selectedPath = path;
    // Preserve the clicked DOM node so the browser can deliver its second click
    // and dblclick event; rebuilding the tree here cancels native double-clicks.
    for (const row of this.tree.querySelectorAll('.file-tree-row')) {
      const selected = row.dataset.path === path;
      row.classList.toggle('selected', selected);
      row.setAttribute('aria-selected', String(selected));
    }
    const session = this.session;
    const generation = this.generation;
    const openSequence = ++this.fileOpenSequence;
    this.fileOpenController?.abort();
    this.fileOpenController = null;
    const candidate = {
      name: row?.dataset.name || path.split('/').pop(),
      path,
      previewType: row?.dataset.previewType || undefined,
      size: row?.dataset.size ? Number(row.dataset.size) : undefined,
    };
    if (isImageFile(candidate)) {
      if (generation === this.generation && openSequence === this.fileOpenSequence && session.id === this.session?.id) {
        this.onOpen?.(session, { ...candidate, previewType: 'image' }, { pinned });
      }
      return;
    }
    const controller = new AbortController();
    this.fileOpenController = controller;
    try {
      const response = await fetch(apiURL('/api/file', session, path), {
        headers: { Accept: 'application/json' }, signal: controller.signal,
      });
      const file = await readJSON(response);
      if (generation !== this.generation || openSequence !== this.fileOpenSequence || controller.signal.aborted || session.id !== this.session?.id) return;
      this.onOpen?.(session, { ...file, language: file.language || fileLanguage(file.name || path) }, { pinned });
    } catch (error) {
      if (error.name !== 'AbortError' && generation === this.generation && openSequence === this.fileOpenSequence) {
        this.onToast?.(errorText(error));
      }
    } finally {
      if (this.fileOpenController === controller) this.fileOpenController = null;
    }
  }

  handleContextMenu(event) {
    const row = event.target.closest('.file-tree-row');
    if (!row) return;
    event.preventDefault();
    this.openPathMenu(row, event.clientX, event.clientY, false);
  }

  fullPathForRow(row) {
    const root = String(this.session?.path || '').replace(/\/+$/, '');
    const relative = String(row?.dataset.path || '').replace(/^\/+/, '');
    if (!relative || relative === '.') return root || '/';
    return `${root}/${relative}` || `/${relative}`;
  }

  openPathMenu(row, clientX, clientY, restoreFocus) {
    if (!this.session || !row) return;
    this.closePathMenu(false);
    this.pathMenuPath = this.fullPathForRow(row);
    this.pathMenuReturnFocus = row;
    this.pathMenuRestoreFocus = Boolean(restoreFocus);
    this.pathMenuValue.textContent = this.pathMenuPath;
    this.pathMenu.hidden = false;
    const bounds = this.element.getBoundingClientRect();
    const menuBounds = this.pathMenu.getBoundingClientRect();
    const x = Number.isFinite(clientX) && clientX > 0 ? clientX : row.getBoundingClientRect().left;
    const y = Number.isFinite(clientY) && clientY > 0 ? clientY : row.getBoundingClientRect().bottom;
    const left = Math.max(8, Math.min(x - bounds.left, bounds.width - menuBounds.width - 8));
    const top = Math.max(8, Math.min(y - bounds.top, bounds.height - menuBounds.height - 8));
    this.pathMenu.style.left = `${left}px`;
    this.pathMenu.style.top = `${top}px`;
    if (this.pathMenuRestoreFocus) this.pathMenuCopy.focus({ preventScroll: true });
  }

  closePathMenu(restoreFocus = false) {
    if (!this.pathMenu || this.pathMenu.hidden) return;
    const target = this.pathMenuReturnFocus;
    const shouldRestore = restoreFocus && this.pathMenuRestoreFocus;
    if (!shouldRestore && this.pathMenu.contains(document.activeElement)) this.pathMenuCopy.blur();
    this.pathMenu.hidden = true;
    this.pathMenuPath = '';
    this.pathMenuReturnFocus = null;
    this.pathMenuRestoreFocus = false;
    if (shouldRestore && target?.isConnected) target.focus({ preventScroll: true });
  }

  async copyContextPath() {
    const path = this.pathMenuPath;
    const generation = this.generation;
    if (!path) return;
    let copied = false;
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(path);
        copied = true;
      }
    } catch { /* use the local fallback below */ }
    if (!copied) {
      const active = document.activeElement;
      const input = document.createElement('textarea');
      input.value = path;
      input.setAttribute('readonly', '');
      input.style.position = 'fixed';
      input.style.opacity = '0';
      this.element.append(input);
      input.select();
      try { copied = document.execCommand('copy'); } catch { copied = false; }
      input.remove();
      if (active?.isConnected && active !== document.body) active.focus({ preventScroll: true });
    }
    if (generation !== this.generation || this.pathMenuPath !== path || this.destroyed) return;
    if (copied) {
      this.closePathMenu(this.pathMenuRestoreFocus);
      this.setUploadStatus(`Copied full path: ${path}`);
      this.onToast?.('Copied full path');
    } else {
      this.setUploadStatus('Could not copy the path. Select and copy it from the menu.', true);
    }
  }

  abortRequests() {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.fileOpenController?.abort();
    this.fileOpenController = null;
  }

  setUploadStatus(message, error = false) {
    this.uploadStatus.textContent = message;
    this.uploadStatus.hidden = !message;
    this.uploadStatus.classList.toggle('is-error', error);
  }

  handleDragEnter(event) {
    if (!isExternalFileDrag(event)) return;
    event.preventDefault();
    this.revealFilesForDrop();
    if (this.uploading || !this.session) return;
    this.showDropTarget(event);
  }

  handleDragOver(event) {
    if (!isExternalFileDrag(event)) return;
    event.preventDefault();
    this.revealFilesForDrop();
    if (this.uploading || !this.session) {
      event.dataTransfer.dropEffect = 'none';
      return;
    }
    event.dataTransfer.dropEffect = 'copy';
    this.showDropTarget(event);
  }

  handleDragLeave(event) {
    if (!isExternalFileDrag(event)) return;
    if (event.relatedTarget && this.dropZone.contains(event.relatedTarget)) return;
    this.clearDropTarget();
  }

  revealFilesForDrop() {
    if (this.externalDragActive) return;
    this.preDragUploadTarget = this.uploadTargetPath;
    this.externalDragActive = true;
    this.dragSequence += 1;
    this.onReveal?.();
  }

  showDropTarget(event) {
    const row = this.element.contains(event.target) ? event.target.closest?.('.file-tree-row') : null;
    const target = row ? uploadTargetForRow(row.dataset.path, row.dataset.type) : '.';
    if (this.dropTargetRow && this.dropTargetRow !== row) this.dropTargetRow.classList.remove('upload-drop-target');
    this.dropTargetRow = row || null;
    this.dropTargetRow?.classList.add('upload-drop-target');
    this.updateDragHover(row);
    this.updateDragAutoScroll(event);
    this.uploadTargetPath = target;
    this.dropOverlay.hidden = false;
    this.dropOverlayText.textContent = `Upload to ${target === '.' ? 'session folder' : target}`;
    this.element.classList.add('upload-drag-over');
  }

  updateDragHover(row) {
    if (row === this.dragHoverRow) return;
    window.clearTimeout(this.dragExpandTimer);
    this.dragExpandTimer = null;
    this.dragHoverRow = row || null;
    if (!row || row.dataset.type !== 'directory' || this.expanded.has(row.dataset.path)) return;
    const sessionId = this.session?.id;
    const sessionRoot = this.session?.path;
    const generation = this.generation;
    const dragSequence = this.dragSequence;
    const path = row.dataset.path;
    this.dragExpandTimer = window.setTimeout(() => {
      if (this.destroyed || !this.externalDragActive || generation !== this.generation || dragSequence !== this.dragSequence
        || sessionId !== this.session?.id || sessionRoot !== this.session?.path || !row.isConnected
        || this.dragHoverRow !== row || this.expanded.has(path)) return;
      this.expanded.add(path);
      this.dropTargetRow?.classList.remove('upload-drop-target');
      this.dropTargetRow = null;
      this.uploadTargetPath = path;
      this.dropOverlayText.textContent = `Upload to ${path}`;
      this.render();
    }, 600);
  }

  updateDragAutoScroll(event) {
    if (!this.tree.contains(event.target)) {
      this.stopDragAutoScroll();
      return;
    }
    const bounds = this.tree.getBoundingClientRect();
    const edge = 36;
    const direction = event.clientY < bounds.top + edge ? -1 : event.clientY > bounds.bottom - edge ? 1 : 0;
    if (!direction) {
      this.stopDragAutoScroll();
      return;
    }
    if (this.autoScrollDirection === direction && this.autoScrollTimer) return;
    this.stopDragAutoScroll();
    this.autoScrollDirection = direction;
    this.autoScrollTimer = window.setInterval(() => {
      if (!this.externalDragActive || !this.tree.isConnected) return this.stopDragAutoScroll();
      this.tree.scrollTop += direction * 12;
    }, 24);
  }

  stopDragAutoScroll() {
    window.clearInterval(this.autoScrollTimer);
    this.autoScrollTimer = null;
    this.autoScrollDirection = 0;
  }

  clearDropTarget() {
    const restoreTarget = this.externalDragActive ? this.preDragUploadTarget : null;
    window.clearTimeout(this.dragExpandTimer);
    this.dragExpandTimer = null;
    this.dragHoverRow = null;
    this.dragSequence += 1;
    this.stopDragAutoScroll();
    this.externalDragActive = false;
    this.preDragUploadTarget = null;
    this.dropTargetRow?.classList.remove('upload-drop-target');
    this.dropTargetRow = null;
    if (this.dropOverlay) this.dropOverlay.hidden = true;
    this.element?.classList.remove('upload-drag-over');
    if (restoreTarget) {
      this.uploadTargetPath = restoreTarget;
    }
  }

  handleDrop(event) {
    if (!isExternalFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    this.revealFilesForDrop();
    if (!this.session) {
      this.clearDropTarget();
      this.setUploadStatus('Select a session before uploading files.', true);
      return;
    }
    const row = this.element.contains(event.target) ? event.target.closest?.('.file-tree-row') : null;
    const target = row ? uploadTargetForRow(row.dataset.path, row.dataset.type) : '.';
    const items = Array.from(event.dataTransfer?.items || []);
    const directories = items.filter(isDirectoryDropItem);
    const directoryNames = new Set(directories.map(item => item.getAsFile?.()?.name || item.webkitGetAsEntry?.()?.name).filter(Boolean));
    const files = Array.from(event.dataTransfer?.files || []).filter(file => !directoryNames.has(file.name));
    this.clearDropTarget();
    if (this.uploading) {
      this.setUploadStatus('An upload is already in progress. Wait for it to finish.', true);
      return;
    }
    this.uploadTargetPath = target;
    if (directories.length && !files.length) {
      this.setUploadStatus(`Folders cannot be uploaded. ${directories.length} folder${directories.length === 1 ? '' : 's'} skipped.`, true);
      return;
    }
    void this.uploadFiles(files, target, directories.length);
  }

  cancelUploads() {
    this.uploadSequence += 1;
    this.uploadXHR?.abort();
    this.uploadXHR = null;
    this.uploading = false;
  }

  async uploadFiles(files, directory, rejectedDirectories = 0) {
    if (!this.session || this.destroyed || this.uploading || !files.length) return;
    const session = this.session;
    const root = session.path;
    const generation = this.generation;
    const sequence = ++this.uploadSequence;
    this.uploading = true;
    let uploaded = 0;
    let failed = 0;
    const failures = [];
    for (let index = 0; index < files.length; index += 1) {
      if (generation !== this.generation || sequence !== this.uploadSequence || session.id !== this.session?.id || root !== this.session?.path) return;
      const file = files[index];
      try {
        const result = await this.uploadOne(file, { session, root, directory, generation, sequence, index, total: files.length });
        if (generation !== this.generation || sequence !== this.uploadSequence) return;
        uploaded += 1;
        this.setUploadStatus(`Uploaded ${uploaded}/${files.length}: ${file.name}`);
        if (result?.path) this.loaded.delete(directory || '.');
      } catch (error) {
        if (generation !== this.generation || sequence !== this.uploadSequence || error.name === 'AbortError') return;
        failed += 1;
        failures.push({ name: file.name, reason: error.message || 'Upload failed' });
        this.setUploadStatus(`${file.name}: ${error.message || 'Upload failed'}`, true);
      }
    }
    if (generation === this.generation && sequence === this.uploadSequence) {
      if (uploaded) await this.loadDirectory(directory || '.', generation);
      if (generation !== this.generation || sequence !== this.uploadSequence) return;
      const failureDetails = failures.slice(0, 3).map(({ name, reason }) => {
        const collision = /already exists|file exists|duplicate|\b409\b/i.test(reason);
        return `${name}: ${collision ? 'already exists' : reason}`;
      }).join('; ');
      const moreFailures = failures.length > 3 ? `; and ${failures.length - 3} more` : '';
      const summary = `${uploaded} uploaded, ${failed} failed${rejectedDirectories ? `, ${rejectedDirectories} folder${rejectedDirectories === 1 ? '' : 's'} skipped` : ''}.${failureDetails ? ` ${failureDetails}${moreFailures}.` : ''}`;
      this.setUploadStatus(summary, failed > 0 || rejectedDirectories > 0);
      this.onToast?.(summary);
    }
    if (sequence === this.uploadSequence) {
      this.uploading = false;
      this.uploadXHR = null;
    }
  }

  uploadOne(file, context) {
    return new Promise((resolve, reject) => {
      const { session, root, directory, generation, sequence, index, total } = context;
      const params = new URLSearchParams({ session: session.id, root, directory: directory || '.', name: file.name });
      const xhr = new XMLHttpRequest();
      this.uploadXHR = xhr;
      xhr.open('POST', `/api/file/upload?${params}`);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.responseType = 'text';
      xhr.upload.onprogress = event => {
        if (generation !== this.generation || sequence !== this.uploadSequence) return;
        const percent = event.lengthComputable ? ` ${Math.round(event.loaded / event.total * 100)}%` : '';
        this.setUploadStatus(`Uploading ${index + 1}/${total}: ${file.name}${percent}`);
      };
      xhr.onload = () => {
        let body = {};
        try { body = JSON.parse(xhr.responseText || '{}'); } catch { /* status fallback below */ }
        if (generation !== this.generation || sequence !== this.uploadSequence) {
          const error = new Error('Upload cancelled');
          error.name = 'AbortError';
          reject(error);
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(body.error || `HTTP ${xhr.status}`));
          return;
        }
        if (body.root && body.root !== root) {
          reject(new Error('The session directory changed during upload.'));
          return;
        }
        resolve(body);
      };
      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.onabort = () => {
        const error = new Error('Upload cancelled');
        error.name = 'AbortError';
        reject(error);
      };
      xhr.send(file);
    });
  }

  destroy() {
    this.destroyed = true;
    this.clearDropTarget();
    this.closePathMenu(false);
    this.cancelCreate();
    this.abortRequests();
    this.cancelUploads();
    this.fileOpenSequence += 1;
    this.element.querySelector('.file-browser-refresh').removeEventListener('click', this.onRefreshClick);
    this.tree.removeEventListener('click', this.onTreeClick);
    this.tree.removeEventListener('dblclick', this.onTreeDoubleClick);
    this.tree.removeEventListener('contextmenu', this.onTreeContextMenu);
    this.tree.removeEventListener('keydown', this.onTreeKeydown);
    this.newFileButton.removeEventListener('click', this.onNewFile);
    this.newFolderButton.removeEventListener('click', this.onNewFolder);
    this.pathMenuCopy.removeEventListener('click', this.onPathMenuCopy);
    this.dropZone.removeEventListener('dragenter', this.onDragEnter);
    this.dropZone.removeEventListener('dragover', this.onDragOver);
    this.dropZone.removeEventListener('dragleave', this.onDragLeave);
    this.dropZone.removeEventListener('drop', this.onDrop);
    this.dropZone.removeEventListener('dragend', this.onDragEnd);
    document.removeEventListener('keydown', this.onEscapeUpload);
    document.removeEventListener('pointerdown', this.onDocumentPointerDown);
    document.removeEventListener('scroll', this.onDocumentScroll, true);
    this.element.remove();
  }
}

let monacoPromise;
export function loadMonaco() {
  if (!monacoPromise) {
    globalThis.MonacoEnvironment = {
      getWorker(_moduleId, label) {
        if (label === 'json') return new JSONWorker();
        if (label === 'css' || label === 'scss' || label === 'less') return new CSSWorker();
        if (label === 'html' || label === 'handlebars' || label === 'razor') return new HTMLWorker();
        if (label === 'typescript' || label === 'javascript') return new TypeScriptWorker();
        return new EditorWorker();
      },
    };
    monacoPromise = Promise.all([
      import('monaco-editor/editor.js'),
      import('monaco-editor/features/register.all.js'),
      import('monaco-editor/languages/definitions/register.all.js'),
      import('monaco-editor/languages/features/register.all.js'),
      import('../node_modules/monaco-editor/min/vs/editor/editor.main.css'),
    ]).then(([monaco]) => {
      monaco.editor.defineTheme('workbench-dark', {
        base: 'vs-dark', inherit: true, rules: [],
        colors: { 'editor.background': '#121214', 'editor.foreground': '#e4e4e7', 'editorLineNumber.foreground': '#71717a', 'editorLineNumber.activeForeground': '#d4d4d8', 'editor.selectionBackground': '#3f3f4690', 'editorCursor.foreground': '#a1a1aa', 'editorGutter.background': '#121214' },
      });
      monaco.editor.defineTheme('workbench-light', {
        base: 'vs', inherit: true, rules: [],
        colors: { 'editor.background': '#ffffff', 'editor.foreground': '#27272a', 'editorLineNumber.foreground': '#a1a1aa', 'editorLineNumber.activeForeground': '#52525b', 'editor.selectionBackground': '#d4d4d8aa', 'editorCursor.foreground': '#71717a', 'editorGutter.background': '#ffffff' },
      });
      return monaco;
    });
  }
  return monacoPromise;
}

export class FileEditor {
  constructor(tabId, session, file, { getTheme, onToast, onDirtyChange }) {
    this.tabId = tabId;
    this.session = session;
    this.file = file;
    this.getTheme = getTheme;
    this.onToast = onToast;
    this.onDirtyChange = onDirtyChange;
    this.visible = false;
    this.destroyed = false;
    this.editor = null;
    this.model = null;
    this.loadGeneration = 0;
    this.loadController = null;
    this.savedContent = typeof file.content === 'string' ? file.content : null;
    this.revision = file.revision ?? null;
    this.isDirty = false;
    this.modelChangeSubscription = null;
    this.syncingModel = false;
    this.saveInFlight = false;
    this.saveConflict = false;

    this.panel = document.createElement('section');
    this.panel.className = 'file-editor-panel';
    this.panel.dataset.tabId = tabId;
    this.panel.hidden = true;
    this.panel.innerHTML = `
      <header class="file-editor-toolbar">
        <div class="file-editor-location"><span class="file-editor-mark">{ }</span><div><strong class="file-editor-name"></strong><span class="file-editor-path"></span></div><span class="file-editor-dirty" hidden>Unsaved</span></div>
        <span class="file-editor-language"></span>
        <div class="file-image-tools" hidden>
          <span class="file-image-info"></span>
          <button type="button" class="file-image-mode active" data-mode="fit" aria-pressed="true">Fit</button>
          <button type="button" class="file-image-mode" data-mode="actual" aria-pressed="false">100%</button>
        </div>
        <button type="button" class="file-editor-save" title="Save (Ctrl/Cmd+S)" aria-label="Save file" disabled>Save</button>
        <button type="button" class="file-editor-refresh" title="Reload file" aria-label="Reload file">${REFRESH_ICON}</button>
      </header>
      <div class="file-editor-message" role="status" hidden><span class="file-editor-message-text"></span><button type="button" class="file-editor-reload" hidden>Reload disk version</button></div>
      <div class="file-editor-status" role="status">Loading file…</div>
      <div class="file-editor-monaco" aria-label="File preview" hidden></div>
      <div class="file-editor-image" aria-label="Image preview" hidden><div class="file-image-stage"><img class="file-image-preview" alt="" draggable="false"></div></div>
    `;
    this.nameElement = this.panel.querySelector('.file-editor-name');
    this.pathElement = this.panel.querySelector('.file-editor-path');
    this.languageElement = this.panel.querySelector('.file-editor-language');
    this.dirtyElement = this.panel.querySelector('.file-editor-dirty');
    this.saveButton = this.panel.querySelector('.file-editor-save');
    this.messageElement = this.panel.querySelector('.file-editor-message');
    this.messageText = this.panel.querySelector('.file-editor-message-text');
    this.reloadDiskButton = this.panel.querySelector('.file-editor-reload');
    this.statusElement = this.panel.querySelector('.file-editor-status');
    this.editorHost = this.panel.querySelector('.file-editor-monaco');
    this.imageHost = this.panel.querySelector('.file-editor-image');
    this.imageStage = this.panel.querySelector('.file-image-stage');
    this.imageElement = this.panel.querySelector('.file-image-preview');
    this.imageTools = this.panel.querySelector('.file-image-tools');
    this.imageInfo = this.panel.querySelector('.file-image-info');
    this.imageObjectURL = null;
    this.nameElement.textContent = file.name || file.path || 'File';
    this.pathElement.textContent = file.path || '';
    this.pathElement.title = file.path || '';
    this.languageElement.textContent = file.language || fileLanguage(file.name || file.path);
    this.refreshButton = this.panel.querySelector('.file-editor-refresh');
    this.onRefreshClick = () => void this.loadFile(true);
    this.onSaveClick = () => void this.saveFile();
    this.onReloadDiskClick = () => void this.loadFile(true);
    this.refreshButton.addEventListener('click', this.onRefreshClick);
    this.saveButton.addEventListener('click', this.onSaveClick);
    this.reloadDiskButton.addEventListener('click', this.onReloadDiskClick);
    this.imageModeButtons = [...this.panel.querySelectorAll('.file-image-mode')];
    this.onImageModeClick = (event) => this.setImageMode(event.currentTarget.dataset.mode);
    for (const button of this.imageModeButtons) button.addEventListener('click', this.onImageModeClick);
    this.resizeObserver = new ResizeObserver(() => this.layout());
    this.resizeObserver.observe(this.panel);
    void this.loadFile(false);
  }

  async loadFile(force) {
    if (force && this.saveInFlight) {
      this.showMessage('A save is still in progress. Wait for it to finish before reloading.');
      return;
    }
    if (force && this.isDirty && !window.confirm(`Discard unsaved changes to ${this.file.name || this.file.path}?`)) return;
    const generation = ++this.loadGeneration;
    this.loadController?.abort();
    const controller = new AbortController();
    this.loadController = controller;
    this.messageElement.hidden = true;
    this.showStatus(force ? 'Reloading file…' : 'Loading file…');
    try {
      if (isImageFile(this.file)) {
        this.saveButton.hidden = true;
        await this.loadImagePreview(generation, controller);
        return;
      }
      this.saveButton.hidden = false;
      this.imageTools.hidden = true;
      this.imageHost.hidden = true;
      let file = this.file;
      if (force || typeof file.content !== 'string') {
        const response = await fetch(apiURL('/api/file', this.session, file.path), {
          headers: { Accept: 'application/json' }, signal: controller.signal,
        });
        file = await readJSON(response);
      }
      if (this.destroyed || generation !== this.loadGeneration || controller.signal.aborted) return;
      this.file = { ...this.file, ...file };
      this.languageElement.textContent = this.file.language || fileLanguage(this.file.name || this.file.path);
      const monaco = await loadMonaco();
      if (this.destroyed || generation !== this.loadGeneration || controller.signal.aborted) return;
      const language = this.file.language || fileLanguage(this.file.name || this.file.path);
      this.savedContent = this.file.content;
      this.revision = this.file.revision ?? null;
      this.syncingModel = true;
      if (this.editor && this.model) {
        this.model.setValue(this.file.content);
        monaco.editor.setModelLanguage(this.model, language);
      } else {
        this.model = monaco.editor.createModel(this.file.content, language);
        this.editor = monaco.editor.create(this.editorHost, {
          model: this.model,
          automaticLayout: false,
          readOnly: false,
          domReadOnly: false,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          fontSize: 13,
          lineNumbersMinChars: 3,
          glyphMargin: false,
          folding: true,
          renderLineHighlight: 'line',
          padding: { top: 12, bottom: 18 },
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
          theme: this.monacoTheme(),
        });
        this.modelChangeSubscription = this.model.onDidChangeContent(() => this.updateDirtyState());
        this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void this.saveFile());
      }
      this.syncingModel = false;
      this.saveConflict = false;
      this.setDirty(false, true);
      this.messageElement.hidden = true;
      this.statusElement.hidden = true;
      this.editorHost.hidden = false;
      this.applyTheme();
      this.layout();
    } catch (error) {
      this.syncingModel = false;
      if (this.destroyed || generation !== this.loadGeneration || controller.signal.aborted || error.name === 'AbortError') return;
      if (this.editor && this.model) {
        this.statusElement.hidden = true;
        this.editorHost.hidden = false;
        this.showMessage(errorText(error));
        this.updateDirtyUI();
      } else {
        this.editorHost.hidden = true;
        this.showStatus(errorText(error), true);
      }
    }
  }

  async loadImagePreview(generation, controller) {
    const response = await fetch(apiURL('/api/file/image', this.session, this.file.path), {
      headers: { Accept: 'image/*, application/json' }, signal: controller.signal,
    });
    if (!response.ok) throw new Error((await readJSON(response)).error || `HTTP ${response.status}`);
    const mime = (response.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
    if (!isSupportedImageMime(mime)) throw new Error('The server returned an unsupported image format');
    const blob = await response.blob();
    if (blob.size > 10 * 1024 * 1024) throw new Error('This image exceeds the 10 MiB preview limit');
    const objectURL = URL.createObjectURL(new Blob([blob], { type: mime }));
    try {
      const probe = new Image();
      probe.src = objectURL;
      await probe.decode();
      if (this.destroyed || generation !== this.loadGeneration || controller.signal.aborted) {
        URL.revokeObjectURL(objectURL);
        return;
      }
      if (this.imageObjectURL) URL.revokeObjectURL(this.imageObjectURL);
      this.imageObjectURL = objectURL;
      this.imageElement.src = objectURL;
      this.imageElement.alt = this.file.name || this.file.path || 'Image preview';
      this.imageStage.classList.remove('natural-size');
      for (const button of this.imageModeButtons) {
        const selected = button.dataset.mode === 'fit';
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', String(selected));
      }
      const displayName = this.file.name || this.file.path || '';
      const format = imageMimeType(displayName) === mime
        ? (displayName.split('.').pop().toUpperCase())
        : mime.replace('image/', '').toUpperCase();
      this.imageInfo.textContent = `${probe.naturalWidth} × ${probe.naturalHeight} · ${format} · ${formatFileSize(blob.size)}`;
      this.languageElement.textContent = 'IMAGE';
      this.imageTools.hidden = false;
      this.saveButton.hidden = true;
      this.editorHost.hidden = true;
      this.imageHost.hidden = false;
      this.statusElement.hidden = true;
      this.setDirty(false, true);
      this.layout();
    } catch (error) {
      if (this.imageObjectURL !== objectURL) URL.revokeObjectURL(objectURL);
      throw error;
    }
  }

  updateDirtyState() {
    if (this.syncingModel || !this.model) return;
    this.setDirty(hasUnsavedChanges(this.model.getValue(), this.savedContent));
    if (!this.saveConflict) this.messageElement.hidden = true;
  }

  setDirty(dirty, forceNotify = false) {
    const next = Boolean(dirty);
    if (this.isDirty === next && !forceNotify) {
      this.updateDirtyUI();
      return;
    }
    this.isDirty = next;
    this.updateDirtyUI();
    this.onDirtyChange?.(this.tabId, this.isDirty);
  }

  updateDirtyUI() {
    if (this.dirtyElement) this.dirtyElement.hidden = !this.isDirty;
    if (this.saveButton) this.saveButton.disabled = !this.isDirty || this.saveInFlight || this.saveConflict;
    if (this.saveButton) this.saveButton.textContent = this.saveInFlight ? 'Saving…' : 'Save';
    if (this.saveButton) this.saveButton.title = this.isDirty ? 'Save changes (Ctrl/Cmd+S)' : 'No unsaved changes';
  }

  showMessage(message, canReload = false) {
    this.messageText.textContent = message;
    this.messageElement.hidden = false;
    this.messageElement.classList.toggle('is-error', true);
    this.reloadDiskButton.hidden = !canReload;
  }

  async saveFile() {
    if (isImageFile(this.file) || !this.model || !this.isDirty || this.saveInFlight || this.saveConflict) return;
    if (!this.revision) {
      this.saveConflict = true;
      this.showMessage('This file has no revision token. Reload the disk version before saving.', true);
      this.updateDirtyUI();
      return;
    }
    const content = this.model.getValue();
    const revision = this.revision;
    this.saveInFlight = true;
    this.updateDirtyUI();
    this.messageElement.hidden = true;
    try {
      const response = await fetch('/api/file', {
        method: 'PUT',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(fileSavePayload(this.session, this.file, content, revision)),
      });
      let result = {};
      try { result = await response.json(); } catch { /* response status is still useful */ }
      if (!response.ok) {
        if (response.status === 409) {
          this.saveConflict = true;
          this.showMessage(result.error || 'File changed on disk. Your edits are preserved; reload to review the latest version.', true);
        } else {
          this.showMessage(result.error || `Could not save file (HTTP ${response.status})`);
        }
        return;
      }
      if (typeof result.revision !== 'string' || !result.revision) {
        this.saveConflict = true;
        this.showMessage('The server saved the file without returning a revision. Reload before making another save.', true);
        return;
      }
      this.revision = result.revision;
      this.savedContent = content;
      this.file = { ...this.file, ...result, content, revision: result.revision };
      this.saveConflict = false;
      this.messageElement.hidden = true;
      this.setDirty(hasUnsavedChanges(this.model.getValue(), this.savedContent));
    } catch (error) {
      this.showMessage(errorText(error));
    } finally {
      this.saveInFlight = false;
      if (!this.destroyed) this.updateDirtyUI();
    }
  }

  setImageMode(mode) {
    const natural = mode === 'actual';
    this.imageStage.classList.toggle('natural-size', natural);
    for (const button of this.imageModeButtons) {
      const selected = button.dataset.mode === mode;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
  }

  getContent() {
    return this.model?.getValue() ?? this.file.content ?? '';
  }

  showStatus(message, error = false) {
    this.editorHost.hidden = true;
    this.imageHost.hidden = true;
    this.imageTools.hidden = true;
    this.statusElement.textContent = message;
    this.statusElement.hidden = false;
    this.statusElement.classList.toggle('is-error', error);
    if (error) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'file-tree-retry';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => void this.loadFile(true), { once: true });
      this.statusElement.replaceChildren(document.createTextNode(message), retry);
    }
  }

  monacoTheme() {
    return this.getTheme?.() === 'dark' ? 'workbench-dark' : 'workbench-light';
  }

  async applyTheme() {
    const monaco = await loadMonaco().catch(() => null);
    if (!monaco || this.destroyed) return;
    monaco.editor.setTheme(this.monacoTheme());
  }

  setVisible(visible) {
    this.visible = Boolean(visible);
    this.panel.hidden = !this.visible;
    if (this.visible) requestAnimationFrame(() => this.layout());
  }

  layout() {
    if (!this.visible || !this.editor || this.destroyed) return;
    this.editor.layout();
  }

  destroy() {
    this.destroyed = true;
    if (this.isDirty) this.setDirty(false);
    this.loadGeneration += 1;
    this.loadController?.abort();
    this.resizeObserver.disconnect();
    this.refreshButton.removeEventListener('click', this.onRefreshClick);
    this.saveButton.removeEventListener('click', this.onSaveClick);
    this.reloadDiskButton.removeEventListener('click', this.onReloadDiskClick);
    for (const button of this.imageModeButtons) button.removeEventListener('click', this.onImageModeClick);
    if (this.imageObjectURL) URL.revokeObjectURL(this.imageObjectURL);
    this.editor?.dispose();
    this.modelChangeSubscription?.dispose();
    this.model?.dispose();
    this.panel.remove();
  }
}
